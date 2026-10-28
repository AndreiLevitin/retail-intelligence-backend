/**
 * Local disposable PostgreSQL for development and integration tests.
 *
 * Runs a real PostgreSQL server (embedded-postgres binaries), emulates the
 * Supabase API roles (anon, authenticated, service_role with BYPASSRLS and
 * Supabase-like default privileges) and applies supabase/migrations in order.
 * The backend connects through a login role that switches to service_role,
 * so grants are exercised exactly as the Supabase gateway would use them.
 *
 * Never point this at a shared or production database: tests reset and
 * create/drop databases freely.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations')
export const SEED_FILE = path.join(REPO_ROOT, 'supabase', 'seed.sql')

export const ADMIN_USER = 'postgres'
export const ADMIN_PASSWORD = 'postgres'
/** Login role used by the backend; acts as Supabase service_role. */
export const BACKEND_USER = 'upb_backend'
export const BACKEND_PASSWORD = 'upb_backend_local'

export interface LocalCluster {
  port: number
  stop(): Promise<void>
}

export async function startCluster(options: {
  dataDir: string
  port: number
  persistent: boolean
  initialise: boolean
}): Promise<LocalCluster> {
  const server = new EmbeddedPostgres({
    databaseDir: options.dataDir,
    port: options.port,
    user: ADMIN_USER,
    password: ADMIN_PASSWORD,
    persistent: options.persistent,
    // Supabase databases are UTF8; the Windows initdb default would be WIN1252.
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
    // UTC server so ad-hoc psql output matches API times; the API itself
    // formats times explicitly and does not depend on this.
    postgresFlags: ['-c', 'timezone=UTC', '-c', 'max_connections=100', '-c', 'io_method=sync'],
    onLog: () => {},
    onError: () => {},
  })
  if (options.initialise) await server.initialise()
  await server.start()
  return { port: options.port, stop: () => server.stop() }
}

export function adminUrl(port: number, database = 'postgres'): string {
  return `postgres://${ADMIN_USER}:${ADMIN_PASSWORD}@127.0.0.1:${port}/${database}`
}

export function backendUrl(port: number, database: string): string {
  return `postgres://${BACKEND_USER}:${BACKEND_PASSWORD}@127.0.0.1:${port}/${database}`
}

export async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Cluster-wide roles. Idempotent. */
export async function ensureRoles(port: number): Promise<void> {
  await withClient(adminUrl(port), async (client) => {
    await client.query(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then
          create role anon nologin noinherit;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then
          create role authenticated nologin noinherit;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then
          create role service_role nologin noinherit bypassrls;
        end if;
        if not exists (select 1 from pg_roles where rolname = '${BACKEND_USER}') then
          create role ${BACKEND_USER} login password '${BACKEND_PASSWORD}' noinherit;
        end if;
      end
      $$;
      grant service_role to ${BACKEND_USER};
      alter role ${BACKEND_USER} set role = 'service_role';
    `)
  })
}

/**
 * Creates an empty database with Supabase-like privileges: API roles may use
 * schema public and receive default grants on new objects. Migrations must
 * revoke what they do not intend to expose.
 */
export async function createDatabase(port: number, database: string): Promise<void> {
  await withClient(adminUrl(port), (client) => client.query(`create database "${database}" encoding 'UTF8' template template0`))
  await withClient(adminUrl(port, database), (client) =>
    client.query(`
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    `),
  )
}

export async function dropDatabase(port: number, database: string): Promise<void> {
  await withClient(adminUrl(port), (client) =>
    client.query(`drop database if exists "${database}" with (force)`),
  )
}

export async function databaseExists(port: number, database: string): Promise<boolean> {
  return withClient(adminUrl(port), async (client) => {
    const result = await client.query('select 1 from pg_database where datname = $1', [database])
    return result.rowCount === 1
  })
}

/** Applies pending migrations (each in its own transaction), then the seed. */
export async function migrate(port: number, database: string): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort()
  const applied: string[] = []
  await withClient(adminUrl(port, database), async (client) => {
    await client.query(`
      create schema if not exists local_meta;
      revoke all on schema local_meta from public;
      create table if not exists local_meta.applied_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      );
    `)
    const done = new Set(
      (await client.query<{ name: string }>('select name from local_meta.applied_migrations')).rows.map(
        (row) => row.name,
      ),
    )
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into local_meta.applied_migrations (name) values ($1)', [file])
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error })
      }
      applied.push(file)
    }
    await client.query(await readFile(SEED_FILE, 'utf8'))
  })
  return applied
}
