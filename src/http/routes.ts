/**
 * The implemented Stage 1 endpoints. Each Vercel Function file in api/
 * exposes exactly one of these; the local dev server serves all of them.
 */
import { parseArrival } from './commands.js'
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

export const routes: readonly RouteDefinition[] = [boardRoute, arrivalsRoute]
