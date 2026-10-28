/**
 * npm run acceptance
 *
 * Scriptable Stage 1 acceptance run over real HTTP against a running API
 * (local dev server or a deployment). DESTRUCTIVE: it resets the demo run
 * first. Only point it at a disposable/demo environment.
 *
 * Environment: API_BASE_URL (default http://localhost:3000),
 * DEMO_OPERATOR_TOKEN (required; also read from .env.local / .env).
 *
 * Scenario (Session Handoffs "Manual end-to-end integration"): open board ->
 * add visitor -> Accept -> Sale -> mark exit -> mark associates Off Floor ->
 * add Waiting visitor -> exit without assignment -> restore capacity ->
 * exit after the associate started another turn -> replays/stale -> reset ->
 * Advance on Acceptance regression (A -> B -> C -> A, confirmation gate,
 * pending-offer departure) -> reset.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BoardSnapshot } from '../src/contracts/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const file of ['.env.local', '.env']) {
  const full = path.join(root, file)
  if (existsSync(full)) process.loadEnvFile(full)
}

const base = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const token = process.env.DEMO_OPERATOR_TOKEN
if (!token) {
  console.error('DEMO_OPERATOR_TOKEN is required')
  process.exit(2)
}

let step = 0
function check(condition: unknown, description: string): void {
  step += 1
  if (!condition) {
    console.error(`  FAIL ${step}. ${description}`)
    throw new Error(`Acceptance failed at step ${step}: ${description}`)
  }
  console.log(`  ok   ${step}. ${description}`)
}

async function call(method: string, route: string, body?: unknown, auth = true) {
  const headers: Record<string, string> = {}
  if (auth) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null }
}

const board = async (): Promise<BoardSnapshot> => (await call('GET', '/api/board')).body
const attributes = (upper: string) => ({
  upperDescription: upper,
  lowerDescription: 'Jeans',
  accessoryDescription: null,
  ageGroup: 'From20To39',
  gender: 'Unknown',
})

async function main(): Promise<void> {
  console.log(`Acceptance run against ${base}`)

  // US-06 first, so the run starts clean and deterministic.
  const initial = await board()
  let sid = (await call('POST', '/api/demo/reset', { sessionId: initial.session.sessionId })).body.sessionId as string

  console.log('US-01 board')
  check((await call('GET', '/api/board', undefined, false)).status === 401, 'board requires the operator token')
  let b = await board()
  check(b.session.sessionId === sid, 'board reports the new run')
  check(b.associates.map((a) => a.displayName).join() === 'Alex,Jamie,Morgan', 'deterministic roster order')
  check(b.associates.map((a) => a.queuePosition).join() === '1,2,3', 'all Available in initial order')
  check(b.metrics.visitors === 0 && b.metrics.conversionRate === 0, 'empty run has zero metrics')
  const [alex, jamie, morgan] = b.associates.map((a) => a.participantId) as [string, string, string]

  console.log('US-02 manual arrival')
  const eventId = randomUUID()
  const arrival = await call('POST', '/api/arrivals', { sessionId: sid, eventId, source: 'Manual', detectedAt: null, attributes: attributes('Red coat') })
  check(arrival.status === 201 && arrival.body.status === 'Assigned', 'visitor registered and assigned (201)')
  const replay = await call('POST', '/api/arrivals', { sessionId: sid, eventId, source: 'Manual', detectedAt: null, attributes: attributes('Red coat') })
  check(replay.status === 200 && replay.body.duplicate && replay.body.visitId === arrival.body.visitId, 'identical retry returns the same visit')
  b = await board()
  check(b.visits.length === 1 && b.assignments[0]!.participantId === alex, 'one visit, reserved to Alex')
  const v1 = arrival.body.visitId as string
  const a1 = b.assignments[0]!.assignmentId

  console.log('US-03 accept and Sale')
  check((await call('POST', `/api/assignments/${a1}/accept`, { sessionId: sid })).body.phase === 'Accepted', 'accept UP')
  check((await call('POST', `/api/assignments/${a1}/outcome`, { sessionId: sid, outcome: 'Sale' })).status === 200, 'record Sale')
  check((await call('POST', `/api/assignments/${a1}/outcome`, { sessionId: sid, outcome: 'NoSale' })).body.code === 'OUTCOME_CONFLICT', 'conflicting outcome rejected')
  b = await board()
  check(b.visits[0]!.outcome === 'Sale' && b.visits[0]!.departedAt === null, 'Sale stored on Visit; visitor still inside')
  check(b.associates[0]!.queuePosition === 3, 'Alex moved to the bottom once, on acceptance')
  check(b.associates.every((a) => a.state === 'Available'), 'availability unchanged by accepted work')
  check(b.metrics.closedSales === 1 && b.metrics.conversionRate === 100, 'metrics: 1 sale / 1 visit = 100%')

  console.log('US-04 exit after completed service')
  const exit = await call('POST', `/api/visits/${v1}/departure`, { sessionId: sid })
  check(exit.status === 200 && exit.body.outcome === 'Sale', 'exit preserves the stored Sale')
  const exitAgain = await call('POST', `/api/visits/${v1}/departure`, { sessionId: sid })
  check(exitAgain.body.replayed && exitAgain.body.departedAt === exit.body.departedAt, 'duplicate exit keeps the original time')

  console.log('US-05 availability and Waiting')
  for (const id of [alex, jamie, morgan]) {
    const r = await call('POST', '/api/availability', { sessionId: sid, participantId: id, commandId: randomUUID(), state: 'OffFloor' })
    check(r.status === 200, 'associate marked Off Floor')
  }
  const w1 = await call('POST', '/api/arrivals', { sessionId: sid, eventId: randomUUID(), source: 'Manual', attributes: attributes('Waiting A') })
  const w2 = await call('POST', '/api/arrivals', { sessionId: sid, eventId: randomUUID(), source: 'Manual', attributes: attributes('Waiting B') })
  check(w1.body.status === 'Waiting' && w2.body.status === 'Waiting', 'visitors wait while everyone is Off Floor')
  check((await call('POST', `/api/visits/${w1.body.visitId}/departure`, { sessionId: sid })).body.code === 'OUTCOME_REQUIRED', 'exit without result requires Sale/NoSale')
  const noAssignmentExit = await call('POST', `/api/visits/${w1.body.visitId}/departure`, { sessionId: sid, outcome: 'NoSale' })
  check(noAssignmentExit.status === 200, 'Waiting visitor exits without an assignment')
  b = await board()
  check(b.assignments.length === 1, 'no fictitious assignment was created')

  const restoreCommand = randomUUID()
  const restore = await call('POST', '/api/availability', { sessionId: sid, participantId: morgan, commandId: restoreCommand, state: 'Available' })
  check(restore.status === 200, 'Morgan back Available')
  b = await board()
  const w2Visit = b.visits.find((v) => v.visitId === w2.body.visitId)!
  check(w2Visit.status === 'Assigned', 'oldest Waiting visitor still inside is dispatched on return')
  const retry = await call('POST', '/api/availability', { sessionId: sid, participantId: morgan, commandId: restoreCommand, state: 'Available' })
  check(retry.body.replayed === true, 'availability retry is a replay')

  console.log('US-04 exit after the associate started another turn')
  const morganTurn = b.assignments.find((a) => a.visitId === w2Visit.visitId)!.assignmentId
  await call('POST', `/api/assignments/${morganTurn}/accept`, { sessionId: sid })
  await call('POST', `/api/assignments/${morganTurn}/outcome`, { sessionId: sid, outcome: 'NoSale' })
  const next = await call('POST', '/api/arrivals', { sessionId: sid, eventId: randomUUID(), source: 'Manual', attributes: attributes('Next') })
  check(next.body.status === 'Assigned', 'Morgan received a new turn')
  const before = await board()
  await call('POST', `/api/visits/${w2Visit.visitId}/departure`, { sessionId: sid })
  const after = await board()
  check(JSON.stringify(after.associates) === JSON.stringify(before.associates), 'completed visitor exit does not touch Morgan')

  console.log('US-06 reset and stale requests')
  const reset = await call('POST', '/api/demo/reset', { sessionId: sid })
  check(reset.status === 200 && reset.body.sessionId !== sid, 'reset creates a new run identity')
  const stale = await call('POST', '/api/arrivals', { sessionId: sid, eventId: randomUUID(), source: 'Manual', attributes: attributes('Late') })
  check(stale.status === 409 && stale.body.code === 'STALE_SESSION', 'old-run command rejected')
  check((await call('POST', '/api/demo/reset', { sessionId: sid })).body.code === 'STALE_SESSION', 'replayed old reset rejected')
  sid = reset.body.sessionId
  b = await board()
  check(b.visits.length === 0 && b.metrics.visitors === 0 && b.associates.map((a) => a.queuePosition).join() === '1,2,3', 'fresh board with initial roster order')

  console.log('Advance on Acceptance rotation')
  const ids = b.associates.map((a) => a.participantId)
  const visits: string[] = []
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/api/arrivals', { sessionId: sid, eventId: randomUUID(), source: 'Manual', attributes: attributes(`R${i + 1}`) })
    visits.push(r.body.visitId)
  }
  b = await board()
  check(b.assignments.length === 1 && b.visits.filter((v) => v.status === 'Waiting').length === 3, 'one pending offer gates later arrivals')
  check(b.associates.map((a) => a.queuePosition).join() === '1,2,3', 'offer creation keeps the queue')
  const offerOf = (snapshot: BoardSnapshot, visitId: string) => snapshot.assignments.find((a) => a.visitId === visitId)!
  for (let i = 0; i < 3; i++) {
    const offer = offerOf(b, visits[i]!)
    check(offer.participantId === ids[i], `V${i + 1} offered to ${b.associates[i]!.displayName}`)
    await call('POST', `/api/assignments/${offer.assignmentId}/accept`, { sessionId: sid })
    b = await board()
  }
  const fourth = offerOf(b, visits[3]!)
  check(fourth.participantId === ids[0], 'V4 offered to Alex while V1 is still unfinished')
  check(b.associates[0]!.activeTurns === 1 && b.associates[0]!.pendingAssignmentId === fourth.assignmentId, 'Alex shows one active turn and the pending offer')
  check((await call('POST', '/api/availability', { sessionId: sid, participantId: ids[0], commandId: randomUUID(), state: 'OffFloor' })).body.code === 'INVALID_TRANSITION', 'offer owner cannot go Off Floor')
  const order = b.associates.map((a) => a.queuePosition).join()
  await call('POST', `/api/assignments/${offerOf(b, visits[0]!).assignmentId}/outcome`, { sessionId: sid, outcome: 'Sale' })
  check((await board()).associates.map((a) => a.queuePosition).join() === order, 'Sale on V1 does not change queue order')
  await call('POST', `/api/visits/${visits[3]}/departure`, { sessionId: sid, outcome: 'NoSale' })
  b = await board()
  check(b.associates.map((a) => a.queuePosition).join() === order && b.associates[0]!.pendingAssignmentId === null, 'pending V4 departure clears the gate without consuming Alex\'s turn')

  const last = await call('POST', '/api/demo/reset', { sessionId: sid })
  check(last.status === 200, 'final reset leaves a clean board')

  console.log(`\nAll ${step} acceptance checks passed.`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
