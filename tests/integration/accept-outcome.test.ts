import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApi, freshRun, tableCounts, type TestApi } from '../support/api.js'
import { createTestDatabase, type TestDatabase } from '../support/testDatabase.js'

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

const accept = (assignmentId: string, sid = sessionId) =>
  api.request('POST', `/api/assignments/${assignmentId}/accept`, { sessionId: sid })
const outcome = (assignmentId: string, value: string, sid = sessionId) =>
  api.request('POST', `/api/assignments/${assignmentId}/outcome`, { sessionId: sid, outcome: value })

/** Arrives one visitor and returns its ids (assignment may be null if Waiting). */
async function arriveVisitor() {
  const response = await api.arrive(sessionId)
  const board = await api.board()
  const visit = board.visits.find((v) => v.visitId === response.body.visitId)!
  return { visitId: visit.visitId, assignmentId: visit.assignmentId }
}

describe('POST /api/assignments/{id}/accept', () => {
  it('accepts a pending assignment once: Visit Accepted, participant OnUP and still ineligible', async () => {
    const { visitId, assignmentId } = await arriveVisitor()
    const response = await accept(assignmentId!)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ sessionId, assignmentId, phase: 'Accepted', replayed: false })

    const board = await api.board()
    expect(board.visits[0]).toMatchObject({ visitId, status: 'Accepted' })
    expect(board.assignments[0]).toMatchObject({ phase: 'Accepted', acceptedAt: expect.any(String), completedAt: null })
    expect(board.associates[0]).toMatchObject({ state: 'OnUP', queuePosition: null, acceptedTurns: 1 })
    expect(board.metrics.acceptedTurns).toBe(1)
    expect(board.activity[0]!.kind).toBe('AssignmentAccepted')

    const before = await tableCounts(db)
    const replay = await accept(assignmentId!)
    expect(replay.body).toEqual({ sessionId, assignmentId, phase: 'Accepted', replayed: true })
    expect(await tableCounts(db)).toEqual(before)
    expect((await api.board()).assignments[0]!.acceptedAt).toBe(board.assignments[0]!.acceptedAt)
  })

  it('applies concurrent acceptances exactly once', async () => {
    const { assignmentId } = await arriveVisitor()
    const responses = await Promise.all(Array.from({ length: 6 }, () => accept(assignmentId!)))
    expect(responses.every((r) => r.status === 200)).toBe(true)
    expect(responses.filter((r) => !r.body.replayed)).toHaveLength(1)
    const board = await api.board()
    expect(board.activity.filter((a) => a.kind === 'AssignmentAccepted')).toHaveLength(1)
  })

  it('returns NOT_FOUND, VALIDATION_ERROR and STALE_SESSION precisely', async () => {
    await arriveVisitor()
    expect((await accept(randomUUID())).body.code).toBe('NOT_FOUND')
    expect((await accept(randomUUID())).status).toBe(404)
    const malformed = await accept('not-a-uuid')
    expect([malformed.status, malformed.body.code]).toEqual([400, 'VALIDATION_ERROR'])
    const extra = await api.request('POST', `/api/assignments/${randomUUID()}/accept`, { sessionId, commandId: randomUUID() })
    expect(extra.status).toBe(400)
    const stale = await accept(randomUUID(), randomUUID())
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_SESSION'])
    const get = await api.request('GET', `/api/assignments/${randomUUID()}/accept`)
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST'])
  })
})

describe('POST /api/assignments/{id}/outcome', () => {
  it('records Sale on Visit, completes the turn, releases to the bottom once and keeps the visitor inside', async () => {
    const first = await arriveVisitor()
    await accept(first.assignmentId!)
    const response = await outcome(first.assignmentId!, 'Sale')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ sessionId, visitId: first.visitId, assignmentId: first.assignmentId, outcome: 'Sale', replayed: false })

    const board = await api.board()
    expect(board.visits[0]).toMatchObject({ status: 'Completed', outcome: 'Sale', outcomeRecordedAt: expect.any(String), departedAt: null })
    expect(board.assignments[0]).toMatchObject({ phase: 'Completed', completionReason: 'OutcomeRecorded', completedAt: expect.any(String) })
    const [alex, jamie, morgan] = board.associates
    expect([jamie!.queuePosition, morgan!.queuePosition, alex!.queuePosition]).toEqual([1, 2, 3])
    expect(alex).toMatchObject({ state: 'Available', currentAssignmentId: null, assignedTurns: 1, acceptedTurns: 1 })
    expect(board.metrics).toEqual({ visitors: 1, assignedTurns: 1, acceptedTurns: 1, closedSales: 1, conversionRate: 100 })
    expect(board.activity.map((a) => a.kind)).toEqual(['TurnCompleted', 'AssignmentAccepted', 'AssignmentCreated', 'ArrivalRecorded'])
  })

  it('treats the same result as a replay and a different one as OUTCOME_CONFLICT', async () => {
    const { assignmentId } = await arriveVisitor()
    await accept(assignmentId!)
    await outcome(assignmentId!, 'NoSale')
    const before = await tableCounts(db)
    const replay = await outcome(assignmentId!, 'NoSale')
    expect([replay.status, replay.body.replayed]).toEqual([200, true])
    const conflict = await outcome(assignmentId!, 'Sale')
    expect([conflict.status, conflict.body.code]).toEqual([409, 'OUTCOME_CONFLICT'])
    expect(await tableCounts(db)).toEqual(before)
    // Acceptance after completion reports the current phase without reopening.
    const late = await accept(assignmentId!)
    expect(late.body).toEqual({ sessionId, assignmentId, phase: 'Completed', replayed: true })
    const board = await api.board()
    expect(board.metrics).toMatchObject({ closedSales: 0, conversionRate: 0 })
    expect(board.associates[0]!.queuePosition).toBe(3)
  })

  it('rejects an outcome before acceptance and invalid values', async () => {
    const { assignmentId } = await arriveVisitor()
    const early = await outcome(assignmentId!, 'Sale')
    expect([early.status, early.body.code]).toEqual([409, 'INVALID_TRANSITION'])
    expect((await outcome(assignmentId!, 'Maybe')).status).toBe(400)
    expect((await outcome(assignmentId!, 'No-Sale')).status).toBe(400)
    expect((await api.request('POST', `/api/assignments/${assignmentId}/outcome`, { sessionId })).status).toBe(400)
    expect((await api.board()).assignments[0]!.phase).toBe('PendingAcceptance')
  })

  it('dispatches the oldest Waiting visit to the released associate', async () => {
    const visitors = []
    for (let i = 0; i < 5; i++) visitors.push(await arriveVisitor())
    // Jamie (2nd) finishes first; the 4th visitor (oldest Waiting) goes to Jamie.
    await accept(visitors[1]!.assignmentId!)
    await outcome(visitors[1]!.assignmentId!, 'Sale')
    const board = await api.board()
    const fourth = board.visits[3]!
    const fifth = board.visits[4]!
    expect(fourth.status).toBe('Assigned')
    expect(fifth).toMatchObject({ status: 'Waiting', waitingPosition: 1 })
    const jamie = board.associates[1]!
    expect(board.assignments.find((a) => a.visitId === fourth.visitId)!.participantId).toBe(jamie.participantId)
    expect(jamie).toMatchObject({ state: 'PendingAcceptance', assignedTurns: 2 })
    expect(board.metrics).toMatchObject({ visitors: 5, assignedTurns: 4, closedSales: 1, conversionRate: 20 })
  })

  it('serializes concurrent conflicting outcomes: one wins, the participant is released once', async () => {
    const { assignmentId } = await arriveVisitor()
    await accept(assignmentId!)
    const [a, b] = await Promise.all([outcome(assignmentId!, 'Sale'), outcome(assignmentId!, 'NoSale')])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const board = await api.board()
    expect(board.activity.filter((e) => e.kind === 'TurnCompleted')).toHaveLength(1)
    expect(board.associates.map((p) => p.queuePosition)).toEqual([3, 1, 2])
  })
})
