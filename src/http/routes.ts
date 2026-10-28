/**
 * The implemented Stage 1 endpoints. Each Vercel Function file in api/
 * exposes exactly one of these; the local dev server serves all of them.
 */
import { parseAcceptance, parseArrival, parseAttributes, parseDeparture, parseOutcome } from './commands.js'
import { jsonResponse } from './responses.js'
import type { RouteDefinition } from './route.js'
import { readJsonObject } from './validation.js'

export const boardRoute: RouteDefinition = {
  path: '/api/board',
  methods: {
    GET: async ({ store }) => jsonResponse(200, await store.getBoard()),
  },
}

export const arrivalsRoute: RouteDefinition = {
  path: '/api/arrivals',
  methods: {
    POST: async ({ request, store }) => {
      const command = parseArrival(await readJsonObject(request))
      const result = await store.registerArrival(command)
      return jsonResponse(result.duplicate ? 200 : 201, result)
    },
  },
}

export const acceptRoute: RouteDefinition = {
  path: '/api/assignments/:assignmentId/accept',
  methods: {
    POST: async ({ request, params, store }) => {
      const command = parseAcceptance(await readJsonObject(request), params)
      return jsonResponse(200, await store.acceptAssignment(command))
    },
  },
}

export const outcomeRoute: RouteDefinition = {
  path: '/api/assignments/:assignmentId/outcome',
  methods: {
    POST: async ({ request, params, store }) => {
      const command = parseOutcome(await readJsonObject(request), params)
      return jsonResponse(200, await store.recordOutcome(command))
    },
  },
}

export const attributesRoute: RouteDefinition = {
  path: '/api/visits/:visitId/attributes',
  methods: {
    PATCH: async ({ request, params, store }) => {
      const command = parseAttributes(await readJsonObject(request), params)
      return jsonResponse(200, await store.updateVisitorAttributes(command))
    },
  },
}

export const departureRoute: RouteDefinition = {
  path: '/api/visits/:visitId/departure',
  methods: {
    POST: async ({ request, params, store }) => {
      const command = parseDeparture(await readJsonObject(request), params)
      return jsonResponse(200, await store.recordDeparture(command))
    },
  },
}

export const routes: readonly RouteDefinition[] = [
  boardRoute,
  arrivalsRoute,
  acceptRoute,
  outcomeRoute,
  attributesRoute,
  departureRoute,
]
