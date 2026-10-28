import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { VisitorAttributes } from '../../src/contracts/index.js'
import { attributes, createTestApi, freshRun, tableCounts, type TestApi } from '../support/api.js'
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

const accept = (assignmentId: string) =>
  api.request('POST', `/api/assignments/${assignmentId}/accept`, { sessionId })
const outcome = (assignmentId: string, value: string) =>
  api.request('POST', `/api/assignments/${assignmentId}/outcome`, { sessionId, outcome: value })
const depart = (visitId: string, value?: string | null) =>
  api.request('POST', `/api/visits/${visitId}/departure`, value === undefined ? { sessionId } : { sessionId, outcome: value })
const patchAttributes = (visitId: string, attrs: VisitorAttributes, extra: Record<string, unknown> = {}) =>
  api.request('PATCH', `/api/visits/${visitId}/attributes`, {
    sessionId,
    source: 'Manual',
    attributes: attrs,
    enrichmentStatus: 'NotRequested',
    ...extra,
  })

async function arriveVisitor(eventId = randomUUID()) {
  const response = await api.arrive(sessionId, {}, eventId)
  const board = await api.board()
  const visit = board.visits.find((v) => v.visitId === response.body.visitId)!
  return { visitId: visit.visitId, assignmentId: visit.assignmentId, eventId }
}

const visitOf = async (visitId: string) => (await api.board()).visits.find((v) => v.visitId === visitId)!

describe('PATCH /api/visits/{id}/attributes', () => {
  it('replaces the profile only, without touching lifecycle, result, times or queue', async () => {
    const { visitId, eventId } = await arriveVisitor()
    const before = await api.board()
    const corrected = attributes({ upperDescription: ' Green coat ', accessoryDescription: '', ageGroup: 'Age60Plus', gender: 'Female' })
    const response = await patchAttributes(visitId, corrected)
    expect(response.status).toBe(200)
    const expectedAttributes = { ...corrected, upperDescription: 'Green coat', accessoryDescription: null }
    expect(response.body).toEqual({
      sessionId,
      visitId,
      attributes: expectedAttributes,
      attributesSource: 'Manual',
      enrichmentStatus: 'NotRequested',
      ignored: false,
    })
    const after = await api.board()
    const { attributes: _a, ...visitBefore } = before.visits[0]!
    const { attributes: newAttributes, ...visitAfter } = after.visits[0]!
    expect(visitAfter).toEqual(visitBefore)
    expect(newAttributes).toEqual(expectedAttributes)
    expect(after.assignments).toEqual(before.assignments)
    expect(after.associates).toEqual(before.associates)
    expect(after.activity[0]!.kind).toBe('VisitorAttributesUpdated')

    // Unchanged replacement: same profile back, no activity.
    const counts = await tableCounts(db)
    const again = await patchAttributes(visitId, expectedAttributes)
    expect(again.body.attributes).toEqual(expectedAttributes)
    expect(await tableCounts(db)).toEqual(counts)

    // Arrival replay still compares against the immutable original payload.
    const replay = await api.arrive(sessionId, {}, eventId)
    expect(replay.body).toMatchObject({ visitId, duplicate: true })
    expect((await api.arrive(sessionId, { gender: 'Female' }, eventId)).body.code).toBe('REPLAY_CONFLICT')
  })

  it('is allowed after departure and validates the Stage 1 body', async () => {
    const { visitId } = await arriveVisitor()
    await depart(visitId, 'NoSale')
    expect((await patchAttributes(visitId, attributes({ lowerDescription: 'Shorts' }))).status).toBe(200)
    expect((await visitOf(visitId)).attributes.lowerDescription).toBe('Shorts')

    const cases: Array<[string, Promise<{ status: number; body: any }>]> = [
      ['CV source', patchAttributes(visitId, attributes(), { source: 'CV' })],
      ['enrichment', patchAttributes(visitId, attributes(), { enrichmentStatus: 'Complete' })],
      ['lifecycle field', patchAttributes(visitId, attributes(), { outcome: 'Sale' })],
      ['partial profile', api.request('PATCH', `/api/visits/${visitId}/attributes`, {
        sessionId, source: 'Manual', enrichmentStatus: 'NotRequested', attributes: { ageGroup: 'Unknown' },
      })],
      ['bad id', api.request('PATCH', '/api/visits/123/attributes', {
        sessionId, source: 'Manual', enrichmentStatus: 'NotRequested', attributes: attributes(),
      })],
    ]
    for (const [name, pending] of cases) {
      const response = await pending
      expect([response.status, response.body.code], name).toEqual([400, 'VALIDATION_ERROR'])
    }
    expect((await patchAttributes(randomUUID(), attributes())).status).toBe(404)
    const post = await api.request('POST', `/api/visits/${visitId}/attributes`, {})
    expect([post.status, post.headers.get('allow')]).toEqual([405, 'PATCH, OPTIONS'])
  })
})

describe('POST /api/visits/{id}/departure', () => {
  const assignmentOf = async (visitId: string) =>
    (await api.board()).assignments.find((a) => a.visitId === visitId)!
  const queue = async () => (await api.board()).associates.map((a) => a.queuePosition)

  it('Waiting visitor: requires a result, creates no assignment, Sale counts without assignment', async () => {
    for (let i = 0; i < 3; i++) await arriveVisitor() // every associate holds an offer
    const later = await arriveVisitor()
    const waiting = await arriveVisitor()
    expect(waiting.assignmentId).toBeNull()

    const required = await depart(waiting.visitId)
    expect([required.status, required.body.code]).toEqual([400, 'OUTCOME_REQUIRED'])
    expect((await depart(waiting.visitId, null)).body.code).toBe('OUTCOME_REQUIRED')

    const before = await tableCounts(db)
    const response = await depart(waiting.visitId, 'Sale')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ sessionId, visitId: waiting.visitId, departedAt: expect.any(String), outcome: 'Sale', replayed: false })
    expect(await tableCounts(db)).toEqual({ ...before, activity: before.activity + 1 })

    const board = await api.board()
    expect(board.visits[4]).toMatchObject({ status: 'Completed', outcome: 'Sale', departedAt: response.body.departedAt, waitingPosition: null, assignmentId: null })
    expect(board.visits.find((v) => v.visitId === later.visitId)!.waitingPosition).toBe(1)
    expect(board.activity[0]).toMatchObject({ kind: 'VisitorDeparted', visitId: waiting.visitId, participantId: null, assignmentId: null })
    expect(board.metrics).toEqual({ visitors: 5, assignedTurns: 3, acceptedTurns: 0, closedSales: 1, conversionRate: 20 })
  })

  it('pending offer: closes with Departure, does not move the queue, frees only that associate', async () => {
    const first = await arriveVisitor() // Alex, moved to the bottom at offer time
    const before = await api.board()
    expect(before.associates.map((a) => a.queuePosition)).toEqual([3, 1, 2])
    const response = await depart(first.visitId, 'NoSale')
    expect(response.status).toBe(200)

    const board = await api.board()
    const closed = board.assignments.find((a) => a.assignmentId === first.assignmentId)!
    expect(closed).toMatchObject({ phase: 'Completed', completionReason: 'Departure', acceptedAt: null })
    expect(board.associates.map((a) => a.queuePosition)).toEqual([3, 1, 2])
    expect(board.associates[0]).toMatchObject({ pendingAssignmentId: null, assignedTurns: 1, acceptedTurns: 0 })
    expect(board.activity.slice(0, 2).map((a) => a.kind)).toEqual(['TurnCompleted', 'VisitorDeparted'])

    expect((await accept(first.assignmentId!)).body.code).toBe('INVALID_TRANSITION')
    expect((await outcome(first.assignmentId!, 'NoSale')).body.code).toBe('INVALID_TRANSITION')
  })

  it('pending offer departure lets the freed associate take the next Waiting visitor', async () => {
    const offers = []
    for (let i = 0; i < 3; i++) offers.push(await arriveVisitor())
    const waiting = await arriveVisitor()
    await depart(offers[0]!.visitId, 'NoSale')
    const board = await api.board()
    const next = board.assignments.find((a) => a.visitId === waiting.visitId)!
    const alex = board.associates[0]!
    expect(next.participantId).toBe(alex.participantId)
    // The new offer (not the departure) moves Alex to the bottom; B and C keep their offers.
    expect(board.associates.map((a) => a.queuePosition)).toEqual([3, 1, 2])
    expect(board.associates.map((a) => a.pendingAssignmentId)).toEqual([next.assignmentId, offers[1]!.assignmentId, offers[2]!.assignmentId])
    expect(board.activity.slice(0, 3).map((a) => a.kind)).toEqual(['AssignmentCreated', 'TurnCompleted', 'VisitorDeparted'])
    expect(board.metrics).toMatchObject({ assignedTurns: 4, acceptedTurns: 0 })
  })

  it('accepted assignment: closes with Departure, keeps acceptedAt, does not move rotation', async () => {
    const { visitId, assignmentId } = await arriveVisitor()
    await accept(assignmentId!)
    const before = await api.board()
    await depart(visitId, 'Sale')
    const board = await api.board()
    expect(board.assignments[0]).toMatchObject({ completionReason: 'Departure', acceptedAt: before.assignments[0]!.acceptedAt })
    expect(board.visits[0]).toMatchObject({ status: 'Completed', outcome: 'Sale' })
    expect(board.associates.map((a) => a.queuePosition)).toEqual([3, 1, 2])
    expect(board.associates[0]).toMatchObject({ activeAssignmentIds: [], activeTurns: 0 })
    expect(board.metrics).toMatchObject({ acceptedTurns: 1, closedSales: 1 })
  })

  it('accepted work exit leaves the same associate\'s new pending offer untouched', async () => {
    // Only Alex is on the floor, so Alex accepts V1 and is offered V2.
    const roster = (await api.board()).associates
    for (const p of roster.slice(1)) {
      await api.request('POST', '/api/availability', { sessionId, participantId: p.participantId, commandId: randomUUID(), state: 'OffFloor' })
    }
    const v1 = await arriveVisitor()
    await accept(v1.assignmentId!)
    const v2 = await arriveVisitor()
    const before = await api.board()
    expect(before.associates[0]).toMatchObject({ pendingAssignmentId: v2.assignmentId, activeAssignmentIds: [v1.assignmentId] })
    await depart(v1.visitId, 'NoSale')
    const after = await api.board()
    expect(after.associates[0]).toMatchObject({ pendingAssignmentId: v2.assignmentId, activeAssignmentIds: [], queuePosition: 1 })
    expect(after.assignments.find((a) => a.assignmentId === v2.assignmentId)!.phase).toBe('PendingAcceptance')
  })

  it('completed service: preserves the result and never touches the associate or rotation', async () => {
    const { visitId, assignmentId } = await arriveVisitor()
    await accept(assignmentId!)
    await outcome(assignmentId!, 'Sale')
    // B and C accept, then Alex is offered a new visitor.
    for (let i = 0; i < 2; i++) {
      const v = await arriveVisitor()
      await accept(v.assignmentId!)
    }
    const third = await arriveVisitor()
    const before = await api.board()
    const alex = before.associates[0]!
    expect((await assignmentOf(third.visitId)).participantId).toBe(alex.participantId)

    const conflict = await depart(visitId, 'NoSale')
    expect([conflict.status, conflict.body.code]).toEqual([409, 'OUTCOME_CONFLICT'])
    const response = await depart(visitId)
    expect(response.body).toMatchObject({ outcome: 'Sale', replayed: false })

    const after = await api.board()
    expect(after.associates).toEqual(before.associates)
    expect(after.assignments).toEqual(before.assignments)
    expect(after.activity.slice(0, 1).map((a) => a.kind)).toEqual(['VisitorDeparted'])
    expect(after.visits[0]).toMatchObject({ status: 'Completed', outcome: 'Sale', outcomeRecordedAt: before.visits[0]!.outcomeRecordedAt })
    expect((await outcome(assignmentId!, 'Sale')).body.replayed).toBe(true)
  })

  it('duplicate exit keeps the original time/result; conflicting duplicate is rejected', async () => {
    const { visitId } = await arriveVisitor()
    const first = await depart(visitId, 'NoSale')
    const counts = await tableCounts(db)
    const again = await depart(visitId)
    expect(again.body).toEqual({ ...first.body, replayed: true })
    expect((await depart(visitId, 'NoSale')).body.replayed).toBe(true)
    expect((await depart(visitId, 'Sale')).body.code).toBe('OUTCOME_CONFLICT')
    expect(await tableCounts(db)).toEqual(counts)
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => depart(visitId)))
    expect(concurrent.every((r) => r.body.departedAt === first.body.departedAt)).toBe(true)
  })

  it('concurrent outcome and exit on an accepted turn stay consistent and never move rotation', async () => {
    for (let round = 0; round < 6; round++) {
      sessionId = await freshRun(db)
      const { visitId, assignmentId } = await arriveVisitor()
      await accept(assignmentId!)
      const [o, d] = await Promise.all([outcome(assignmentId!, 'Sale'), depart(visitId, 'NoSale')])
      const board = await api.board()
      const visit = board.visits[0]!
      if (o.status === 200) {
        expect([d.status, d.body.code]).toEqual([409, 'OUTCOME_CONFLICT'])
        expect(visit).toMatchObject({ outcome: 'Sale', departedAt: null })
      } else {
        expect([o.status, o.body.code, d.status]).toEqual([409, 'INVALID_TRANSITION', 200])
        expect(visit).toMatchObject({ outcome: 'NoSale', departedAt: expect.any(String) })
      }
      expect(board.activity.filter((a) => a.kind === 'TurnCompleted')).toHaveLength(1)
      expect(await queue()).toEqual([3, 1, 2])
    }
  })

  it('returns NOT_FOUND, STALE_SESSION and VALIDATION_ERROR', async () => {
    const { visitId } = await arriveVisitor()
    expect((await depart(randomUUID(), 'Sale')).status).toBe(404)
    expect((await depart(visitId, 'Maybe')).status).toBe(400)
    const stale = await api.request('POST', `/api/visits/${visitId}/departure`, { sessionId: randomUUID(), outcome: 'Sale' })
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_SESSION'])
    const extra = await api.request('POST', `/api/visits/${visitId}/departure`, { sessionId, outcome: 'Sale', departedAt: 'x' })
    expect(extra.status).toBe(400)
    expect((await visitOf(visitId)).departedAt).toBeNull()
  })
})
