import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { inject } from 'vitest'
import { adminUrl, backendUrl, createDatabase, dropDatabase, migrate } from '../../scripts/lib/postgres.js'

export interface TestDatabase {
  name: string
  port: number
  /** Superuser pool for arranging/inspecting state; never used by the API. */
  admin: pg.Pool
  /** Connection string of the backend login role (acts as service_role). */
  backendUrl: string
  close(): Promise<void>
}

/** A fresh, fully migrated and seeded database for one test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const port = inject('pgPort')
  const name = `upb_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await createDatabase(port, name)
  await migrate(port, name)
  const admin = new pg.Pool({ connectionString: adminUrl(port, name), max: 4 })
  return {
    name,
    port,
    admin,
    backendUrl: backendUrl(port, name),
    async close() {
      await admin.end()
      await dropDatabase(port, name)
    },
  }
}

export const SEEDED_ASSOCIATES = [
  { associateId: 'a55c0000-0000-4000-8000-000000000001', displayName: 'Alex' },
  { associateId: 'a55c0000-0000-4000-8000-000000000002', displayName: 'Jamie' },
  { associateId: 'a55c0000-0000-4000-8000-000000000003', displayName: 'Morgan' },
] as const

export async function currentSessionId(db: TestDatabase): Promise<string> {
  const result = await db.admin.query<{ id: string }>(
    'select current_session_id as id from public.demo_control where id = 1',
  )
  const id = result.rows[0]?.id
  if (!id) throw new Error('no current session')
  return id
}
