/**
 * Server-side configuration from environment variables. Values are never
 * logged or returned to clients.
 *
 * - DEMO_OPERATOR_TOKEN (required): shared operator bearer token.
 * - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY: Supabase PostgREST transport.
 * - DATABASE_URL: direct PostgreSQL transport for local development/tests;
 *   when set it takes precedence over the Supabase variables.
 */

export type DatabaseConfig =
  | { kind: 'postgres'; databaseUrl: string }
  | { kind: 'supabase'; url: string; serviceRoleKey: string }

export interface ServerConfig {
  operatorToken: string
  database: DatabaseConfig
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function read(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim()
  return value ? value : null
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const operatorToken = read(env, 'DEMO_OPERATOR_TOKEN')
  if (!operatorToken) throw new ConfigError('DEMO_OPERATOR_TOKEN is not set')

  const databaseUrl = read(env, 'DATABASE_URL')
  if (databaseUrl) return { operatorToken, database: { kind: 'postgres', databaseUrl } }

  const url = read(env, 'SUPABASE_URL')
  const serviceRoleKey = read(env, 'SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceRoleKey) {
    throw new ConfigError('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or DATABASE_URL) must be set')
  }
  return { operatorToken, database: { kind: 'supabase', url, serviceRoleKey } }
}
