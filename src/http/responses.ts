import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorResponse } from '../contracts/index.js'

/** Every board, command and error response is uncacheable. */
const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } })
}

export function errorResponse(code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  const body: ErrorResponse = { code, message }
  return jsonResponse(ERROR_HTTP_STATUS[code], body, headers)
}

/** A request-level failure detected by the HTTP layer before or instead of the store. */
export class HttpError extends Error {
  readonly code: ErrorCode
  readonly headers: Record<string, string>

  constructor(code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    this.headers = headers
  }
}
