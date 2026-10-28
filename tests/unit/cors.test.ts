/**
 * CORS behavior of the route pipeline. The store stub fails on every call,
 * proving that preflight and rejected origins never reach the database; a
 * successful read uses a fixed snapshot (no business logic is involved).
 */
import { describe, expect, it } from 'vitest'
import type { BoardSnapshot } from '../../src/contracts/index.js'
import { ConfigError, parseAllowedOrigins } from '../../src/config.js'
import { routeRequest } from '../../src/http/route.js'
import { routes } from '../../src/http/routes.js'
import type { WorkflowStore } from '../../src/store/index.js'

const TOKEN = 'cors-test-token'
const ALLOWED = 'http://localhost:5173'

const snapshot = { session: { sessionId: 's', startedAt: 't' } } as unknown as BoardSnapshot
let storeCalls = 0
const store = new Proxy({} as WorkflowStore, {
  get: (_target, property) => {
    if (property === 'getBoard') {
      return async () => {
        storeCalls += 1
        return snapshot
      }
    }
    return async () => {
      storeCalls += 1
      throw new Error(`store.${String(property)} must not be called`)
    }
  },
})

function call(method: string, path: string, headers: Record<string, string> = {}) {
  return routeRequest(routes, new Request(`http://api.local${path}`, { method, headers }), () => ({
    operatorToken: TOKEN,
    allowedOrigins: [ALLOWED],
    store,
  }))
}

describe('CORS', () => {
  it('answers preflight for an allowed origin without a token or store call', async () => {
    storeCalls = 0
    const response = await call('OPTIONS', '/api/arrivals', {
      origin: ALLOWED,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS')
    expect(response.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type')
    expect(response.headers.get('vary')).toContain('Origin')
    expect((await call('OPTIONS', '/api/visits/x/attributes', { origin: ALLOWED })).headers.get('access-control-allow-methods')).toBe(
      'PATCH, OPTIONS',
    )
    expect((await call('OPTIONS', '/api/board', { origin: ALLOWED })).headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
    expect(storeCalls).toBe(0)
  })

  it('rejects unapproved origins with 403 before auth or store, without CORS headers', async () => {
    storeCalls = 0
    for (const method of ['OPTIONS', 'GET']) {
      const response = await call(method, '/api/board', { origin: 'https://evil.example', authorization: `Bearer ${TOKEN}` })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ code: 'ORIGIN_NOT_ALLOWED', message: expect.any(String) })
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    }
    // Exact match only: scheme and port matter.
    expect((await call('GET', '/api/board', { origin: 'http://localhost:5174' })).status).toBe(403)
    expect((await call('GET', '/api/board', { origin: 'https://localhost:5173' })).status).toBe(403)
    expect(storeCalls).toBe(0)
  })

  it('still requires the operator token for real requests and lets the browser read errors', async () => {
    storeCalls = 0
    const unauthorized = await call('GET', '/api/board', { origin: ALLOWED })
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(storeCalls).toBe(0)

    const ok = await call('GET', '/api/board', { origin: ALLOWED, authorization: `Bearer ${TOKEN}` })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(await ok.json()).toEqual(snapshot)

    const missing = await call('GET', '/api/nothing', { origin: ALLOWED })
    expect([missing.status, missing.headers.get('access-control-allow-origin')]).toEqual([404, ALLOWED])
  })

  it('treats requests without Origin as non-browser: no CORS headers, normal auth', async () => {
    const response = await call('GET', '/api/board', { authorization: `Bearer ${TOKEN}` })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect((await call('GET', '/api/board')).status).toBe(401)
  })

  it('parses CORS_ALLOWED_ORIGINS as exact origins', () => {
    expect(parseAllowedOrigins(null)).toEqual([])
    expect(parseAllowedOrigins(' http://localhost:5173/ , https://board.example.com ')).toEqual([
      'http://localhost:5173',
      'https://board.example.com',
    ])
    expect(() => parseAllowedOrigins('*')).toThrow(ConfigError)
    expect(() => parseAllowedOrigins('https://board.example.com/app')).toThrow(ConfigError)
  })
})
