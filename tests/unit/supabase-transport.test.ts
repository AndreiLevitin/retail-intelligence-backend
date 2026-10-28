/**
 * PostgREST transport parsing. This verifies how SupabaseRpcClient builds RPC
 * requests and how SupabaseGateway maps PostgREST responses; it is NOT
 * evidence of transaction behavior (see tests/integration for that).
 * Response bodies follow PostgREST's documented error format.
 */
import { describe, expect, it } from 'vitest'
import { SupabaseGateway } from '../../src/store/supabaseGateway.js'
import { SupabaseRpcClient } from '../../src/store/supabaseRpcClient.js'

type Reply = { status: number; body: unknown } | Error

function gatewayWith(reply: Reply) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), init })
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const client = new SupabaseRpcClient('https://example.supabase.co', 'service-role-key', { fetch: fakeFetch })
  return { gateway: new SupabaseGateway(client), calls }
}

describe('SupabaseRpcClient + SupabaseGateway', () => {
  it('posts named arguments to /rest/v1/rpc/<function> with the service key', async () => {
    const result = { sessionId: 's', participantId: 'p', replayed: false }
    const { gateway, calls } = gatewayWith({ status: 200, body: result })
    await expect(
      gateway.setAvailability({ sessionId: 's', participantId: 'p', commandId: 'c', state: 'OffFloor' }),
    ).resolves.toEqual(result)
    expect(calls[0]!.url).toBe('https://example.supabase.co/rest/v1/rpc/upb_set_availability')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      p_session_id: 's', p_participant_id: 'p', p_command_id: 'c', p_state: 'OffFloor',
    })
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('apikey')).toBe('service-role-key')
  })

  it('maps raised domain errors (SQLSTATE P0001) to their stable code and public detail', async () => {
    const { gateway } = gatewayWith({
      status: 400,
      body: { code: 'P0001', message: 'STALE_SESSION', details: 'The demo run has changed; reload the board.', hint: null },
    })
    await expect(gateway.getBoard()).rejects.toMatchObject({
      code: 'STALE_SESSION',
      message: 'The demo run has changed; reload the board.',
    })
  })

  it('maps PostgREST connection failures and network errors to DATABASE_UNAVAILABLE', async () => {
    const down = gatewayWith({ status: 503, body: { code: 'PGRST001', message: 'Database client error', details: null, hint: null } })
    await expect(down.gateway.getBoard()).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' })
    const network = gatewayWith(new TypeError('fetch failed'))
    await expect(network.gateway.getBoard()).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' })
  })

  it('maps other SQL failures to a sanitized INTERNAL_ERROR', async () => {
    const { gateway } = gatewayWith({
      status: 400,
      body: { code: '23505', message: 'duplicate key value violates unique constraint "x"', details: 'Key (id)=(1)', hint: null },
    })
    const error = await gateway.getBoard().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Unexpected server error.' })
    // A P0001 message that is not a known code is not trusted as public.
    const unknown = gatewayWith({ status: 400, body: { code: 'P0001', message: 'participant x is not busy', details: null, hint: null } })
    await expect(unknown.gateway.getBoard()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})
