/**
 * WorkflowStore - the boundary between HTTP handlers and persistence.
 *
 * Handlers call these named operations with already validated, normalized
 * commands. Every business rule (transitions, queue rotation, replay
 * handling) lives in the database command functions; implementations only
 * translate calls and results. Failures surface as StoreError.
 */
import type {
  ArrivalResult,
  BoardSnapshot,
  DomainErrorCode,
  VisitorAttributes,
} from '../contracts/index.js'

export interface ArrivalCommand {
  sessionId: string
  eventId: string
  source: 'Manual'
  detectedAt: null
  attributes: VisitorAttributes
}

export interface WorkflowStore {
  getBoard(): Promise<BoardSnapshot>
  registerArrival(command: ArrivalCommand): Promise<ArrivalResult>
}

export type StoreErrorCode = DomainErrorCode | 'DATABASE_UNAVAILABLE' | 'INTERNAL_ERROR'

export class StoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StoreError'
    this.code = code
  }
}
