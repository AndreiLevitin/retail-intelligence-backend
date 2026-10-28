import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { attributes, createTestApi, freshRun, tableCounts, type TestApi } from '../support/api.js'
import { createTestDatabase, SEEDED_ASSOCIATES, type TestDatabase } from '../support/testDatabase.js'

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

let db: TestDatabase
let api: TestApi
let sessionId: string

beforeAll(async () => {
  db = await createTestDatabase()
  api = createTestApi(db, { poolSize: 20 })
})

afterAll(async () => {
  await api.close()
  await db.close()
})

beforeEach(async () => {
  sessionId = await freshRun(db)
})

describe('GET /api/board', () => {
  it('returns the seeded run with deterministic roster, empty collections and zero metrics', async () => {
    const response = await api.request('GET', '/api/board')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const board = response.body
    expect(Object.keys(board).sort()).toEqual(
      ['activity', 'assignments', 'associates', 'metrics', 'serverTime', 'session', 'visits'].sort(),
    )
    expect(board.session.sessionId).toBe(sessionId)
    expect(board.session.startedAt).toMatch(ISO_UTC)
    expect(board.serverTime).toMatch(ISO_UTC)
    expect(board.associates.map((a: any) => [a.associateId, a.displayName, a.state, a.queuePosition])).toEqual(
      SEEDED_ASSOCIATES.map((a, i) => [a.associateId, a.displayName, 'Available', i + 1]),
    )
    expect(board.associates[0]).toEqual({
      participantId: expect.any(String),
      associateId: SEEDED_ASSOCIATES[0].associateId,
      displayName: 'Alex',
      state: 'Available',
      queuePosition: 1,
      currentAssignmentId: null,
      assignedTurns: 0,
      acceptedTurns: 0,
    })
    expect(board.visits).toEqual([])
    expect(board.assignments).toEqual([])
    expect(board.activity).toEqual([])
    expect(board.metrics).toEqual({ visitors: 0, assignedTurns: 0, acceptedTurns: 0, closedSales: 0, conversionRate: 0 })
  })

  it('requires the operator token and rejects unsupported methods with Allow', async () => {
    expect((await api.request('GET', '/api/board', undefined, { token: null })).status).toBe(401)
    const wrong = await api.request('GET', '/api/board', undefined, { token: 'nope' })
    expect(wrong.status).toBe(401)
    expect(wrong.body).toEqual({ code: 'UNAUTHORIZED', message: expect.any(String) })

    const put = await api.request('PUT', '/api/board', {})
    expect(put.status).toBe(405)
    expect(put.headers.get('allow')).toBe('GET')
    expect(put.headers.get('cache-control')).toBe('no-store')

    const unknown = await api.request('GET', '/api/nothing-here')
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('NOT_FOUND')
  })
})

describe('POST /api/arrivals', () => {
  it('registers a Manual visit and reserves the first Available associate', async () => {
    const response = await api.arrive(sessionId, { accessoryDescription: '  Backpack  ' })
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.body).toEqual({ sessionId, visitId: expect.any(String), duplicate: false, status: 'Assigned' })

    const board = await api.board()
    const [visit] = board.visits
    const [assignment] = board.assignments
    const [alex, jamie, morgan] = board.associates
    expect(visit).toMatchObject({
      visitId: response.body.visitId,
      source: 'Manual',
      status: 'Assigned',
      detectedAt: null,
      departedAt: null,
      outcome: null,
      outcomeRecordedAt: null,
      waitingPosition: null,
      attributesSource: 'Manual',
      enrichmentStatus: 'NotRequested',
      attributes: attributes({ accessoryDescription: 'Backpack' }),
      assignmentId: assignment!.assignmentId,
    })
    expect(visit!.arrivedAt).toMatch(ISO_UTC)
    expect(assignment).toMatchObject({
      visitId: visit!.visitId,
      participantId: alex!.participantId,
      phase: 'PendingAcceptance',
      acceptedAt: null,
      completedAt: null,
      completionReason: null,
    })
    expect(alex).toMatchObject({ state: 'PendingAcceptance', queuePosition: null, currentAssignmentId: assignment!.assignmentId, assignedTurns: 1 })
    expect([jamie!.queuePosition, morgan!.queuePosition]).toEqual([1, 2])
    expect(board.activity.map((a) => a.kind)).toEqual(['AssignmentCreated', 'ArrivalRecorded'])
    expect(board.activity[0]).toMatchObject({ visitId: visit!.visitId, participantId: alex!.participantId, assignmentId: assignment!.assignmentId })
    expect(board.metrics).toEqual({ visitors: 1, assignedTurns: 1, acceptedTurns: 0, closedSales: 0, conversionRate: 0 })
  })

  it('keeps visits Waiting in FIFO order once every associate is busy', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await api.arrive(sessionId)).body.visitId)
    const board = await api.board()
    expect(board.visits.map((v) => v.visitId)).toEqual(ids)
    expect(board.visits.map((v) => v.status)).toEqual(['Assigned', 'Assigned', 'Assigned', 'Waiting', 'Waiting'])
    expect(board.visits.map((v) => v.waitingPosition)).toEqual([null, null, null, 1, 2])
    expect(board.assignments.map((a) => a.participantId)).toEqual(board.associates.map((a) => a.participantId))
    expect(board.associates.every((a) => a.queuePosition === null)).toBe(true)
  })

  it('returns the original visit for an identical replay without new effects', async () => {
    const eventId = randomUUID()
    const first = await api.arrive(sessionId, {}, eventId)
    const before = await tableCounts(db)
    // Same request after normalization (surrounding whitespace) is the same command.
    const replay = await api.arrive(sessionId, { upperDescription: '  Red jacket ' }, eventId)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual({ sessionId, visitId: first.body.visitId, duplicate: true, status: 'Assigned' })
    expect(await tableCounts(db)).toEqual(before)
  })

  it('rejects reuse of an eventId with a different payload', async () => {
    const eventId = randomUUID()
    await api.arrive(sessionId, {}, eventId)
    const before = await tableCounts(db)
    const conflict = await api.arrive(sessionId, { gender: 'Female' }, eventId)
    expect(conflict.status).toBe(409)
    expect(conflict.body.code).toBe('REPLAY_CONFLICT')
    expect(await tableCounts(db)).toEqual(before)
  })

  it('serializes simultaneous distinct arrivals: distinct visits, FIFO reservation, no double booking', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => api.arrive(sessionId)))
    expect(responses.every((r) => r.status === 201)).toBe(true)
    const board = await api.board()
    expect(new Set(board.visits.map((v) => v.visitId)).size).toBe(12)
    // The first three registrations (server order) hold the three reservations.
    expect(board.visits.slice(0, 3).every((v) => v.status === 'Assigned')).toBe(true)
    expect(board.visits.slice(3).map((v) => v.waitingPosition)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(new Set(board.assignments.map((a) => a.participantId)).size).toBe(3)
    const arrivedAt = board.visits.map((v) => v.arrivedAt)
    expect([...arrivedAt].sort()).toEqual(arrivedAt)
    expect(board.metrics.visitors).toBe(12)
  })

  it('creates exactly one visit for concurrent retries of the same eventId', async () => {
    const eventId = randomUUID()
    const responses = await Promise.all(Array.from({ length: 8 }, () => api.arrive(sessionId, {}, eventId)))
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1)
    expect(responses.filter((r) => r.status === 200 && r.body.duplicate)).toHaveLength(7)
    expect(new Set(responses.map((r) => r.body.visitId)).size).toBe(1)
    expect(await tableCounts(db)).toEqual({ visits: 1, assignments: 1, activity: 2, receipts: 1 })
  })

  it('rejects a stale or unknown session before any effect', async () => {
    const stale = await api.arrive(randomUUID())
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('STALE_SESSION')
    expect(await tableCounts(db)).toEqual({ visits: 0, assignments: 0, activity: 0, receipts: 0 })
  })

  it('validates the exact Stage 1 body', async () => {
    const valid = { sessionId, eventId: randomUUID(), source: 'Manual', detectedAt: null, attributes: attributes() }
    const cases: Array<[string, unknown]> = [
      ['CV source', { ...valid, source: 'CV' }],
      ['missing source', { ...valid, source: undefined }],
      ['non-null detectedAt', { ...valid, detectedAt: '2026-10-27T18:02:11Z' }],
      ['extra field', { ...valid, arrivedAt: '2026-10-27T18:02:11Z' }],
      ['extra attribute', { ...valid, attributes: { ...attributes(), confidence: 0.9 } }],
      ['old age value', { ...valid, attributes: attributes({ ageGroup: 'Over60' as never }) }],
      ['missing accessory', { ...valid, attributes: { ...attributes(), accessoryDescription: undefined } }],
      ['null upper', { ...valid, attributes: attributes({ upperDescription: null as never }) }],
      ['too long', { ...valid, attributes: attributes({ lowerDescription: 'x'.repeat(201) }) }],
      ['malformed eventId', { ...valid, eventId: 'abc' }],
      ['malformed sessionId', { ...valid, sessionId: 42 }],
    ]
    for (const [name, body] of cases) {
      const response = await api.request('POST', '/api/arrivals', body)
      expect(response.status, name).toBe(400)
      expect(response.body.code, name).toBe('VALIDATION_ERROR')
    }
    const text = await api.request('POST', '/api/arrivals', undefined, { rawBody: JSON.stringify(valid), contentType: 'text/plain' })
    expect(text.status).toBe(400)
    const broken = await api.request('POST', '/api/arrivals', undefined, { rawBody: '{"sessionId":' })
    expect(broken.status).toBe(400)
    const unauthorized = await api.request('POST', '/api/arrivals', valid, { token: null })
    expect(unauthorized.status).toBe(401)
    // 200 code points is the limit, counted as characters (not UTF-16 units).
    const emoji = await api.arrive(sessionId, { upperDescription: '😀'.repeat(200), lowerDescription: '' })
    expect(emoji.status).toBe(201)
    expect(await tableCounts(db)).toMatchObject({ visits: 1 })
  })

  it('re-validates inside SQL so direct RPC callers cannot bypass the rules', async () => {
    const base = {
      p_session_id: sessionId,
      p_event_id: randomUUID(),
      p_source: 'Manual',
      p_detected_at: null,
      p_upper_description: '  Coat  ',
      p_lower_description: '',
      p_accessory_description: '   ',
      p_age_group: 'Unknown',
      p_gender: 'Unknown',
    }
    await expect(api.rpc.call('upb_register_arrival', { ...base, p_source: 'CV' })).rejects.toMatchObject({ sqlstate: 'P0001', message: 'VALIDATION_ERROR' })
    await expect(api.rpc.call('upb_register_arrival', { ...base, p_detected_at: new Date() })).rejects.toMatchObject({ message: 'VALIDATION_ERROR' })
    await expect(api.rpc.call('upb_register_arrival', { ...base, p_age_group: 'Over60' })).rejects.toMatchObject({ message: 'VALIDATION_ERROR' })
    await api.rpc.call('upb_register_arrival', base)
    const board = await api.board()
    expect(board.visits[0]!.attributes).toMatchObject({ upperDescription: 'Coat', accessoryDescription: null })
  })

  it('denies RPC execution to anonymous roles', async () => {
    const client = await db.admin.connect()
    try {
      await client.query('begin')
      await client.query('set local role anon')
      await expect(client.query('select public.upb_get_board()')).rejects.toThrow(/permission denied/)
    } finally {
      await client.query('rollback')
      client.release()
    }
  })
})
