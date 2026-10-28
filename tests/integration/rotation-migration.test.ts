/**
 * Data migrations applied to databases populated under earlier rotation
 * models: 20261027000900 (exclusive-until-outcome -> per-session gate) and
 * 20261028000100 (per-session gate -> per-associate gate, move at offer).
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { adminUrl, createDatabase, dropDatabase, migrate } from '../../scripts/lib/postgres.js'

const BEFORE_REVISION = '20261027000800_reset.sql'
const PER_SESSION_REVISION = '20261027000900_advance_on_acceptance.sql'

let port: number
let name: string
let admin: pg.Pool

beforeAll(async () => {
  port = inject('pgPort')
  name = `upb_mig_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await createDatabase(port, name)
  await migrate(port, name, { through: BEFORE_REVISION })
  admin = new pg.Pool({ connectionString: adminUrl(port, name), max: 2 })
})

afterAll(async () => {
  await admin.end()
  await dropDatabase(port, name)
})

async function sql<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await admin.query<T>(text, params)).rows
}

const session = async () => (await sql<{ id: string }>('select current_session_id as id from public.demo_control'))[0]!.id

async function arrive(sessionId: string): Promise<void> {
  await sql(
    `select public.upb_register_arrival(p_session_id => $1, p_event_id => $2, p_source => 'Manual', p_detected_at => null,
       p_upper_description => '', p_lower_description => '', p_accessory_description => null,
       p_age_group => 'Unknown', p_gender => 'Unknown')`,
    [sessionId, randomUUID()],
  )
}

describe('rotation data migrations', () => {
  it('stops with a report when a run has several pending offers, changing nothing', async () => {
    const sessionId = await session()
    // Old model: three arrivals -> three simultaneous pending offers.
    for (let i = 0; i < 4; i++) await arrive(sessionId)
    expect((await sql(`select count(*)::int as n from public.assignments where accepted_at is null`))[0].n).toBe(3)

    await expect(migrate(port, name, { through: PER_SESSION_REVISION })).rejects.toThrow(/Rotation migration stopped: session .* has 3 pending offers/)
    const index = await sql(`select indexname from pg_indexes where tablename = 'assignments' and indexname like 'assignments_one_%'`)
    expect(index.map((r) => r.indexname)).toEqual(['assignments_one_unfinished_per_participant'])
    const states = await sql(`select state from public.associate_sessions order by state`)
    expect(states.map((r) => r.state)).toEqual(['PendingAcceptance', 'PendingAcceptance', 'PendingAcceptance'])
  })

  it('after reconciliation migrates states, keeps accepted work and enforces one pending offer', async () => {
    const sessionId = await session()
    const pending = await sql<{ id: string }>(
      `select g.id from public.assignments g join public.visits v on v.id = g.visit_id
       where g.accepted_at is null order by v.arrival_order`,
    )
    // Reconcile by accepting two of the three offers (old model: OnUP).
    for (const row of pending.slice(0, 2)) {
      await sql(`select public.upb_accept_assignment(p_session_id => $1, p_assignment_id => $2)`, [sessionId, row.id])
    }

    await migrate(port, name, { through: PER_SESSION_REVISION })

    const participants = await sql<{ state: string; queue_order: string }>(
      `select p.state, p.queue_order from public.associate_sessions p
       join public.associates a on a.id = p.associate_id order by a.initial_rotation_order`,
    )
    expect(participants.map((p) => [p.state, Number(p.queue_order)])).toEqual([
      ['Available', 1],
      ['Available', 2],
      ['Available', 3],
    ])
    const assignments = await sql(`select accepted_at, completed_at from public.assignments order by assigned_at`)
    expect(assignments.filter((a) => a.accepted_at !== null)).toHaveLength(2)
    expect(assignments.every((a) => a.completed_at === null)).toBe(true)

    const board = (await sql(`select public.upb_get_board() as b`))[0].b
    expect(board.associates.map((a: any) => [a.state, a.activeTurns, a.pendingAssignmentId !== null])).toEqual([
      ['Available', 1, false],
      ['Available', 1, false],
      ['Available', 0, true],
    ])
    expect(board.associates[0]).not.toHaveProperty('currentAssignmentId')

    // The fourth visitor still waits behind the remaining pending offer.
    expect(board.visits.map((v: any) => v.status)).toEqual(['Accepted', 'Accepted', 'Assigned', 'Waiting'])
    await expect(
      sql(`insert into public.assignments (session_id, visit_id, participant_id, assigned_at)
           select $1, v.id, p.id, now() from public.visits v, public.associate_sessions p
           where v.status = 'Waiting' and p.session_id = $1 limit 1`, [sessionId]),
    ).rejects.toThrow(/assignments_one_pending_offer_per_session/)
  })

  it('per-associate migration moves the pending owner, offers Waiting visitors to eligible associates', async () => {
    // State from the previous test: Alex and Jamie hold accepted work, Morgan
    // holds the run's single pending offer (V3), V4 is Waiting.
    await migrate(port, name)

    const board = (await sql(`select public.upb_get_board() as b`))[0].b
    const byName = Object.fromEntries(board.associates.map((a: any) => [a.displayName, a]))
    // Morgan moved to the bottom for the existing offer; then V4 was offered
    // to the front eligible associate (Alex), who moved to the bottom too.
    expect(board.associates.map((a: any) => [a.displayName, a.queuePosition])).toEqual([
      ['Alex', 3],
      ['Jamie', 1],
      ['Morgan', 2],
    ])
    const v4 = board.visits[3]
    expect(v4.status).toBe('Assigned')
    expect(byName.Alex.pendingAssignmentId).toBe(v4.assignmentId)
    expect(byName.Alex.activeTurns).toBe(1)
    expect(byName.Morgan.pendingAssignmentId).not.toBeNull()
    expect(byName.Jamie.pendingAssignmentId).toBeNull()

    const index = await sql(`select indexname from pg_indexes where tablename = 'assignments' and indexname like 'assignments_one_%'`)
    expect(index.map((r) => r.indexname)).toEqual(['assignments_one_pending_offer_per_participant'])
    // A second pending offer for Alex is rejected; one for Jamie would be valid.
    const sessionId = await session()
    await sql(`insert into public.visits (session_id, arrival_event_id, arrived_at, source, status, upper_description,
                 lower_description, accessory_description, age_group, gender, attributes_source, enrichment_status)
               values ($1, gen_random_uuid(), now(), 'Manual', 'Assigned', '', '', null, 'Unknown', 'Unknown', 'Manual', 'NotRequested')`,
      [sessionId])
    await expect(
      sql(`insert into public.assignments (session_id, visit_id, participant_id, assigned_at)
           select $1, v.id, $2, now() from public.visits v
           where v.session_id = $1 and not exists (select 1 from public.assignments g where g.visit_id = v.id)`,
        [sessionId, byName.Alex.participantId]),
    ).rejects.toThrow(/assignments_one_pending_offer_per_participant/)
  })
})
