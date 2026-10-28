/**
 * Stable error codes of the public API ("Backend Requirements.md" section 6).
 * Every non-2xx JSON response body is an ErrorResponse.
 */

export const ERROR_HTTP_STATUS = {
  VALIDATION_ERROR: 400,
  OUTCOME_REQUIRED: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  STALE_SESSION: 409,
  INVALID_TRANSITION: 409,
  REPLAY_CONFLICT: 409,
  OUTCOME_CONFLICT: 409,
  INTERNAL_ERROR: 500,
  DATABASE_UNAVAILABLE: 503,
} as const

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS

export interface ErrorResponse {
  code: ErrorCode
  /** Short public explanation; never SQL details or secrets. */
  message: string
}

/** Codes the database command functions may raise for business-rule failures. */
export const DOMAIN_ERROR_CODES = [
  'VALIDATION_ERROR',
  'OUTCOME_REQUIRED',
  'NOT_FOUND',
  'STALE_SESSION',
  'INVALID_TRANSITION',
  'REPLAY_CONFLICT',
  'OUTCOME_CONFLICT',
] as const satisfies readonly ErrorCode[]

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]
