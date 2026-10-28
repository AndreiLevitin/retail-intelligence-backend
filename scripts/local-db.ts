/**
 * npm run db:local
 *
 * Starts a persistent local PostgreSQL (data in .local-db/), creates the
 * "upboard" database, applies pending supabase/migrations and the idempotent
 * seed, prints the backend DATABASE_URL and keeps running until Ctrl+C.
 * Re-running keeps existing demo data; use POST /api/demo/reset to restart.
 *
 * Environment: LOCAL_DB_PORT (default 54322).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  REPO_ROOT,
  backendUrl,
  createDatabase,
  databaseExists,
  ensureRoles,
  migrate,
  startCluster,
} from './lib/postgres.js'

const DATABASE = 'upboard'
const port = Number(process.env.LOCAL_DB_PORT ?? 54322)
const dataDir = path.join(REPO_ROOT, '.local-db', 'data')

const cluster = await startCluster({
  dataDir,
  port,
  persistent: true,
  initialise: !existsSync(path.join(dataDir, 'PG_VERSION')),
})
await ensureRoles(port)
if (!(await databaseExists(port, DATABASE))) await createDatabase(port, DATABASE)
const applied = await migrate(port, DATABASE)

console.log(applied.length > 0 ? `Applied migrations:\n  ${applied.join('\n  ')}` : 'Migrations up to date.')
console.log(`\nLocal PostgreSQL is running on port ${port}.`)
console.log(`DATABASE_URL=${backendUrl(port, DATABASE)}`)
console.log('\nPress Ctrl+C to stop.')

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  await cluster.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
setInterval(() => {}, 1 << 30)
