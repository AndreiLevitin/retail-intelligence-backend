import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSnapshot } from '../../src/contracts/index.js'
import { routeRequest } from '../../src/http/route.js'
import { routes } from '../../src/http/routes.js'
import { PgRpcClient } from '../../src/store/pgRpcClient.js'
import { SupabaseGateway } from '../../src/store/supabaseGateway.js'
import { createTestApi, freshRun, OPERATOR_TOKEN, tableCounts, type TestApi } from '../support/api.js'
import { createTestDatabase, SEEDED_ASSOCIATES, type TestDatabase } from '../support/testDatabase.js'

let db: TestDatabase
let api: TestApi
let sessionId: string

beforeAll(async () => {
  db = await createTestDatabase()
  api = createTestApi(db, { poolSize: 30 })
})

afterAll(async () => {
  await api.close()
  await db.close()
})

beforeEach(async () => {
  sessionId = await freshRun(db)
})

const reset = (sid: string) => api.request('POST', '/api/demo/reset', { sessionId: sid })

/** Builds a run with every kind of record, receipts included. */
async function busyRun() {
  await api.arrive(sessionId)
  await api.arrive(sessionId)
  const board = await api.board()
  const [first, second] = board.assignments
  await api.request('POST', `/api/assignments/${first!.assignmentId}/accept`, { sessionId })
  await api.request('POST', `/api/assignments/${first!.assignmentId}/outcome`, { sessionId, outcome: 'Sale' })
  await api.request('POST', '/api/availability', {
    sessionId, participantId: board.associates[2]!.participantId, commandId: randomUUID(), state: 'OffFloor',
  })
  return { board: await api.board(), pendingAssignmentId: second!.assignmentId, visitId: second!.visitId }
}

describe('POST /api/demo/reset', () => {
  it('atomically replaces the run: new identity, empty data, roster Available in initial order', async () => {
    const { board: before } = await busyRun()
    const response = await reset(sessionId)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ sessionId: expect.any(String), startedAt: expect.any(String) })
    expect(response.body.sessionId).not.toBe(sessionId)
    expect(Date.parse(response.body.startedAt)).toBeGreaterThanOrEqual(Date.parse(before.session.startedAt))

    const board = await api.board()
    expect(board.session).toEqual(response.body)
    expect(board.visits).toEqual([])
    expect(board.assignments).toEqual([])
    expect(board.activity).toEqual([])
    expect(board.metrics).toEqual({ visitors: 0, assignedTurns: 0, acceptedTurns: 0, closedSales: 0, conversionRate: 0 })
    expect(board.associates.map((a) => [a.associateId, a.state, a.queuePosition, a.assignedTurns])).toEqual(
      SEEDED_ASSOCIATES.map((a, i) => [a.associateId, 'Available', i + 1, 0]),
    )
    // Participant identities are per run.
    expect(board.associates.map((a) => a.participantId)).not.toContain(before.associates[0]!.participantId)
    expect(await tableCounts(db)).toEqual({ visits: 0, assignments: 0, activity: 0, receipts: 0 })
    const sessions = await db.admin.query('select count(*)::int as n from public.demo_sessions')
    expect(sessions.rows[0].n).toBe(1)
    const roster = await db.admin.query('select count(*)::int as n from public.associates')
    expect(roster.rows[0].n).toBe(3)
  })

  it('rejects every old-run command afterwards with STALE_SESSION, including a replayed reset', async () => {
    const { board, pendingAssignmentId, visitId } = await busyRun()
    const newSession = (await reset(sessionId)).body.sessionId
    const old = sessionId
    const participantId = board.associates[0]!.participantId
    const attempts = [
      reset(old),
      api.arrive(old),
      api.request('POST', '/api/availability', { sessionId: old, participantId, commandId: randomUUID(), state: 'OffFloor' }),
      api.request('POST', `/api/assignments/${pendingAssignmentId}/accept`, { sessionId: old }),
      api.request('POST', `/api/assignments/${pendingAssignmentId}/outcome`, { sessionId: old, outcome: 'Sale' }),
      api.request('POST', `/api/visits/${visitId}/departure`, { sessionId: old, outcome: 'Sale' }),
      api.request('PATCH', `/api/visits/${visitId}/attributes`, {
        sessionId: old, source: 'Manual', enrichmentStatus: 'NotRequested',
        attributes: { upperDescription: '', lowerDescription: '', accessoryDescription: null, ageGroup: 'Unknown', gender: 'Unknown' },
      }),
    ]
    for (const response of await Promise.all(attempts)) {
      expect([response.status, response.body.code]).toEqual([409, 'STALE_SESSION'])
    }
    const after = await api.board()
    expect(after.session.sessionId).toBe(newSession)
    expect(await tableCounts(db)).toEqual({ visits: 0, assignments: 0, activity: 0, receipts: 0 })
    // Old-run targets are unknown in the new run.
    const unknown = await api.request('POST', `/api/assignments/${pendingAssignmentId}/accept`, { sessionId: newSession })
    expect([unknown.status, unknown.body.code]).toEqual([404, 'NOT_FOUND'])
  })

  it('concurrent resets of the same run apply once', async () => {
    const responses = await Promise.all([reset(sessionId), reset(sessionId), reset(sessionId)])
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1)
    expect(responses.filter((r) => r.body.code === 'STALE_SESSION')).toHaveLength(2)
    const winner = responses.find((r) => r.status === 200)!.body.sessionId
    expect((await api.board()).session.sessionId).toBe(winner)
  })

  it('in-flight old-session arrivals either land before the reset (and are cleared) or are rejected', async () => {
    const arrivals = Array.from({ length: 10 }, () => api.arrive(sessionId))
    const resetting = reset(sessionId)
    const results = await Promise.all([...arrivals, resetting])
    const resetResponse = results.pop()!
    expect(resetResponse.status).toBe(200)
    for (const r of results) expect([201, 409]).toContain(r.status)
    for (const r of results.filter((r) => r.status === 409)) expect(r.body.code).toBe('STALE_SESSION')
    const board = await api.board()
    expect(board.session.sessionId).toBe(resetResponse.body.sessionId)
    expect(board.visits).toEqual([])
  })

  it('rolls back completely when the reset fails midway and returns a sanitized 500', async () => {
    const { board: before } = await busyRun()
    await db.admin.query(`
      create function public.test_fail_seed() returns trigger language plpgsql as $$
      begin raise exception 'injected failure: secret internals'; end $$;
      create trigger test_fail_seed before insert on public.associate_sessions
        for each row execute function public.test_fail_seed();`)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await reset(sessionId)
      expect(response.status).toBe(500)
      expect(response.body).toEqual({ code: 'INTERNAL_ERROR', message: 'Unexpected server error.' })
      expect(JSON.stringify(response.body)).not.toMatch(/injected|secret|sql/i)
    } finally {
      errors.mockRestore()
      await db.admin.query(`
        drop trigger test_fail_seed on public.associate_sessions;
        drop function public.test_fail_seed();`)
    }
    const after = await api.board()
    expect({ ...after, serverTime: null }).toEqual({ ...before, serverTime: null })
    // The run still works and can be reset normally.
    expect((await reset(sessionId)).status).toBe(200)
  })

  it('board reads during repeated resets always see one complete committed run', async () => {
    let current = sessionId
    let running = true
    const snapshots: BoardSnapshot[] = []
    const reader = (async () => {
      while (running) snapshots.push(await api.board())
    })()
    for (let i = 0; i < 8; i++) {
      await api.arrive(current)
      current = (await reset(current)).body.sessionId
    }
    running = false
    await reader
    expect(snapshots.length).toBeGreaterThan(0)
    for (const snapshot of snapshots) {
      expect(snapshot.associates).toHaveLength(3)
      const participants = new Set(snapshot.associates.map((a) => a.participantId))
      const visits = new Set(snapshot.visits.map((v) => v.visitId))
      for (const a of snapshot.assignments) {
        expect(participants.has(a.participantId)).toBe(true)
        expect(visits.has(a.visitId)).toBe(true)
      }
      expect(snapshot.metrics.visitors).toBe(snapshot.visits.length)
    }
  })

  it('validates the reset body', async () => {
    expect((await api.request('POST', '/api/demo/reset', {})).status).toBe(400)
    expect((await api.request('POST', '/api/demo/reset', { sessionId, force: true })).status).toBe(400)
    expect((await api.request('POST', '/api/demo/reset', { sessionId }, { token: null })).status).toBe(401)
    expect((await api.board()).session.sessionId).toBe(sessionId)
  })
})

describe('database availability', () => {
  it('maps an unreachable database to 503 DATABASE_UNAVAILABLE without leaking details', async () => {
    const rpc = new PgRpcClient('postgres://upb_backend:x@127.0.0.1:1/none', { max: 1 })
    const deps = { operatorToken: OPERATOR_TOKEN, store: new SupabaseGateway(rpc) }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await routeRequest(
        routes,
        new Request('http://localhost/api/board', { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } }),
        () => deps,
      )
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        code: 'DATABASE_UNAVAILABLE',
        message: 'The database is temporarily unavailable. Try again.',
      })
    } finally {
      errors.mockRestore()
      await rpc.close()
    }
  })
})
