/**
 * Drives the real HTTP route pipeline (validation, auth, error mapping) with
 * the real SupabaseGateway over the node-postgres transport, connected as the
 * backend role to a disposable database. No store or RPC is mocked.
 */
import { randomUUID } from 'node:crypto'
import type { BoardSnapshot, VisitorAttributes } from '../../src/contracts/index.js'
import { routeRequest } from '../../src/http/route.js'
import { routes } from '../../src/http/routes.js'
import { PgRpcClient } from '../../src/store/pgRpcClient.js'
import { SupabaseGateway } from '../../src/store/supabaseGateway.js'
import type { TestDatabase } from './testDatabase.js'

export const OPERATOR_TOKEN = 'test-operator-token'

export interface ApiResponse<T = any> {
  status: number
  headers: Headers
  body: T
}

export interface TestApi {
  request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    options?: { token?: string | null; contentType?: string; rawBody?: string },
  ): Promise<ApiResponse<T>>
  board(): Promise<BoardSnapshot>
  /** Registers a manual arrival with a fresh eventId (or the given one). */
  arrive(sessionId: string, attributes?: Partial<VisitorAttributes>, eventId?: string): Promise<ApiResponse>
  rpc: PgRpcClient
  close(): Promise<void>
}

export function attributes(overrides: Partial<VisitorAttributes> = {}): VisitorAttributes {
  return {
    upperDescription: 'Red jacket',
    lowerDescription: 'Blue jeans',
    accessoryDescription: null,
    ageGroup: 'From20To39',
    gender: 'Unknown',
    ...overrides,
  }
}

export function createTestApi(db: TestDatabase, options: { poolSize?: number } = {}): TestApi {
  const rpc = new PgRpcClient(db.backendUrl, { max: options.poolSize ?? 10 })
  const deps = { operatorToken: OPERATOR_TOKEN, store: new SupabaseGateway(rpc) }

  const api: TestApi = {
    rpc,
    async request(method, path, body, opts = {}) {
      const headers = new Headers()
      const token = opts.token === undefined ? OPERATOR_TOKEN : opts.token
      if (token !== null) headers.set('authorization', `Bearer ${token}`)
      let payload: string | undefined
      if (opts.rawBody !== undefined || body !== undefined) {
        headers.set('content-type', opts.contentType ?? 'application/json')
        payload = opts.rawBody ?? JSON.stringify(body)
      }
      const response = await routeRequest(
        routes,
        new Request(`http://localhost${path}`, { method, headers, body: payload }),
        () => deps,
      )
      const text = await response.text()
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null }
    },
    async board() {
      const response = await api.request<BoardSnapshot>('GET', '/api/board')
      if (response.status !== 200) throw new Error(`board failed: ${response.status}`)
      return response.body
    },
    arrive(sessionId, attrs = {}, eventId = randomUUID()) {
      return api.request('POST', '/api/arrivals', {
        sessionId,
        eventId,
        source: 'Manual',
        detectedAt: null,
        attributes: attributes(attrs),
      })
    },
    close: () => rpc.close(),
  }
  return api
}

/**
 * Test arrangement only: replaces the current run with a fresh seeded one via
 * the superuser connection (independent of the reset command under test).
 */
export async function freshRun(db: TestDatabase): Promise<string> {
  await db.admin.query(`
    update public.demo_control set current_session_id = null where id = 1;
    delete from public.command_receipts;
    delete from public.activity_entries;
    delete from public.assignments;
    delete from public.visits;
    delete from public.associate_sessions;
    delete from public.demo_sessions;
    update public.demo_control set current_session_id = upb_private.seed_session() where id = 1;`)
  const row = await db.admin.query<{ id: string }>('select current_session_id as id from public.demo_control')
  return row.rows[0]!.id
}

export async function tableCounts(db: TestDatabase): Promise<Record<string, number>> {
  const result = await db.admin.query<{ visits: number; assignments: number; activity: number; receipts: number }>(`
    select (select count(*)::int from public.visits) as visits,
           (select count(*)::int from public.assignments) as assignments,
           (select count(*)::int from public.activity_entries) as activity,
           (select count(*)::int from public.command_receipts) as receipts`)
  return result.rows[0]!
}
