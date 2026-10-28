/**
 * npm run dev
 *
 * Local HTTP server for the same route definitions the Vercel Functions use
 * (port 3000 by default, matching the frontend Vite proxy). Unknown paths
 * return a JSON 404. Loads .env.local (then .env) if present.
 *
 * This emulates Vercel routing for local work; `vercel dev` remains an
 * alternative once the project is linked to a Vercel account.
 */
import { existsSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { REPO_ROOT } from './lib/postgres.js'
import { routeRequest } from '../src/http/route.js'
import { routes } from '../src/http/routes.js'
import { environmentDependencies } from '../src/http/vercel.js'

for (const file of ['.env.local', '.env']) {
  const full = path.join(REPO_ROOT, file)
  if (existsSync(full)) process.loadEnvFile(full)
}

const port = Number(process.env.PORT || 3000)

async function toRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v))
    else if (value !== undefined) headers.set(name, value)
  }
  const method = req.method ?? 'GET'
  return new Request(`http://localhost:${port}${req.url ?? '/'}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
  })
}

const server = http.createServer(async (req, res) => {
  const request = await toRequest(req)
  const pathname = new URL(request.url).pathname
  const response = await routeRequest(routes, request, environmentDependencies)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
  console.log(`${request.method} ${pathname} -> ${response.status}`)
})

server.listen(port, () => {
  console.log(`Digital UP Board API listening on http://localhost:${port}`)
})
