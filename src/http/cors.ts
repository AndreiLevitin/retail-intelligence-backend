/**
 * CORS for the separately hosted frontend. Only exact origins from
 * CORS_ALLOWED_ORIGINS are accepted. CORS is not authentication: preflight
 * (OPTIONS) needs no operator token, every real operation still does.
 * Requests without an Origin header (curl, server-to-server) are not
 * browser cross-origin requests and pass through to normal auth.
 */
import { errorResponse } from './responses.js'

const PREFLIGHT_MAX_AGE_SECONDS = '600'
const ALLOWED_REQUEST_HEADERS = 'Authorization, Content-Type'

export type OriginDecision =
  | { kind: 'none' }
  | { kind: 'allowed'; origin: string }
  | { kind: 'rejected' }

export function decideOrigin(request: Request, allowedOrigins: readonly string[]): OriginDecision {
  const origin = request.headers.get('origin')
  if (origin === null) return { kind: 'none' }
  return allowedOrigins.includes(origin) ? { kind: 'allowed', origin } : { kind: 'rejected' }
}

export function rejectedOriginResponse(): Response {
  return errorResponse('ORIGIN_NOT_ALLOWED', 'This origin is not allowed to call the API.')
}

/** Adds CORS headers for an allowed origin to any response (success or error). */
export function withCorsHeaders(response: Response, decision: OriginDecision): Response {
  if (decision.kind !== 'allowed') return response
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', decision.origin)
  headers.append('vary', 'Origin')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function preflightResponse(allowMethods: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      allow: allowMethods,
      'access-control-allow-methods': allowMethods,
      'access-control-allow-headers': ALLOWED_REQUEST_HEADERS,
      'access-control-max-age': PREFLIGHT_MAX_AGE_SECONDS,
      'cache-control': 'no-store',
    },
  })
}
