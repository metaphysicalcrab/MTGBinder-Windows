import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type MiddlewareHandler } from 'hono'
import { createBrainstorm } from './ai/chat.ts'
import type { AiClient } from './ai/client.ts'
import { aiRoutes } from './ai/routes.ts'
import { createBrainstormTools } from './ai/tools.ts'
import type { BulkImporter } from './bulk/import.ts'
import { bulkRoutes } from './bulk/routes.ts'
import { cardRoutes } from './cards/routes.ts'
import { catalogRoutes } from './catalog/routes.ts'
import { collectionRoutes } from './collection/routes.ts'
import { deckRoutes } from './decks/routes.ts'
import type { DB } from './db/index.ts'
import { ApiError, type AppEnv } from './http.ts'
import type { LanController } from './lan/controller.ts'
import { guard } from './lan/guard.ts'
import { lanRoutes } from './lan/routes.ts'
import { playtestRoutes } from './playtest/routes.ts'
import { scanRoutes, type ScanService } from './scanner/routes.ts'
import type { ScryfallClient } from './scryfall/client.ts'
import { searchRoutes } from './search/routes.ts'
import { setRoutes } from './sets/routes.ts'
import { settingsRoutes } from './settings-routes.ts'

export interface AppDeps {
  db: DB
  bulk: BulkImporter
  scryfall: ScryfallClient
  /** The scan queue (spec §5.1); without it there are no /api/scan routes. */
  scanner?: ScanService
  /** The Anthropic API key and client (spec §5.6); without it there are no /api/settings/ai or /api/ai routes. */
  ai?: AiClient
  /** Where backups are kept (spec §5.6); without it there are no /api/settings/backups routes. */
  backupDir?: string
  /** Phone access (spec §5.10); without it there are no /api/lan routes, and no phone is paired. */
  lan?: LanController
  /** Built SPA directory. When set, non-API requests serve it, falling back to index.html. */
  webDistDir?: string
  /** Picks the playtest's seeds and random starting seats (tests pass their own). */
  playtestRandom?: (max: number) => number
}

/**
 * Windows' device names, which name a device (the console, a serial port) in any folder, with any extension, in any
 * letter case, and with dots or spaces after them: reading `dist\web\COM1` would open the port and wait on it.
 */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i

/**
 * Whether a request's path may be looked up among the web app's files: none of its parts is a Windows device name
 * (`/CON`, `/nul.txt`, `/Com1 .js`) or holds a `:` (a drive, or one of a file's hidden streams). Checked on every
 * platform: it costs nothing, and the files are served to the network once phone access is on. A path refused here
 * gets the app's page instead, as any path that names no file does (`/sets/con`, Conflux, is the app's own).
 */
export function isServablePath(urlPath: string): boolean {
  let decoded = urlPath
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    // Not valid percent-encoding: checked as it is (serveStatic finds no such file either).
  }
  return decoded.split(/[/\\]/).every((part) => {
    if (part.includes(':')) return false
    const name = part.replace(/[. ]+$/, '').split('.')[0]!.replace(/ +$/, '')
    return !DEVICE_NAME.test(name)
  })
}

/**
 * Headers on every answer. Binder's pages are never framed by another page (clickjacking), nothing is sniffed as a
 * type it isn't, and no address is passed on to the sites the app links to. The API's answers aren't kept by the
 * browser (they change as the library does), unless a route says otherwise (scan photos are); the web app's
 * `assets/`, whose names change with their content, are kept for good; and its page, manifest, and icons are checked
 * each time, so a new version shows at once.
 */
const responseHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  const headers = c.res.headers
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  headers.set('Referrer-Policy', 'no-referrer')
  if (headers.has('Cache-Control')) return
  if (c.req.path.startsWith('/api/')) headers.set('Cache-Control', 'no-store')
  else if (c.req.path.startsWith('/assets/') && c.res.status === 200) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  } else headers.set('Cache-Control', 'no-cache')
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', responseHeaders)

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      const span = err.span ? { span: err.span } : {}
      const headers = err.retryAfter === undefined ? undefined : { 'Retry-After': String(err.retryAfter) }
      return c.json({ error: { code: err.code, message: err.message, ...span } }, err.status, headers)
    }
    console.error(err)
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
  })

  // After the headers, so a refused request has them too; before everything else, the web app's files included.
  app.use('*', guard(deps.lan))
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api/cards', cardRoutes(deps))
  app.route('/api/bulk', bulkRoutes(deps))
  app.route('/api/search', searchRoutes(deps))
  app.route('/api/catalog', catalogRoutes(deps))
  app.route('/api/collection', collectionRoutes(deps))
  app.route('/api/sets', setRoutes(deps))
  app.route('/api/decks', deckRoutes(deps))
  app.route('/api/playtest', playtestRoutes({ db: deps.db, random: deps.playtestRandom }))
  app.route('/api/settings', settingsRoutes(deps))
  if (deps.scanner) app.route('/api/scan', scanRoutes({ db: deps.db, scanner: deps.scanner }))
  if (deps.ai) {
    const tools = createBrainstormTools({ db: deps.db, scryfall: deps.scryfall })
    const brainstorm = createBrainstorm({ db: deps.db, ai: deps.ai, tools })
    app.route('/api/ai', aiRoutes({ db: deps.db, brainstorm, tools, devices: deps.lan?.devices }))
  }
  if (deps.lan) app.route('/api/lan', lanRoutes(deps.lan))
  app.all('/api/*', (c) =>
    c.json({ error: { code: 'not_found', message: `No API route for ${c.req.method} ${c.req.path}` } }, 404),
  )

  if (deps.webDistDir) {
    const files = serveStatic({ root: deps.webDistDir })
    app.use('/*', (c, next) => (isServablePath(c.req.path) ? files(c, next) : next()))
    // A missing build file is a 404, not the app's page, which would be kept for good under that name.
    app.get('/assets/*', (c) => c.text('Not found', 404))
    app.get('*', serveStatic({ path: path.join(deps.webDistDir, 'index.html') }))
  }

  return app
}
