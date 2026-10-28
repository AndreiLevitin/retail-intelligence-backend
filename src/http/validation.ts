/**
 * Request shape validation and normalization. Semantic rules are validated
 * again inside the SQL functions; this layer rejects malformed input early
 * with precise messages and never forwards unexpected writable fields.
 */
import {
  AGE_GROUPS,
  DESCRIPTION_MAX_LENGTH,
  GENDERS,
  type VisitorAttributes,
} from '../contracts/index.js'
import { HttpError } from './responses.js'

export type JsonObject = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function invalid(message: string): HttpError {
  return new HttpError('VALIDATION_ERROR', message)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Requires Content-Type application/json and a JSON object body. */
export async function readJsonObject(request: Request): Promise<JsonObject> {
  const contentType = request.headers.get('content-type') ?? ''
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw invalid('Content-Type must be application/json.')
  }
  const text = await request.text()
  if (text.trim() === '') throw invalid('A JSON request body is required.')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalid('The request body is not valid JSON.')
  }
  if (!isObject(parsed)) throw invalid('The request body must be a JSON object.')
  return parsed
}

/** Rejects fields outside the endpoint contract (no unexpected writable fields). */
export function onlyKeys(value: JsonObject, allowed: readonly string[], path = ''): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`Unexpected field: ${path}${key}.`)
  }
}

export function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`${name} must be a UUID.`)
  return value.toLowerCase()
}

export function requiredUuid(body: JsonObject, key: string): string {
  if (!(key in body)) throw invalid(`${key} is required.`)
  return uuid(body[key], key)
}

export function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`${name} must be one of: ${allowed.join(', ')}.`)
  }
  return value as T[number]
}

export function requiredOneOf<const T extends readonly string[]>(
  body: JsonObject,
  key: string,
  allowed: T,
): T[number] {
  if (!(key in body)) throw invalid(`${key} is required.`)
  return oneOf(body[key], allowed, key)
}

function description(value: unknown, name: string, nullable: boolean): string | null {
  if (value === null && nullable) return null
  if (typeof value !== 'string') {
    throw invalid(nullable ? `${name} must be a string or null.` : `${name} must be a string.`)
  }
  const trimmed = value.trim()
  if ([...trimmed].length > DESCRIPTION_MAX_LENGTH) {
    throw invalid(`${name} must be at most ${DESCRIPTION_MAX_LENGTH} characters.`)
  }
  return nullable && trimmed === '' ? null : trimmed
}

const ATTRIBUTE_KEYS = [
  'upperDescription',
  'lowerDescription',
  'accessoryDescription',
  'ageGroup',
  'gender',
] as const

/**
 * Full VisitorAttributes object: all five fields present; descriptions
 * trimmed (empty upper/lower allowed, empty accessory -> null); explicit
 * ageGroup and gender enums (Unknown allowed).
 */
export function visitorAttributes(value: unknown, name = 'attributes'): VisitorAttributes {
  if (!isObject(value)) throw invalid(`${name} must be an object.`)
  onlyKeys(value, ATTRIBUTE_KEYS, `${name}.`)
  for (const key of ATTRIBUTE_KEYS) {
    if (!(key in value)) throw invalid(`${name}.${key} is required.`)
  }
  return {
    upperDescription: description(value.upperDescription, `${name}.upperDescription`, false) as string,
    lowerDescription: description(value.lowerDescription, `${name}.lowerDescription`, false) as string,
    accessoryDescription: description(value.accessoryDescription, `${name}.accessoryDescription`, true),
    ageGroup: oneOf(value.ageGroup, AGE_GROUPS, `${name}.ageGroup`),
    gender: oneOf(value.gender, GENDERS, `${name}.gender`),
  }
}
