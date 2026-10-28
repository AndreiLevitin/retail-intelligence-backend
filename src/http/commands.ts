/**
 * Parsers from JSON request bodies / path parameters to WorkflowStore
 * commands, enforcing the exact Stage 1 bodies of Backend Requirements
 * section 6.
 */
import type { ArrivalCommand } from '../store/workflowStore.js'
import { HttpError } from './responses.js'
import { onlyKeys, requiredUuid, visitorAttributes, type JsonObject } from './validation.js'

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
