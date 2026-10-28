/**
 * Transport for calling the PostgreSQL command functions by name with named
 * arguments. Two implementations exist: Supabase PostgREST (deployment) and
 * node-postgres (local development / integration tests). Both call the same
 * SQL functions, so business behavior is identical; only transport differs.
 */

export interface RpcClient {
  /** Calls public.<fn>(name => value, ...) and returns its JSON result. */
  call(fn: string, args: Record<string, unknown>): Promise<unknown>
  close?(): Promise<void>
}

export class RpcError extends Error {
  /** PostgreSQL SQLSTATE when known (P0001 for business-rule failures). */
  readonly sqlstate: string | null
  /** DETAIL text of the database error, if any. */
  readonly detail: string | null
  /** Connectivity / availability failure that may succeed when retried. */
  readonly transient: boolean

  constructor(
    message: string,
    options: { sqlstate?: string | null; detail?: string | null; transient: boolean; cause?: unknown },
  ) {
    super(message, { cause: options.cause })
    this.name = 'RpcError'
    this.sqlstate = options.sqlstate ?? null
    this.detail = options.detail ?? null
    this.transient = options.transient
  }
}

/** SQLSTATE classes that indicate the database is temporarily unavailable. */
export function isTransientSqlState(sqlstate: string | null | undefined): boolean {
  if (!sqlstate) return false
  return (
    sqlstate.startsWith('08') || // connection exception
    sqlstate === '57P01' || // admin_shutdown
    sqlstate === '57P02' || // crash_shutdown
    sqlstate === '57P03' || // cannot_connect_now
    sqlstate === '53300' || // too_many_connections
    sqlstate === '53400' // configuration_limit_exceeded
  )
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

export function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid SQL identifier: ${name}`)
}
