/**
 * Route pipeline shared by the Vercel Functions and the local dev server:
 * method check (405 + Allow) -> path parameters -> configuration -> operator
 * token (401, before any store call) -> handler -> error mapping. Responses
 * never contain SQL details, stack traces or secrets.
 */
import { ERROR_HTTP_STATUS } from '../contracts/index.js'
import { ConfigError } from '../config.js'
import { StoreError, type WorkflowStore } from '../store/index.js'
import { requireOperator } from './auth.js'
import { errorResponse, HttpError } from './responses.js'

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export interface Dependencies {
  operatorToken: string
  store: WorkflowStore
}

export type DependencyProvider = () => Dependencies

export interface RouteContext {
  request: Request
  params: Record<string, string>
  store: WorkflowStore
}

export type RouteHandler = (context: RouteContext) => Promise<Response>

export interface RouteDefinition {
  /** Template such as /api/assignments/:assignmentId/accept */
  path: string
  methods: Partial<Record<HttpMethod, RouteHandler>>
}

/** Returns decoded path parameters, or null when the path does not match. */
export function matchPath(template: string, pathname: string): Record<string, string> | null {
  const expected = template.split('/').filter(Boolean)
  const actual = pathname.split('/').filter(Boolean)
  if (expected.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < expected.length; i++) {
    const segment = expected[i]!
    const value = actual[i]!
    if (segment.startsWith(':')) {
      try {
        params[segment.slice(1)] = decodeURIComponent(value)
      } catch {
        return null
      }
    } else if (segment !== value) {
      return null
    }
  }
  return params
}

export function allowHeader(route: RouteDefinition): string {
  return HTTP_METHODS.filter((method) => route.methods[method]).join(', ')
}

export async function handleRoute(
  route: RouteDefinition,
  request: Request,
  dependencies: DependencyProvider,
): Promise<Response> {
  try {
    const handler = route.methods[request.method.toUpperCase() as HttpMethod]
    if (!handler) {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed.', { allow: allowHeader(route) })
    }
    const params = matchPath(route.path, new URL(request.url).pathname)
    if (!params) return errorResponse('NOT_FOUND', 'Route not found.')

    const { operatorToken, store } = dependencies()
    requireOperator(request, operatorToken)
    return await handler({ request, params, store })
  } catch (error) {
    return toErrorResponse(error, route.path)
  }
}

/** Dispatches over a route table; unknown paths get a JSON 404. */
export async function routeRequest(
  table: readonly RouteDefinition[],
  request: Request,
  dependencies: DependencyProvider,
): Promise<Response> {
  const pathname = new URL(request.url).pathname
  const route = table.find((candidate) => matchPath(candidate.path, pathname) !== null)
  return route ? handleRoute(route, request, dependencies) : errorResponse('NOT_FOUND', 'Route not found.')
}

function toErrorResponse(error: unknown, path: string): Response {
  if (error instanceof HttpError) return errorResponse(error.code, error.message, error.headers)
  if (error instanceof StoreError) {
    if (ERROR_HTTP_STATUS[error.code] >= 500) logFailure(path, error.code, error.cause ?? error)
    return errorResponse(error.code, error.message)
  }
  if (error instanceof ConfigError) {
    logFailure(path, 'CONFIGURATION', error)
    return errorResponse('INTERNAL_ERROR', 'The server is not configured.')
  }
  logFailure(path, 'UNEXPECTED', error)
  return errorResponse('INTERNAL_ERROR', 'Unexpected server error.')
}

/** Server-side log only. Never includes request bodies or headers. */
function logFailure(path: string, kind: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  console.error(`[api] ${path} ${kind} ${detail}`)
}
