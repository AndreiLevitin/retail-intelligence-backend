import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestProject } from 'vitest/node'
import { ensureRoles, startCluster } from '../../scripts/lib/postgres.js'

declare module 'vitest' {
  export interface ProvidedContext {
    pgPort: number
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('Could not allocate a port'))
      })
    })
  })
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const port = await freePort()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'upb-test-pg-'))
  const cluster = await startCluster({ dataDir, port, persistent: false, initialise: true })
  await ensureRoles(port)
  project.provide('pgPort', port)

  return async () => {
    await cluster.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
}
