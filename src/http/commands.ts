/**
 * Parsers from JSON request bodies / path parameters to WorkflowStore
 * commands, enforcing the exact Stage 1 bodies of Backend Requirements
 * section 6.
 */
import { OUTCOMES } from '../contracts/index.js'
import type {
  AcceptanceCommand,
  ArrivalCommand,
  AttributesCommand,
  DepartureCommand,
  OutcomeCommand,
} from '../store/workflowStore.js'
import { HttpError } from './responses.js'
import { oneOf, onlyKeys, requiredOneOf, requiredUuid, uuid, visitorAttributes, type JsonObject } from './validation.js'

export function parseArrival(body: JsonObject): ArrivalCommand {
  onlyKeys(body, ['sessionId', 'eventId', 'source', 'detectedAt', 'attributes'])
  const sessionId = requiredUuid(body, 'sessionId')
  const eventId = requiredUuid(body, 'eventId')
  if (body.source !== 'Manual') {
    throw new HttpError('VALIDATION_ERROR', 'source must be Manual; CV arrivals are not available in this stage.')
  }
  if (body.detectedAt !== undefined && body.detectedAt !== null) {
    throw new HttpError('VALIDATION_ERROR', 'detectedAt must be null or omitted for manual arrivals.')
  }
  if (!('attributes' in body)) throw new HttpError('VALIDATION_ERROR', 'attributes is required.')
  return {
    sessionId,
    eventId,
    source: 'Manual',
    detectedAt: null,
    attributes: visitorAttributes(body.attributes),
  }
}

export function parseAcceptance(body: JsonObject, params: Record<string, string>): AcceptanceCommand {
  onlyKeys(body, ['sessionId'])
  return {
    sessionId: requiredUuid(body, 'sessionId'),
    assignmentId: uuid(params.assignmentId, 'assignmentId'),
  }
}

export function parseOutcome(body: JsonObject, params: Record<string, string>): OutcomeCommand {
  onlyKeys(body, ['sessionId', 'outcome'])
  return {
    sessionId: requiredUuid(body, 'sessionId'),
    assignmentId: uuid(params.assignmentId, 'assignmentId'),
    outcome: requiredOneOf(body, 'outcome', OUTCOMES),
  }
}

export function parseAttributes(body: JsonObject, params: Record<string, string>): AttributesCommand {
  onlyKeys(body, ['sessionId', 'source', 'attributes', 'enrichmentStatus'])
  const sessionId = requiredUuid(body, 'sessionId')
  if (body.source !== 'Manual') {
    throw new HttpError('VALIDATION_ERROR', 'source must be Manual; CV enrichment is not available in this stage.')
  }
  if (body.enrichmentStatus !== 'NotRequested') {
    throw new HttpError('VALIDATION_ERROR', 'enrichmentStatus must be NotRequested for manual updates.')
  }
  if (!('attributes' in body)) throw new HttpError('VALIDATION_ERROR', 'attributes is required.')
  return {
    sessionId,
    visitId: uuid(params.visitId, 'visitId'),
    source: 'Manual',
    attributes: visitorAttributes(body.attributes),
    enrichmentStatus: 'NotRequested',
  }
}

export function parseDeparture(body: JsonObject, params: Record<string, string>): DepartureCommand {
  onlyKeys(body, ['sessionId', 'outcome'])
  return {
    sessionId: requiredUuid(body, 'sessionId'),
    visitId: uuid(params.visitId, 'visitId'),
    outcome: body.outcome === undefined || body.outcome === null ? null : oneOf(body.outcome, OUTCOMES, 'outcome'),
  }
}
