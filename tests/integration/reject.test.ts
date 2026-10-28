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

const reject = (assignmentId: string, sid = sessionId) =>
  api.request('POST', `/api/assignments/${assignmentId}/reject`, { sessionId: sid })
const accept = (assignmentId: string) =>
  api.request('POST', `/api/assignments/${assignmentId}/accept`, { sessionId })
const offFloor = (participantId: string) =>
  api.request('POST', '/api/availability', { sessionId, participantId, commandId: randomUUID(), state: 'OffFloor' })

async function arriveVisitor() {
  const response = await api.arrive(sessionId)
  const board = await api.board()
  return board.visits.find((v) => v.visitId === response.body.visitId)!
}

describe('POST /api/assignments/{id}/reject', () => {
  it('closes the offer as Rejected and re-offers the visit to the next eligible associate', async () => {
    const visit = await arriveVisitor() // offered to Alex, who moves to the bottom
    const first = visit.assignmentId!
    const before = await api.board()
    expect(before.associates.map((a) => a.queuePosition)).toEqual([3, 1, 2])

    const response = await reject(first)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ sessionId, assignmentId: first, visitId: visit.visitId, status: 'Assigned', replayed: false })

    const board = await api.board()
    const [alex, jamie] = board.associates
    const rejected = board.assignments.find((a) => a.assignmentId === first)!
    const second = board.assignments.find((a) => a.assignmentId !== first)!
    expect(rejected).toMatchObject({ phase: 'Completed', completionReason: 'Rejected', acceptedAt: null, participantId: alex!.participantId })
    // Jamie was first in line: the visit goes to Jamie, who moves to the bottom.
    // Alex's own position was not moved by the rejection.
    expect(second).toMatchObject({ visitId: visit.visitId, participantId: jamie!.participantId, phase: 'PendingAcceptance' })
    expect(board.associates.map((a) => a.queuePosition)).toEqual([2, 3, 1])
    expect(board.visits[0]).toMatchObject({ status: 'Assigned', assignmentId: second.assignmentId, arrivedAt: visit.arrivedAt })
    expect(alex).toMatchObject({ pendingAssignmentId: null, assignedTurns: 1, acceptedTurns: 0 })
    expect(board.activity.slice(0, 2).map((a) => a.kind)).toEqual(['AssignmentCreated', 'AssignmentRejected'])
    expect(board.activity[1]).toMatchObject({ visitId: visit.visitId, participantId: alex!.participantId, assignmentId: first })
    expect(board.metrics).toMatchObject({ visitors: 1, assignedTurns: 2, acceptedTurns: 0 })
  })

  it('never re-offers a visit to its last rejecter; the rejecter still gets other visitors', async () => {
    const roster = (await api.board()).associates
    const [alex, jamie] = roster.map((a) => a.participantId)
    await offFloor(roster[1]!.participantId)
    await offFloor(roster[2]!.participantId)
    const v1 = await arriveVisitor()
    const response = await reject(v1.assignmentId!)
    expect(response.body).toMatchObject({ status: 'Waiting', replayed: false })
    let board = await api.board()
    expect(board.visits[0]).toMatchObject({ status: 'Waiting', waitingReason: 'AwaitingOtherAssociate', assignmentId: null, waitingPosition: 1 })
    expect(board.assignments).toHaveLength(1)
    expect(board.associates[0]).toMatchObject({ state: 'Available', pendingAssignmentId: null })

    // A new visitor goes to Alex; V1 keeps waiting for someone else.
    const v2 = await arriveVisitor()
    expect(board.assignments.length + 1).toBe((await api.board()).assignments.length)
    board = await api.board()
    expect(board.assignments.find((a) => a.visitId === v2.visitId)!.participantId).toBe(alex)
    expect(board.visits[0]).toMatchObject({ status: 'Waiting', waitingReason: 'AwaitingConfirmation' })

    // Jamie returns: V1 is offered to Jamie, not Alex.
    await api.request('POST', '/api/availability', { sessionId, participantId: jamie, commandId: randomUUID(), state: 'Available' })
    board = await api.board()
    const live = board.assignments.find((a) => a.visitId === v1.visitId && a.completionReason === null)!
    expect(live.participantId).toBe(jamie)
    expect(board.visits[0]).toMatchObject({ status: 'Assigned', waitingReason: null })
  })

  it('keeps the rejected visit in FIFO order; the rejecter may take a later visitor', async () => {
    const v: Awaited<ReturnType<typeof arriveVisitor>>[] = []
    for (let i = 0; i < 4; i++) v.push(await arriveVisitor()) // V1-V3 offered to A, B, C; V4 waits
    const [alex, jamie] = (await api.board()).associates.map((a) => a.participantId)
    const response = await reject(v[1]!.assignmentId!) // Jamie rejects V2
    expect(response.body).toMatchObject({ visitId: v[1]!.visitId, status: 'Waiting' })
    let board = await api.board()
    // Jamie is skipped for V2 only and takes V4; V2 waits with its original position.
    expect(board.assignments.find((a) => a.visitId === v[3]!.visitId)!.participantId).toBe(jamie)
    expect(board.visits.find((x) => x.visitId === v[1]!.visitId)).toMatchObject({
      status: 'Waiting', waitingPosition: 1, waitingReason: 'AwaitingConfirmation', assignmentId: null,
    })
    expect(board.visits.map((x) => x.visitId)).toEqual(v.map((x) => x.visitId))

    // Alex accepts V1 and becomes eligible: V2 (oldest Waiting) goes to Alex.
    await accept(v[0]!.assignmentId!)
    board = await api.board()
    const v2 = board.visits.find((x) => x.visitId === v[1]!.visitId)!
    expect(v2.status).toBe('Assigned')
    expect(board.assignments.find((a) => a.assignmentId === v2.assignmentId)!.participantId).toBe(alex)
  })

  it('moves the exclusion to the newest rejecter so a visit circulates between associates', async () => {
    const roster = (await api.board()).associates
    const [alex, jamie] = roster.map((a) => a.participantId)
    await offFloor(roster[2]!.participantId)
    const visit = await arriveVisitor() // to Alex
    await reject(visit.assignmentId!) // -> Jamie (Alex excluded)
    let board = await api.board()
    const second = board.visits[0]!.assignmentId!
    expect(board.assignments.find((a) => a.assignmentId === second)!.participantId).toBe(jamie)
    const response = await reject(second) // Jamie rejects: now Jamie is excluded, Alex is not
    expect(response.body.status).toBe('Assigned')
    board = await api.board()
    const third = board.assignments.find((a) => a.assignmentId === board.visits[0]!.assignmentId)!
    expect(third.participantId).toBe(alex)
    expect(board.assignments.map((a) => a.completionReason)).toEqual(['Rejected', 'Rejected', null])
  })

  it('reports why Waiting visitors have no offer', async () => {
    for (let i = 0; i < 4; i++) await arriveVisitor()
    let board = await api.board()
    expect(board.visits.map((v) => v.waitingReason)).toEqual([null, null, null, 'AwaitingConfirmation'])
    sessionId = await freshRun(db)
    for (const p of (await api.board()).associates) await offFloor(p.participantId)
    await arriveVisitor()
    board = await api.board()
    expect(board.visits[0]).toMatchObject({ status: 'Waiting', waitingReason: 'NoAvailableAssociates' })
    // Departed visitors have no waiting reason.
    await api.request('POST', `/api/visits/${board.visits[0]!.visitId}/departure`, { sessionId, outcome: 'NoSale' })
    expect((await api.board()).visits[0]!.waitingReason).toBeNull()
  })

  it('is idempotent by state and never undoes an acceptance', async () => {
    const visit = await arriveVisitor()
    await reject(visit.assignmentId!)
    const counts = await tableCounts(db)
    const replay = await reject(visit.assignmentId!)
    expect(replay.body).toEqual({ sessionId, assignmentId: visit.assignmentId, visitId: visit.visitId, status: 'Assigned', replayed: true })
    expect(await tableCounts(db)).toEqual(counts)
    const late = await accept(visit.assignmentId!)
    expect([late.status, late.body.code]).toEqual([409, 'INVALID_TRANSITION'])
    expect(late.body.message).toMatch(/rejected/)

    const current = (await api.board()).visits[0]!.assignmentId!
    await accept(current)
    const conflict = await reject(current)
    expect([conflict.status, conflict.body.code]).toEqual([409, 'INVALID_TRANSITION'])
    expect((await api.board()).assignments.find((a) => a.assignmentId === current)!.phase).toBe('Accepted')
  })

  it('replays for an offer already closed by departure', async () => {
    const visit = await arriveVisitor()
    await api.request('POST', `/api/visits/${visit.visitId}/departure`, { sessionId, outcome: 'NoSale' })
    const response = await reject(visit.assignmentId!)
    expect(response.body).toMatchObject({ status: 'Completed', replayed: true })
    const board = await api.board()
    expect(board.assignments[0]!.completionReason).toBe('Departure')
  })

  it('departure after a rejection closes only the live assignment', async () => {
    const visit = await arriveVisitor()
    const first = visit.assignmentId!
    await reject(first)
    const live = (await api.board()).visits[0]!.assignmentId!
    await api.request('POST', `/api/visits/${visit.visitId}/departure`, { sessionId, outcome: 'Sale' })
    const board = await api.board()
    expect(board.assignments.find((a) => a.assignmentId === first)!.completionReason).toBe('Rejected')
    expect(board.assignments.find((a) => a.assignmentId === live)!.completionReason).toBe('Departure')
    expect(board.visits[0]).toMatchObject({ status: 'Completed', outcome: 'Sale', assignmentId: live })
  })

  it('serializes a concurrent accept and reject of the same offer', async () => {
    for (let round = 0; round < 6; round++) {
      sessionId = await freshRun(db)
      const visit = await arriveVisitor()
      const [a, r] = await Promise.all([accept(visit.assignmentId!), reject(visit.assignmentId!)])
      const board = await api.board()
      const original = board.assignments.find((x) => x.assignmentId === visit.assignmentId)!
      if (a.status === 200) {
        expect([r.status, r.body.code]).toEqual([409, 'INVALID_TRANSITION'])
        expect(original.phase).toBe('Accepted')
      } else {
        expect([a.status, a.body.code, r.status]).toEqual([409, 'INVALID_TRANSITION', 200])
        expect(original.completionReason).toBe('Rejected')
      }
      // Never more than one live assignment for the visit.
      expect(board.assignments.filter((x) => x.visitId === visit.visitId && x.completionReason !== 'Rejected')).toHaveLength(1)
    }
  })

  it('validates input and reports unknown or stale targets', async () => {
    await arriveVisitor()
    expect((await reject(randomUUID())).status).toBe(404)
    const malformed = await reject('nope')
    expect([malformed.status, malformed.body.code]).toEqual([400, 'VALIDATION_ERROR'])
    const extra = await api.request('POST', `/api/assignments/${randomUUID()}/reject`, { sessionId, reason: 'busy' })
    expect(extra.status).toBe(400)
    const stale = await reject(randomUUID(), randomUUID())
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_SESSION'])
    const get = await api.request('GET', `/api/assignments/${randomUUID()}/reject`)
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST, OPTIONS'])
    expect((await api.request('POST', `/api/assignments/${randomUUID()}/reject`, { sessionId }, { token: null })).status).toBe(401)
  })

  it('database keeps one live assignment per visit and rejected offers unaccepted', async () => {
    const visit = await arriveVisitor()
    const client = await db.admin.connect()
    try {
      await client.query('begin')
      const participant = (await client.query<{ id: string }>(
        `select id from public.associate_sessions where session_id = $1 and id not in
           (select participant_id from public.assignments where completed_at is null) limit 1`, [sessionId])).rows[0]!.id
      await client.query('savepoint s')
      await expect(client.query(
        `insert into public.assignments (session_id, visit_id, participant_id, assigned_at) values ($1, $2, $3, now())`,
        [sessionId, visit.visitId, participant])).rejects.toThrow(/assignments_one_live_per_visit/)
      await client.query('rollback to savepoint s')
      await expect(client.query(
        `update public.assignments set accepted_at = now(), completed_at = now(), completion_reason = 'Rejected' where id = $1`,
        [visit.assignmentId])).rejects.toThrow(/assignments_rejected_not_accepted/)
      await client.query('rollback to savepoint s')
      // A rejected row plus a new live one is valid.
      await client.query(
        `update public.assignments set completed_at = now(), completion_reason = 'Rejected' where id = $1`, [visit.assignmentId])
      await client.query(
        `insert into public.assignments (session_id, visit_id, participant_id, assigned_at) values ($1, $2, $3, now())`,
        [sessionId, visit.visitId, participant])
    } finally {
      await client.query('rollback')
      client.release()
    }
  })
})
