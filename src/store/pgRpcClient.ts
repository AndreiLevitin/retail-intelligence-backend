import pg from 'pg'
import { assertIdentifier, isTransientSqlState, RpcError, type RpcClient } from './rpc.js'

const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'])

/**
 * Direct PostgreSQL transport (local development and integration tests).
 * Connect with a role that acts as service_role so grants are exercised as
 * in Supabase. Each call is one statement in its own implicit transaction.
 */
export class PgRpcClient implements RpcClient {
  private readonly pool: pg.Pool

  constructor(connectionString: string, options: { max?: number } = {}) {
    this.pool = new pg.Pool({
      connectionString,
      max: options.max ?? 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
    })
    // An idle client error must not crash the process; the next call reports it.
    this.pool.on('error', () => {})
  }

  async call(fn: string, args: Record<string, unknown>): Promise<unknown> {
    assertIdentifier(fn)
    const names = Object.keys(args)
    names.forEach(assertIdentifier)
    const placeholders = names.map((name, index) => `${name} => $${index + 1}`).join(', ')
    try {
      const result = await this.pool.query<{ result: unknown }>(
        `select public.${fn}(${placeholders}) as result`,
        names.map((name) => args[name]),
      )
      return result.rows[0]?.result ?? null
    } catch (error) {
      throw toRpcError(error)
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

function toRpcError(error: unknown): RpcError {
  const e = error as { code?: unknown; message?: unknown; detail?: unknown; severity?: unknown }
  const code = typeof e.code === 'string' ? e.code : null
  const message = typeof e.message === 'string' ? e.message : 'Database call failed'
  const isDatabaseError = typeof e.severity === 'string'
  if (isDatabaseError) {
    return new RpcError(message, {
      sqlstate: code,
      detail: typeof e.detail === 'string' ? e.detail : null,
      transient: isTransientSqlState(code),
      cause: error,
    })
  }
  const transient =
    (code !== null && TRANSIENT_NODE_CODES.has(code)) ||
    /Connection terminated|timeout exceeded when trying to connect|connect ECONNREFUSED/i.test(message)
  return new RpcError(message, { transient, cause: error })
}
