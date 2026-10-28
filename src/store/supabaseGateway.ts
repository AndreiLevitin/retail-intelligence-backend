/**
 * SupabaseGateway - WorkflowStore implemented by PostgreSQL command
 * functions. Thin typed adapter: maps named operations to private SQL
 * function names and arguments, and database failures to StoreError. It does
 * not duplicate business rules.
 */
import {
  DOMAIN_ERROR_CODES,
  type AcceptanceResult,
  type ArrivalResult,
  type AttributesResult,
  type AvailabilityResult,
  type BoardSnapshot,
  type DepartureResult,
  type DomainErrorCode,
  type OutcomeResult,
  type ResetResult,
} from '../contracts/index.js'
import { RpcError, type RpcClient } from './rpc.js'
import {
  StoreError,
  type AcceptanceCommand,
  type ArrivalCommand,
  type AttributesCommand,
  type AvailabilityCommand,
  type DepartureCommand,
  type OutcomeCommand,
  type ResetCommand,
  type WorkflowStore,
} from './workflowStore.js'

const DEFAULT_DOMAIN_MESSAGES: Record<DomainErrorCode, string> = {
  VALIDATION_ERROR: 'The request is invalid.',
  OUTCOME_REQUIRED: 'A purchase result (Sale or NoSale) is required.',
  NOT_FOUND: 'The target does not exist in the current demo run.',
  STALE_SESSION: 'The demo run has changed; reload the board.',
  INVALID_TRANSITION: 'The action is not allowed in the current state.',
  REPLAY_CONFLICT: 'This request identity was already used with different content.',
  OUTCOME_CONFLICT: 'A different purchase result is already recorded.',
}

function isDomainCode(value: string): value is DomainErrorCode {
  return (DOMAIN_ERROR_CODES as readonly string[]).includes(value)
}

export function toStoreError(error: unknown): StoreError {
  if (error instanceof StoreError) return error
  if (error instanceof RpcError) {
    if (error.sqlstate === 'P0001' && isDomainCode(error.message)) {
      return new StoreError(error.message, error.detail ?? DEFAULT_DOMAIN_MESSAGES[error.message])
    }
    if (error.transient) {
      return new StoreError('DATABASE_UNAVAILABLE', 'The database is temporarily unavailable. Try again.', {
        cause: error,
      })
    }
  }
  return new StoreError('INTERNAL_ERROR', 'Unexpected server error.', { cause: error })
}

export class SupabaseGateway implements WorkflowStore {
  constructor(private readonly rpc: RpcClient) {}

  getBoard(): Promise<BoardSnapshot> {
    return this.invoke<BoardSnapshot>('upb_get_board', {})
  }

  registerArrival(command: ArrivalCommand): Promise<ArrivalResult> {
    return this.invoke<ArrivalResult>('upb_register_arrival', {
      p_session_id: command.sessionId,
      p_event_id: command.eventId,
      p_source: command.source,
      p_detected_at: command.detectedAt,
      p_upper_description: command.attributes.upperDescription,
      p_lower_description: command.attributes.lowerDescription,
      p_accessory_description: command.attributes.accessoryDescription,
      p_age_group: command.attributes.ageGroup,
      p_gender: command.attributes.gender,
    })
  }

  setAvailability(command: AvailabilityCommand): Promise<AvailabilityResult> {
    return this.invoke<AvailabilityResult>('upb_set_availability', {
      p_session_id: command.sessionId,
      p_participant_id: command.participantId,
      p_command_id: command.commandId,
      p_state: command.state,
    })
  }

  acceptAssignment(command: AcceptanceCommand): Promise<AcceptanceResult> {
    return this.invoke<AcceptanceResult>('upb_accept_assignment', {
      p_session_id: command.sessionId,
      p_assignment_id: command.assignmentId,
    })
  }

  recordOutcome(command: OutcomeCommand): Promise<OutcomeResult> {
    return this.invoke<OutcomeResult>('upb_record_outcome', {
      p_session_id: command.sessionId,
      p_assignment_id: command.assignmentId,
      p_outcome: command.outcome,
    })
  }

  updateVisitorAttributes(command: AttributesCommand): Promise<AttributesResult> {
    return this.invoke<AttributesResult>('upb_update_visitor_attributes', {
      p_session_id: command.sessionId,
      p_visit_id: command.visitId,
      p_source: command.source,
      p_upper_description: command.attributes.upperDescription,
      p_lower_description: command.attributes.lowerDescription,
      p_accessory_description: command.attributes.accessoryDescription,
      p_age_group: command.attributes.ageGroup,
      p_gender: command.attributes.gender,
      p_enrichment_status: command.enrichmentStatus,
    })
  }

  recordDeparture(command: DepartureCommand): Promise<DepartureResult> {
    return this.invoke<DepartureResult>('upb_record_departure', {
      p_session_id: command.sessionId,
      p_visit_id: command.visitId,
      p_outcome: command.outcome,
    })
  }

  resetDemo(command: ResetCommand): Promise<ResetResult> {
    return this.invoke<ResetResult>('upb_reset_demo', { p_session_id: command.sessionId })
  }

  private async invoke<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    let data: unknown
    try {
      data = await this.rpc.call(fn, args)
    } catch (error) {
      throw toStoreError(error)
    }
    if (data === null || typeof data !== 'object') {
      throw new StoreError('INTERNAL_ERROR', 'Unexpected server error.', {
        cause: new Error(`${fn} returned no result`),
      })
    }
    return data as T
  }
}
