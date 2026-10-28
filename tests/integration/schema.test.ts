import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { migrate } from '../../scripts/lib/postgres.js'
import { createTestDatabase, currentSessionId, SEEDED_ASSOCIATES, type TestDatabase } from '../support/testDatabase.js'

let db: TestDatabase

beforeAll(async () => {
  db = await createTestDatabase()
})

afterAll(async () => {
  await db.close()
})

/** Runs statements inside a transaction that is always rolled back. */
async function inRollback(fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await db.admin.connect()
  try {
    await client.query('begin')
    await fn(client)
  } finally {
    await client.query('rollback')
    client.release()
  }
}

async function expectRejected(sql: string, params: unknown[] = [], pattern?: RegExp): Promise<void> {
  await inRollback(async (client) => {
    await expect(client.query(sql, params)).rejects.toThrow(pattern)
  })
}

async function participants(sessionId: string) {
  const result = await db.admin.query<{ id: string; associate_id: string; state: string; queue_order: string | null }>(
    `select p.id, p.associate_id, p.state, p.queue_order
     from public.associate_sessions p join public.associates a on a.id = p.associate_id
     where p.session_id = $1 order by a.initial_rotation_order`,
    [sessionId],
  )
  return result.rows
}

const VISIT_COLUMNS = `session_id, arrival_event_id, arrived_at, source, status, upper_description,
  lower_description, accessory_description, age_group, gender, attributes_source, enrichment_status`

describe('seeded setup', () => {
  it('creates one control row, an active run and the deterministic roster in initial order', async () => {
    const sessionId = await currentSessionId(db)
    const session = await db.admin.query('select started_at from public.demo_sessions where id = $1', [sessionId])
    expect(session.rows[0]?.started_at).toBeInstanceOf(Date)
    expect((await db.admin.query('select count(*)::int as n from public.demo_control')).rows[0].n).toBe(1)

    const rows = await participants(sessionId)
    expect(rows.map((row) => row.associate_id)).toEqual(SEEDED_ASSOCIATES.map((a) => a.associateId))
    expect(rows.every((row) => row.state === 'Available')).toBe(true)
    expect(rows.map((row) => Number(row.queue_order))).toEqual([1, 2, 3])
  })

  it('re-running migrations and seed never erases an active demo', async () => {
    const sessionId = await currentSessionId(db)
    await db.admin.query(
      `insert into public.visits (${VISIT_COLUMNS})
       values ($1, gen_random_uuid(), now(), 'Manual', 'Waiting', '', '', null, 'Unknown', 'Unknown', 'Manual', 'NotRequested')`,
      [sessionId],
    )
    await migrate(db.port, db.name)
    await db.admin.query(`select upb_private.ensure_demo_setup()`)

    expect(await currentSessionId(db)).toBe(sessionId)
    const visits = await db.admin.query('select count(*)::int as n from public.visits where session_id = $1', [sessionId])
    expect(visits.rows[0].n).toBe(1)
    expect((await db.admin.query('select count(*)::int as n from public.associates')).rows[0].n).toBe(3)
    await db.admin.query('delete from public.visits where session_id = $1', [sessionId])
  })
})

describe('integrity constraints', () => {
  it('allows one pending offer per participant and several accepted unfinished assignments', async () => {
    const sessionId = await currentSessionId(db)
    const [alex, jamie] = await participants(sessionId)
    await inRollback(async (client) => {
      const visits = await client.query<{ id: string }>(
        `insert into public.visits (${VISIT_COLUMNS})
         select $1, gen_random_uuid(), now(), 'Manual', 'Accepted', '', '', null, 'Unknown', 'Unknown', 'Manual', 'NotRequested'
         from generate_series(1, 4) returning id`,
        [sessionId],
      )
      const insert = `insert into public.assignments (session_id, visit_id, participant_id, assigned_at, accepted_at)
                      values ($1, $2, $3, now(), $4)`
      // Two accepted unfinished assignments for Alex are valid.
      await client.query(insert, [sessionId, visits.rows[0]!.id, alex!.id, new Date(Date.now() + 1000)])
      await client.query(insert, [sessionId, visits.rows[1]!.id, alex!.id, new Date(Date.now() + 1000)])
      // Pending offers for different participants coexist; a second one for Alex does not.
      await client.query(insert, [sessionId, visits.rows[2]!.id, alex!.id, null])
      await client.query('savepoint s')
      await expect(client.query(insert, [sessionId, visits.rows[3]!.id, alex!.id, null])).rejects.toThrow(
        /assignments_one_pending_offer_per_participant/,
      )
      await client.query('rollback to savepoint s')
      await client.query(insert, [sessionId, visits.rows[3]!.id, jamie!.id, null])
    })
  })

  it('limits associate availability to Available and OffFloor', async () => {
    const sessionId = await currentSessionId(db)
    const [alex] = await participants(sessionId)
    await expectRejected(
      `update public.associate_sessions set state = 'OnUP', queue_order = null where id = $1`,
      [alex!.id],
      /associate_sessions_state_check/,
    )
  })

  it('rejects links between records of different sessions', async () => {
    const sessionId = await currentSessionId(db)
    const [alex] = await participants(sessionId)
    await inRollback(async (client) => {
      const other = await client.query<{ id: string }>(`insert into public.demo_sessions default values returning id`)
      const visit = await client.query<{ id: string }>(
        `insert into public.visits (${VISIT_COLUMNS})
         values ($1, gen_random_uuid(), now(), 'Manual', 'Assigned', '', '', null, 'Unknown', 'Unknown', 'Manual', 'NotRequested')
         returning id`,
        [other.rows[0]!.id],
      )
      await expect(
        client.query(
          `insert into public.assignments (session_id, visit_id, participant_id, assigned_at) values ($1, $2, $3, now())`,
          [other.rows[0]!.id, visit.rows[0]!.id, alex!.id],
        ),
      ).rejects.toThrow(/foreign key/)
    })
  })

  it('keeps the purchase result rules on Visit', async () => {
    const sessionId = await currentSessionId(db)
    const base = `insert into public.visits (${VISIT_COLUMNS}, outcome, outcome_recorded_at, departed_at) values
      ($1, gen_random_uuid(), now(), 'Manual', $2, '', '', null, 'Unknown', 'Unknown', 'Manual', 'NotRequested', $3, $4, $5)`
    await expectRejected(base, [sessionId, 'Completed', null, null, null], /visits_completed_has_outcome/)
    await expectRejected(base, [sessionId, 'Accepted', 'Sale', new Date(), null], /visits_completed_has_outcome/)
    await expectRejected(base, [sessionId, 'Completed', 'Sale', null, null], /visits_outcome_time/)
    await expectRejected(base, [sessionId, 'Waiting', null, null, new Date()], /visits_departure/)
    await expectRejected(base, [sessionId, 'Completed', 'Maybe', new Date(), null], /check constraint/)
  })

  it('stores descriptions normalized and enums constrained', async () => {
    const sessionId = await currentSessionId(db)
    const sql = `insert into public.visits (${VISIT_COLUMNS}) values
      ($1, gen_random_uuid(), now(), $2, 'Waiting', $3, '', $4, $5, 'Unknown', 'Manual', 'NotRequested')`
    await expectRejected(sql, [sessionId, 'Manual', ' padded', null, 'Unknown'], /visits_upper_description_normalized/)
    await expectRejected(sql, [sessionId, 'Manual', 'x'.repeat(201), null, 'Unknown'], /visits_upper_description_normalized/)
    await expectRejected(sql, [sessionId, 'Manual', '', '', 'Unknown'], /visits_accessory_description_normalized/)
    await expectRejected(sql, [sessionId, 'Manual', '', null, 'Over60'], /check constraint/)
    await expectRejected(sql, [sessionId, 'Camera', '', null, 'Unknown'], /check constraint/)
  })

  it('requires acceptance for OutcomeRecorded completions and ordered milestones', async () => {
    const sessionId = await currentSessionId(db)
    const [alex] = await participants(sessionId)
    await inRollback(async (client) => {
      const visit = await client.query<{ id: string }>(
        `insert into public.visits (${VISIT_COLUMNS})
         values ($1, gen_random_uuid(), now(), 'Manual', 'Assigned', '', '', null, 'Unknown', 'Unknown', 'Manual', 'NotRequested')
         returning id`,
        [sessionId],
      )
      const insert = `insert into public.assignments
        (session_id, visit_id, participant_id, assigned_at, accepted_at, completed_at, completion_reason)
        values ($1, $2, $3, now(), $4, $5, $6)`
      await client.query('savepoint s')
      await expect(
        client.query(insert, [sessionId, visit.rows[0]!.id, alex!.id, null, new Date(Date.now() + 1000), 'OutcomeRecorded']),
      ).rejects.toThrow(/assignments_outcome_requires_acceptance/)
      await client.query('rollback to savepoint s')
      await expect(
        client.query(insert, [sessionId, visit.rows[0]!.id, alex!.id, null, new Date(Date.now() + 1000), null]),
      ).rejects.toThrow(/assignments_completion_reason/)
      await client.query('rollback to savepoint s')
      // Departure may close a pending assignment without acceptance.
      await client.query(insert, [sessionId, visit.rows[0]!.id, alex!.id, null, new Date(Date.now() + 1000), 'Departure'])
    })
  })

  it('ties queue_order presence to the Available state', async () => {
    const sessionId = await currentSessionId(db)
    const [alex] = await participants(sessionId)
    await expectRejected(`update public.associate_sessions set state = 'OffFloor' where id = $1`, [alex!.id], /check constraint/)
    await expectRejected(
      `update public.associate_sessions set queue_order = 2 where id = $1`,
      [alex!.id],
      /associate_sessions_session_id_queue_order_key/,
    )
  })
})

describe('access control', () => {
  it('denies anonymous and authenticated table access and helper execution', async () => {
    for (const role of ['anon', 'authenticated']) {
      await inRollback(async (client) => {
        await client.query(`set local role ${role}`)
        await client.query('savepoint s')
        await expect(client.query('select * from public.visits')).rejects.toThrow(/permission denied/)
        await client.query('rollback to savepoint s')
        await expect(client.query('insert into public.demo_sessions default values')).rejects.toThrow(/permission denied/)
        await client.query('rollback to savepoint s')
        await expect(client.query(`select upb_private.next_queue_order(gen_random_uuid())`)).rejects.toThrow(
          /permission denied/,
        )
      })
    }
  })

  it('lets the backend login act as service_role but not run setup', async () => {
    const client = new pg.Client({ connectionString: db.backendUrl })
    await client.connect()
    try {
      const role = await client.query<{ current_user: string }>('select current_user')
      expect(role.rows[0]?.current_user).toBe('service_role')
      const count = await client.query('select count(*)::int as n from public.associates')
      expect(count.rows[0].n).toBe(3)
      await expect(client.query('select upb_private.ensure_demo_setup()')).rejects.toThrow(/permission denied/)
    } finally {
      await client.end()
    }
  })
})
