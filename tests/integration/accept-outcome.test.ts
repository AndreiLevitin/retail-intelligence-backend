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

/** Arrives one visitor and returns its ids (assignment null while Waiting). */
async function arriveVisitor() {
  const response = await api.arrive(sessionId)
  const board = await api.board()
  const visit = board.visits.find((v) => v.visitId === response.body.visitId)!
  return { visitId: visit.visitId, assignmentId: visit.assignmentId }
}

const assignmentOf = async (visitId: string) =>
  (await api.board()).assignments.find((a) => a.visitId === visitId)!
const queue = async () => (await api.board()).associates.map((a) => a.queuePosition)

describe('POST /api/assignments/{id}/accept', () => {
  it('accepts the pending offer once: moves the associate to the bottom, keeps them Available', async () => {
    const { visitId, assignmentId } = await arriveVisitor()
    const response = await accept(assignmentId!)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ sessionId, assignmentId, phase: 'Accepted', replayed: false })

    const board = await api.board()
    expect(board.visits[0]).toMatchObject({ visitId, status: 'Accepted' })
    expect(board.assignments[0]).toMatchObject({ phase: 'Accepted', acceptedAt: expect.any(String), completedAt: null })
    expect(board.associates[0]).toMatchObject({
      state: 'Available',
      queuePosition: 3,
      pendingAssignmentId: null,
      activeAssignmentIds: [assignmentId],
      activeTurns: 1,
      acceptedTurns: 1,
    })
    expect(board.associates.map((a) => a.queuePosition)).toEqual([3, 1, 2])
    expect(board.metrics.acceptedTurns).toBe(1)
    expect(board.activity[0]!.kind).toBe('AssignmentAccepted')

    const before = await tableCounts(db)
    const replay = await accept(assignmentId!)
    expect(replay.body).toEqual({ sessionId, assignmentId, phase: 'Accepted', replayed: true })
    expect(await tableCounts(db)).toEqual(before)
    expect(await queue()).toEqual([3, 1, 2])
  })

  it('advances on acceptance: A -> B -> C -> A while earlier turns stay unfinished', async () => {
    const v = []
    for (let i = 0; i < 4; i++) v.push(await arriveVisitor())
    let board = await api.board()
    const [a, b, c] = board.associates.map((p) => p.participantId)
    // Only one offer exists; later arrivals wait behind it.
    expect(board.assignments).toHaveLength(1)
    expect(board.visits.map((x) => x.status)).toEqual(['Assigned', 'Waiting', 'Waiting', 'Waiting'])
    expect(board.associates.every((p) => p.state === 'Available')).toBe(true)
    expect(board.associates.map((p) => p.queuePosition)).toEqual([1, 2, 3])
    expect(board.associates[0]!.pendingAssignmentId).toBe(v[0]!.assignmentId)

    await accept(v[0]!.assignmentId!)
    expect((await assignmentOf(v[1]!.visitId)).participantId).toBe(b)
    await accept((await assignmentOf(v[1]!.visitId)).assignmentId)
    expect((await assignmentOf(v[2]!.visitId)).participantId).toBe(c)
    await accept((await assignmentOf(v[2]!.visitId)).assignmentId)
    // V4 goes to A even though A's V1 assignment is still unfinished.
    const fourth = await assignmentOf(v[3]!.visitId)
    expect(fourth).toMatchObject({ participantId: a, phase: 'PendingAcceptance' })

    board = await api.board()
    expect(board.associates[0]).toMatchObject({
      queuePosition: 1,
      pendingAssignmentId: fourth.assignmentId,
      activeAssignmentIds: [v[0]!.assignmentId],
      activeTurns: 1,
      assignedTurns: 2,
    })

    // Sale/NoSale on V1 does not change queue order; repeated acceptance never moves A twice.
    const order = board.associates.map((p) => p.queuePosition)
    await outcome(v[0]!.assignmentId!, 'Sale')
    expect(await queue()).toEqual(order)
    await accept(v[0]!.assignmentId!)
    expect(await queue()).toEqual(order)

    // V1 is now completed, so after accepting V4 only V4 is active for A.
    await accept(fourth.assignmentId)
    board = await api.board()
    expect(board.associates[0]).toMatchObject({ activeAssignmentIds: [fourth.assignmentId], activeTurns: 1, acceptedTurns: 2 })
    expect(board.metrics).toMatchObject({ visitors: 4, assignedTurns: 4, acceptedTurns: 4, closedSales: 1, conversionRate: 25 })
  })

  it('allows several accepted unfinished assignments for one associate', async () => {
    // Only Alex on the floor: every visitor is offered to Alex in turn.
    const board0 = await api.board()
    for (const p of board0.associates.slice(1)) {
      await api.request('POST', '/api/availability', { sessionId, participantId: p.participantId, commandId: randomUUID(), state: 'OffFloor' })
    }
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const { visitId } = await arriveVisitor()
      const assignment = await assignmentOf(visitId)
      ids.push(assignment.assignmentId)
      await accept(assignment.assignmentId)
    }
    const alex = (await api.board()).associates[0]!
    expect(alex).toMatchObject({ state: 'Available', queuePosition: 1, activeAssignmentIds: ids, activeTurns: 3, pendingAssignmentId: null })
  })

  it('applies concurrent acceptances exactly once and moves the associate once', async () => {
    const { assignmentId } = await arriveVisitor()
    const responses = await Promise.all(Array.from({ length: 6 }, () => accept(assignmentId!)))
    expect(responses.every((r) => r.status === 200)).toBe(true)
    expect(responses.filter((r) => !r.body.replayed)).toHaveLength(1)
    const board = await api.board()
    expect(board.activity.filter((a) => a.kind === 'AssignmentAccepted')).toHaveLength(1)
    expect(board.associates.map((a) => a.queuePosition)).toEqual([3, 1, 2])
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
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST, OPTIONS'])
  })
})

describe('POST /api/assignments/{id}/outcome', () => {
  it('records Sale on Visit and completes only that turn; rotation and visitor presence unchanged', async () => {
    const first = await arriveVisitor()
    await accept(first.assignmentId!)
    const before = await api.board()
    const response = await outcome(first.assignmentId!, 'Sale')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ sessionId, visitId: first.visitId, assignmentId: first.assignmentId, outcome: 'Sale', replayed: false })

    const board = await api.board()
    expect(board.visits[0]).toMatchObject({ status: 'Completed', outcome: 'Sale', outcomeRecordedAt: expect.any(String), departedAt: null })
    expect(board.assignments[0]).toMatchObject({ phase: 'Completed', completionReason: 'OutcomeRecorded', completedAt: expect.any(String) })
    expect(board.associates.map((a) => [a.state, a.queuePosition])).toEqual(before.associates.map((a) => [a.state, a.queuePosition]))
    expect(board.associates[0]).toMatchObject({ activeAssignmentIds: [], activeTurns: 0, assignedTurns: 1, acceptedTurns: 1 })
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

  it('does not create offers: Waiting visitors stay behind a pending offer after an outcome', async () => {
    const v1 = await arriveVisitor()
    await accept(v1.assignmentId!) // V2 arrives next and is offered immediately
    const v2 = await arriveVisitor()
    const v3 = await arriveVisitor()
    await outcome(v1.assignmentId!, 'Sale')
    const board = await api.board()
    expect(board.visits.find((x) => x.visitId === v2.visitId)!.status).toBe('Assigned')
    expect(board.visits.find((x) => x.visitId === v3.visitId)).toMatchObject({ status: 'Waiting', waitingPosition: 1 })
    expect(board.assignments).toHaveLength(2)
  })

  it('serializes concurrent conflicting outcomes: one wins, rotation untouched', async () => {
    const { assignmentId } = await arriveVisitor()
    await accept(assignmentId!)
    const [a, b] = await Promise.all([outcome(assignmentId!, 'Sale'), outcome(assignmentId!, 'NoSale')])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const board = await api.board()
    expect(board.activity.filter((e) => e.kind === 'TurnCompleted')).toHaveLength(1)
    expect(board.associates.map((p) => p.queuePosition)).toEqual([3, 1, 2])
  })
})
