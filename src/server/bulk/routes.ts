import { Hono } from 'hono'
import { ApiError, type AppEnv } from '../http.ts'
import type { BulkImporter } from './import.ts'

/** How often a phone may start a card data refresh: each is a large download and minutes of work on the PC. */
export const DEVICE_REFRESH_MS = 60 * 60_000

export function bulkRoutes(deps: { bulk: BulkImporter }): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  /** When a phone last started a refresh, so one that fails can't be started again and again either. */
  let deviceStarted = -Infinity

  routes.get('/status', (c) => c.json(deps.bulk.status()))

  routes.post('/refresh', (c) => {
    const device = c.get('client')?.kind === 'device'
    if (device) {
      const updated = Date.parse(deps.bulk.status().updatedAt ?? '')
      if (Date.now() - updated < DEVICE_REFRESH_MS) {
        throw new ApiError(409, 'recently_refreshed', 'The card data was refreshed less than an hour ago')
      }
      if (Date.now() - deviceStarted < DEVICE_REFRESH_MS) {
        throw new ApiError(409, 'recently_refreshed', 'A phone started a card data refresh less than an hour ago; refresh it on the PC')
      }
    }
    const refresh = deps.bulk.start()
    if (refresh === null) {
      throw new ApiError(409, 'already_running', 'A card data refresh is already running')
    }
    if (device) deviceStarted = Date.now()
    // start() never rejects; this backstop keeps a bug there from crashing the server with an unhandled rejection.
    refresh.catch((err: unknown) => console.error('[card data]', err))
    return c.json({ started: true }, 202)
  })

  return routes
}
