import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { assertIdentifier, isTransientSqlState, RpcError, type RpcClient } from './rpc.js'

/** PostgREST error codes meaning the API could not reach PostgreSQL. */
const TRANSIENT_POSTGREST_CODES = new Set(['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'])
const TRANSIENT_HTTP_STATUS = new Set([0, 408, 502, 503, 504])

/**
 * Supabase transport: calls public SQL functions through PostgREST RPC with
 * the service role key. Server-side only; never bundle into the browser.
 */
export class SupabaseRpcClient implements RpcClient {
  private readonly client: SupabaseClient

  constructor(url: string, serviceRoleKey: string, options: { fetch?: typeof fetch } = {}) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: 'public' },
      ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
    })
  }

  async call(fn: string, args: Record<string, unknown>): Promise<unknown> {
    assertIdentifier(fn)
    let response: Awaited<ReturnType<SupabaseClient['rpc']>>
    try {
      response = await this.client.rpc(fn, args)
    } catch (error) {
      throw new RpcError('Supabase request failed', { transient: true, cause: error })
    }
    const { data, error, status } = response
    if (error) {
      const code = typeof error.code === 'string' && error.code !== '' ? error.code : null
      throw new RpcError(error.message, {
        sqlstate: code,
        detail: typeof error.details === 'string' ? error.details : null,
        transient:
          TRANSIENT_HTTP_STATUS.has(status) ||
          (code !== null && TRANSIENT_POSTGREST_CODES.has(code)) ||
          isTransientSqlState(code),
        cause: error,
      })
    }
    return data
  }
}
