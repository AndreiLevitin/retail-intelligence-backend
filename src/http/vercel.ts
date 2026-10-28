/**
 * Adapter from a RouteDefinition to a Vercel Function using the Web
 * Request/Response handler signature. Every HTTP method is exported by the
 * api/ files so unsupported ones reach our 405 response with an Allow header.
 */
import { loadConfig } from '../config.js'
import { createWorkflowStore } from '../store/index.js'
import { handleRoute, type Dependencies, type RouteDefinition } from './route.js'

let cached: Dependencies | null = null

/** Lazily created once per function instance from environment variables. */
export function environmentDependencies(): Dependencies {
  if (!cached) {
    const config = loadConfig()
    cached = {
      operatorToken: config.operatorToken,
      allowedOrigins: config.allowedOrigins,
      store: createWorkflowStore(config.database),
    }
  }
  return cached
}

export function vercelHandler(route: RouteDefinition): (request: Request) => Promise<Response> {
  return (request) => handleRoute(route, request, environmentDependencies)
}
