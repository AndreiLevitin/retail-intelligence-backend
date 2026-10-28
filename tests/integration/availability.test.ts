import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApi, freshRun, tableCounts, type TestApi } from '../support/api.js'
import { createTestDatabase, type TestDatabase } from '../support/testDatabase.js'

let db: TestDatabase
let api: TestApi
let sessionId: string
let ids: { alex: string; jamie: string; morgan: string }

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
  const [alex, jamie, morgan] = (await api.board()).associates.map((a) => a.participantId)
  ids = { alex: alex!, jamie: jamie!, morgan: morgan! }
})

const setState = (participantId: string, state: string, commandId: string = randomUUID()) =>
  api.request('POST', '/api/availability', { sessionId, participantId, commandId, state })

const queue = async () => (await api.board()).associates.map((a) => [a.state, a.queuePosition])

describe('POST /api/availability', () => {
  it('Off Floor removes eligibility; returning Available appends to the bottom', async () => {
    const off = await setState(ids.alex, 'OffFloor')
    expect(off.status).toBe(200)
    expect(off.body).toEqual({ sessionId, participantId: ids.alex, replayed: false })
    expect(await queue()).toEqual([['OffFloor', null], ['Available', 1], ['Available', 2]])

    const visit = await api.arrive(sessionId)
    const board = await api.board()
    expect(board.assignments[0]!.participantId).toBe(ids.jamie)
    expect(visit.body.status).toBe('Assigned')

    await setState(ids.alex, 'Available')
    expect(await queue()).toEqual([['Available', 2], ['PendingAcceptance', null], ['Available', 1]])
    const activity = (await api.board()).activity.filter((a) => a.kind === 'AvailabilityChanged')
    expect(activity.map((a) => a.description)).toEqual(['Alex: Off Floor -> Available', 'Alex: Available -> Off Floor'])
    expect(activity[0]).toMatchObject({ participantId: ids.alex, visitId: null, assignmentId: null })
  })

  it('setting the existing state is a no-op that still saves the receipt', async () => {
    const commandId = randomUUID()
    const before = await tableCounts(db)
    const response = await setState(ids.jamie, 'Available', commandId)
    expect(response.body.replayed).toBe(false)
    expect(await tableCounts(db)).toEqual({ ...before, receipts: before.receipts + 1 })
    expect(await queue()).toEqual([['Available', 1], ['Available', 2], ['Available', 3]])
    expect((await setState(ids.jamie, 'Available', commandId)).body.replayed).toBe(true)
  })

  it('a delayed retry of an earlier command never undoes a later change', async () => {
    const offCommand = randomUUID()
    await setState(ids.morgan, 'OffFloor', offCommand)
    await setState(ids.morgan, 'Available')
    const before = await api.board()
    const retry = await setState(ids.morgan, 'OffFloor', offCommand)
    expect(retry.body).toEqual({ sessionId, participantId: ids.morgan, replayed: true })
    const after = await api.board()
    expect(after.associates).toEqual(before.associates)
    expect(after.activity).toEqual(before.activity)
  })

  it('rejects busy participants, but replays still win over current-state validation', async () => {
    const offCommand = randomUUID()
    await setState(ids.alex, 'OffFloor', offCommand)
    await setState(ids.alex, 'Available')
    await api.arrive(sessionId) // Jamie is next and becomes PendingAcceptance
    await api.arrive(sessionId) // Morgan
    await api.arrive(sessionId) // Alex (bottom of the queue)
    const busy = await setState(ids.alex, 'OffFloor')
    expect([busy.status, busy.body.code]).toEqual([409, 'INVALID_TRANSITION'])
    expect((await setState(ids.alex, 'Available')).body.code).toBe('INVALID_TRANSITION')
    expect((await setState(ids.alex, 'OffFloor', offCommand)).body.replayed).toBe(true)
    expect((await api.board()).associates[0]!.state).toBe('PendingAcceptance')

    // OnUP is busy as well.
    const assignmentId = (await api.board()).assignments[0]!.assignmentId
    await api.request('POST', `/api/assignments/${assignmentId}/accept`, { sessionId })
    expect((await setState(ids.jamie, 'OffFloor')).body.code).toBe('INVALID_TRANSITION')
  })

  it('rejects a reused commandId with different content or kind', async () => {
    const commandId = randomUUID()
    await setState(ids.alex, 'OffFloor', commandId)
    expect((await setState(ids.alex, 'Available', commandId)).body.code).toBe('REPLAY_CONFLICT')
    expect((await setState(ids.jamie, 'OffFloor', commandId)).body.code).toBe('REPLAY_CONFLICT')
    // Arrival eventIds and availability commandIds share one namespace.
    const eventId = randomUUID()
    await api.arrive(sessionId, {}, eventId)
    expect((await setState(ids.morgan, 'OffFloor', eventId)).body.code).toBe('REPLAY_CONFLICT')
    expect((await api.arrive(sessionId, {}, commandId)).body.code).toBe('REPLAY_CONFLICT')
  })

  it('keeps visits Waiting when everyone is Off Floor and serves them FIFO when capacity returns', async () => {
    for (const id of [ids.alex, ids.jamie, ids.morgan]) await setState(id, 'OffFloor')
    const visits = []
    for (let i = 0; i < 3; i++) visits.push((await api.arrive(sessionId)).body)
    expect(visits.every((v) => v.status === 'Waiting')).toBe(true)
    let board = await api.board()
    expect(board.assignments).toEqual([])
    expect(board.associates.every((a) => a.queuePosition === null)).toBe(true)

    await setState(ids.morgan, 'Available')
    board = await api.board()
    expect(board.visits.map((v) => v.status)).toEqual(['Assigned', 'Waiting', 'Waiting'])
    expect(board.assignments[0]!.participantId).toBe(ids.morgan)
    expect(board.visits.map((v) => v.waitingPosition)).toEqual([null, 1, 2])
    expect(board.activity.slice(0, 2).map((a) => a.kind)).toEqual(['AssignmentCreated', 'AvailabilityChanged'])
  })

  it('concurrent returns with Waiting visitors never reserve one associate twice', async () => {
    for (const id of [ids.alex, ids.jamie, ids.morgan]) await setState(id, 'OffFloor')
    for (let i = 0; i < 5; i++) await api.arrive(sessionId)
    const responses = await Promise.all([
      setState(ids.alex, 'Available'),
      setState(ids.jamie, 'Available'),
      setState(ids.morgan, 'Available'),
      api.arrive(sessionId),
      api.arrive(sessionId),
    ])
    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true)
    const board = await api.board()
    expect(board.assignments).toHaveLength(3)
    expect(new Set(board.assignments.map((a) => a.participantId)).size).toBe(3)
    // FIFO: the three oldest registrations are the assigned ones.
    expect(board.visits.slice(0, 3).every((v) => v.status === 'Assigned')).toBe(true)
    expect(board.visits.slice(3).map((v) => v.waitingPosition)).toEqual([1, 2, 3, 4])
  })

  it('validates the body and reports unknown/stale targets', async () => {
    expect((await setState(randomUUID(), 'OffFloor')).status).toBe(404)
    for (const body of [
      { sessionId, participantId: ids.alex, commandId: randomUUID(), state: 'OnUP' },
      { sessionId, participantId: ids.alex, state: 'OffFloor' },
      { sessionId, participantId: 'alex', commandId: randomUUID(), state: 'OffFloor' },
      { sessionId, participantId: ids.alex, commandId: randomUUID(), state: 'OffFloor', queuePosition: 1 },
    ]) {
      const response = await api.request('POST', '/api/availability', body)
      expect([response.status, response.body.code]).toEqual([400, 'VALIDATION_ERROR'])
    }
    const stale = await api.request('POST', '/api/availability', {
      sessionId: randomUUID(), participantId: ids.alex, commandId: randomUUID(), state: 'OffFloor',
    })
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_SESSION'])
    expect(await queue()).toEqual([['Available', 1], ['Available', 2], ['Available', 3]])
  })
})
