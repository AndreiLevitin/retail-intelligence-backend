/**
 * Server-side configuration from environment variables. Values are never
 * logged or returned to clients.
 *
 * - DEMO_OPERATOR_TOKEN (required): shared operator bearer token.
 * - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY: Supabase PostgREST transport.
 * - DATABASE_URL: direct PostgreSQL transport for local development/tests;
 *   when set it takes precedence over the Supabase variables.
 * - CORS_ALLOWED_ORIGINS: comma-separated exact frontend origins
 *   (e.g. http://localhost:5173,https://board.example.com); empty = none.
 */

export type DatabaseConfig =
  | { kind: 'postgres'; databaseUrl: string }
  | { kind: 'supabase'; url: string; serviceRoleKey: string }

export interface ServerConfig {
  operatorToken: string
  allowedOrigins: string[]
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

/** Parses exact origins; rejects paths, wildcards and malformed entries. */
export function parseAllowedOrigins(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter((entry) => entry !== '')
    .map((entry) => {
      let origin: string
      try {
        origin = new URL(entry).origin
      } catch {
        throw new ConfigError(`CORS_ALLOWED_ORIGINS contains an invalid origin: ${entry}`)
      }
      if (origin === 'null' || origin !== entry) {
        throw new ConfigError(`CORS_ALLOWED_ORIGINS entries must be exact origins (scheme://host[:port]): ${entry}`)
      }
      return origin
    })
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const operatorToken = read(env, 'DEMO_OPERATOR_TOKEN')
  if (!operatorToken) throw new ConfigError('DEMO_OPERATOR_TOKEN is not set')
  const allowedOrigins = parseAllowedOrigins(read(env, 'CORS_ALLOWED_ORIGINS'))

  const databaseUrl = read(env, 'DATABASE_URL')
  if (databaseUrl) return { operatorToken, allowedOrigins, database: { kind: 'postgres', databaseUrl } }

  const url = read(env, 'SUPABASE_URL')
  const serviceRoleKey = read(env, 'SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceRoleKey) {
    throw new ConfigError('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or DATABASE_URL) must be set')
  }
  return { operatorToken, allowedOrigins, database: { kind: 'supabase', url, serviceRoleKey } }
}
