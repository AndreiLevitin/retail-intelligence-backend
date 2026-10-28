/**
 * WorkflowStore - the boundary between HTTP handlers and persistence.
 *
 * Handlers call these named operations with already validated, normalized
 * commands. Every business rule (transitions, queue rotation, replay
 * handling) lives in the database command functions; implementations only
 * translate calls and results. Failures surface as StoreError.
 */
import type {
  AcceptanceResult,
  ArrivalResult,
  AttributesResult,
  AvailabilityResult,
  AvailabilityState,
  BoardSnapshot,
  DepartureResult,
  DomainErrorCode,
  Outcome,
  OutcomeResult,
  VisitorAttributes,
} from '../contracts/index.js'

export interface ArrivalCommand {
  sessionId: string
  eventId: string
  source: 'Manual'
  detectedAt: null
  attributes: VisitorAttributes
}

export interface AcceptanceCommand {
  sessionId: string
  assignmentId: string
}

export interface OutcomeCommand {
  sessionId: string
  assignmentId: string
  outcome: Outcome
}

export interface AttributesCommand {
  sessionId: string
  visitId: string
  source: 'Manual'
  attributes: VisitorAttributes
  enrichmentStatus: 'NotRequested'
}

export interface DepartureCommand {
  sessionId: string
  visitId: string
  /** null when the operator did not supply a result. */
  outcome: Outcome | null
}

export interface AvailabilityCommand {
  sessionId: string
  participantId: string
  commandId: string
  state: AvailabilityState
}

export interface WorkflowStore {
  getBoard(): Promise<BoardSnapshot>
  registerArrival(command: ArrivalCommand): Promise<ArrivalResult>
  setAvailability(command: AvailabilityCommand): Promise<AvailabilityResult>
  acceptAssignment(command: AcceptanceCommand): Promise<AcceptanceResult>
  recordOutcome(command: OutcomeCommand): Promise<OutcomeResult>
  updateVisitorAttributes(command: AttributesCommand): Promise<AttributesResult>
  recordDeparture(command: DepartureCommand): Promise<DepartureResult>
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
