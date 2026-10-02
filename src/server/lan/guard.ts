import net from 'node:net'
import os from 'node:os'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  ApiError,
  hostHeaderHostname,
  isLocalHostname,
  isSameOrigin,
  OWN_FETCH_SITES,
  rateLimited,
  type AppEnv,
  type Client,
} from '../http.ts'
import { isLoopback, plainAddress, type AddressBook } from './addresses.ts'
import { readDeviceCookie, setDeviceCookie } from './cookie.ts'
import type { DeviceStore } from './devices.ts'
import type { RateLimiter } from './rate-limit.ts'

/**
 * Who may call each API route from a phone (spec §5.10): anyone on the network (`public`, rate-limited), a paired
 * phone (`device`), or only this computer (`pc`). A route that isn't listed is `pc`, and a test fails until every
 * route is. Paths are Hono's: `:id` is one part of the path.
 */
export type Policy = 'public' | 'device' | 'pc'

const POLICIES: Record<Policy, string[]> = {
  // This computer only: the API key (a phone must not swap in another account's), backups (their folder names the
  // PC's account) and the library file (compacting freezes Binder while it runs), and phone access itself (a phone
  // must not let in more phones, see the others, or let itself back in).
  pc: [
    'PUT /api/settings/ai',
    'POST /api/settings/ai/test',
    'GET /api/settings/backups',
    'POST /api/settings/backups',
    'GET /api/settings/library',
    'POST /api/settings/library/compact',
    'GET /api/lan',
    'PUT /api/lan',
    'POST /api/lan/pairing',
    'DELETE /api/lan/pairing',
    'PATCH /api/lan/devices/:id',
    'DELETE /api/lan/devices/:id',
    'POST /api/lan/forget-all',
  ],
  // Anyone: whether Binder is there, who's asking (the pairing page), and pairing.
  public: ['GET /api/health', 'GET /api/lan/me', 'POST /api/lan/pair'],
  // A paired phone: everything a person does with their library.
  device: [
    'POST /api/lan/forget',
    'GET /api/cards/autocomplete',
    'GET /api/cards/named',
    'GET /api/cards/:id',
    'GET /api/bulk/status',
    'POST /api/bulk/refresh',
    'GET /api/search/library',
    'GET /api/search/local',
    'GET /api/search/scryfall',
    'GET /api/catalog/sets',
    'GET /api/catalog/types',
    'GET /api/collection/stats',
    'POST /api/collection/adjust',
    'POST /api/collection/import/preview',
    'POST /api/collection/import',
    'GET /api/collection/export.csv',
    'GET /api/sets',
    'GET /api/sets/:code',
    'GET /api/decks',
    'POST /api/decks',
    'GET /api/decks/:id',
    'PATCH /api/decks/:id',
    'DELETE /api/decks/:id',
    'POST /api/decks/:id/duplicate',
    'POST /api/decks/:id/cards',
    'PATCH /api/decks/:id/lines/:lineId',
    'DELETE /api/decks/:id/lines/:lineId',
    'POST /api/decks/:id/import/preview',
    'POST /api/decks/:id/import',
    'GET /api/decks/:id/export',
    'POST /api/playtest',
    'GET /api/playtest',
    'DELETE /api/playtest',
    'POST /api/playtest/actions',
    'DELETE /api/playtest/actions/last',
    'GET /api/playtest/tokens',
    'GET /api/settings',
    'PATCH /api/settings',
    'GET /api/settings/ai',
    'POST /api/scan',
    'GET /api/scan/items',
    'PUT /api/scan/target',
    'GET /api/scan/items/:id/image',
    'PATCH /api/scan/items/:id',
    'DELETE /api/scan/items/:id',
    'POST /api/scan/items/:id/retry',
    'POST /api/scan/commit',
    'GET /api/ai/threads',
    'POST /api/ai/threads',
    'GET /api/ai/threads/:id',
    'PATCH /api/ai/threads/:id',
    'DELETE /api/ai/threads/:id',
    'POST /api/ai/threads/:id/messages',
    'POST /api/ai/threads/:id/continue',
    'POST /api/ai/threads/:id/stop',
  ],
}

/** A route as `METHOD /path` → its method and a pattern for request paths. */
function compile(route: string): { method: string; path: RegExp } {
  const [method, path] = route.split(' ') as [string, string]
  const pattern = path.replace(/[.]/g, '\\.').replace(/:[A-Za-z]+/g, '[^/]+')
  return { method, path: new RegExp(`^${pattern}$`) }
}

/** This computer's routes are looked at first, so a pattern can't open one of them by accident. */
const TABLE = (['pc', 'public', 'device'] as const).flatMap((policy) =>
  POLICIES[policy].map((route) => ({ ...compile(route), policy })),
)

/** The policy for a request (HEAD's is GET's), or undefined when its route isn't listed (the guard takes it as `pc`). */
export function lanPolicy(method: string, path: string): Policy | undefined {
  const m = method === 'HEAD' ? 'GET' : method
  return TABLE.find((entry) => entry.method === m && entry.path.test(path))?.policy
}

const MB = 1024 * 1024
/**
 * The largest request body a phone may send, checked before it's read: 12 MB for a collection's CSV and a decklist
 * (imports and their previews), 1 MB for anything else. A capture (POST /api/scan) has the scan route's own 15 MB
 * limit, whose answer says what to do on a phone.
 */
const LARGE_BODIES = [/^\/api\/collection\/import(\/preview)?$/, /^\/api\/decks\/[^/]+\/import(\/preview)?$/]

function tooLarge(limit: number) {
  return bodyLimit({
    maxSize: limit,
    onError: () => {
      throw new ApiError(413, 'too_large', `That's too much to send at once: at most ${limit / MB} MB`)
    },
  })
}
const largeBody = tooLarge(12 * MB)
const smallBody = tooLarge(1 * MB)

function bodyLimitFor(method: string, path: string): MiddlewareHandler | null {
  if (method === 'GET' || method === 'HEAD') return null
  if (method === 'POST' && path === '/api/scan') return null
  return LARGE_BODIES.some((pattern) => pattern.test(path)) ? largeBody : smallBody
}

/** The last address an `X-Forwarded-For` names: the one the proxy in front (Vite's) added itself. */
function lastForwarded(header: string | undefined): string | undefined {
  const last = header?.split(',').at(-1)?.trim()
  return last ? plainAddress(last) : undefined
}

/**
 * Where a request came from: its connection's peer, or, when that's this computer and an `X-Forwarded-For` says
 * otherwise, the address the dev server's proxy (`vite --host`) saw. Unknown for `app.request()` in tests that pass
 * neither.
 */
export function peerAddress(c: Context<AppEnv>): string | undefined {
  const socket = c.env?.incoming?.socket?.remoteAddress
  const peer = socket === undefined ? undefined : plainAddress(socket)
  const forwarded = lastForwarded(c.req.header('x-forwarded-for'))
  return forwarded !== undefined && (peer === undefined || isLoopback(peer)) ? forwarded : peer
}

/**
 * Whether a request is this computer's: it came in on this computer's listener (127.0.0.1:4321), from this computer,
 * and not through a proxy for another device. A request with no listener named (`app.request()` in tests) is.
 */
function fromThisComputer(c: Context<AppEnv>): boolean {
  if ((c.env?.listener ?? 'local') !== 'local') return false
  const peer = peerAddress(c)
  return peer === undefined || isLoopback(peer)
}

const changes = (method: string) => method !== 'GET' && method !== 'HEAD'

/**
 * This computer's rules (spec §6 Requests), as they were before phones: the Host header must name this computer
 * (defeats DNS rebinding), and a request that can change something must come from Binder's own page (defeats CSRF),
 * not from another site, nor from another page on this computer (another port).
 */
function checkThisComputer(c: Context<AppEnv>): void {
  const host = c.req.header('host')
  let allowed = host !== undefined && isLocalHostname(hostHeaderHostname(host))
  if (host !== undefined && allowed && changes(c.req.method)) {
    const origin = c.req.header('origin')
    const site = c.req.header('sec-fetch-site')
    allowed = (site === undefined || OWN_FETCH_SITES.has(site)) && (origin === undefined || isSameOrigin(origin, host))
  }
  if (!allowed) throw new ApiError(403, 'forbidden', 'Requests must come from this computer')
}

/** What the guard needs of phone access; without it (most tests), no phone is paired. */
export interface LanGuard {
  devices: Pick<DeviceStore, 'verify' | 'seen'>
  addresses: Pick<AddressBook, 'noticeHost'>
  limits: { public: RateLimiter; unpaired: RateLimiter }
  /** This computer's name, which a phone may use as the Host (`<name>` or `<name>.local`). */
  hostname: string
  /** The address phones open, for a request that named another host. */
  url(): string | null
}

/** A device's cookie is sent again, with a new 400 days, once a day while it's used, so a phone in use stays paired. */
const COOKIE_RESEND_MS = 24 * 60 * 60_000

/**
 * Lets each request in, or refuses it, by where it came from (spec §6 Requests, §5.10), and sets `c.var.client`:
 * - From this computer (its listener, its own address): this computer's rules, as before phones. The web app's files
 *   are anyone's on it.
 * - Anything else (the phones' listener, or a proxy for a phone): the Host must be an address or this computer's name
 *   (defeats DNS rebinding), else 403 `wrong_host`; the web app's files are then anyone's, as they're code, not the
 *   library. An API request that changes something must name Binder's own page as its Origin, and a phone's browser
 *   sends no other sign over HTTP, so the Origin is required; a cross-site read is refused too (403 `cross_site`).
 *   Then the route's policy: `public` routes are rate-limited by address; any other needs a paired phone's cookie
 *   (401 `unpaired`, and 429 after too many from one address), and `pc` routes refuse a phone (403 `pc_only`).
 *   A phone's request bodies are limited in size (413 `too_large`).
 */
export function guard(lan: LanGuard | undefined): MiddlewareHandler<AppEnv> {
  const machine = (lan?.hostname ?? os.hostname()).toLowerCase()
  const resent = new Map<number, number>()
  const resendDue = (id: number) => Date.now() - (resent.get(id) ?? 0) >= COOKIE_RESEND_MS
  const knownHost = (hostname: string) => {
    const name = hostname.toLowerCase()
    if (net.isIP(name.replace(/^\[(.*)\]$/, '$1')) !== 0 || isLocalHostname(name)) return true
    return name === machine || name === `${machine}.local`
  }

  return async (c, next) => {
    const api = c.req.path === '/api' || c.req.path.startsWith('/api/')
    if (fromThisComputer(c)) {
      if (!api) return next()
      checkThisComputer(c)
      c.set('client', { kind: 'pc' })
      return next()
    }

    const host = c.req.header('host') ?? ''
    const hostname = hostHeaderHostname(host)
    if (!knownHost(hostname)) {
      const url = lan?.url()
      throw new ApiError(403, 'wrong_host', url ? `Open Binder at ${url}` : "Open Binder at this PC's address")
    }
    lan?.addresses.noticeHost(hostname)
    if (!api) return next()

    const method = c.req.method
    const site = c.req.header('sec-fetch-site')
    const origin = c.req.header('origin')
    const ownPage = changes(method)
      ? origin !== undefined && isSameOrigin(origin, host) && (site === undefined || OWN_FETCH_SITES.has(site))
      : site !== 'cross-site'
    if (!ownPage) throw new ApiError(403, 'cross_site', "Requests must come from Binder's own page")

    const peer = peerAddress(c) ?? 'unknown'
    const policy = lanPolicy(method, c.req.path) ?? 'pc'
    const cookie = readDeviceCookie(c)
    const device = lan?.devices.verify(cookie) ?? null
    let client: Client
    if (policy === 'public') {
      const wait = lan?.limits.public.take(peer)
      if (wait) throw rateLimited(wait)
      client = device ? { kind: 'device', ...device } : { kind: 'unpaired' }
    } else if (!device) {
      const wait = lan?.limits.unpaired.take(peer)
      if (wait) throw rateLimited(wait)
      throw new ApiError(401, 'unpaired', 'Pair this phone with Binder: on the PC, open Settings → Phone access → Pair a phone')
    } else if (policy === 'pc') {
      throw new ApiError(403, 'pc_only', 'Change this on the PC running Binder')
    } else {
      client = { kind: 'device', ...device }
    }
    c.set('client', client)
    if (device) lan?.devices.seen(device.id, peer === 'unknown' ? null : peer)

    const limit = bodyLimitFor(method, c.req.path)
    await (limit ? limit(c, next) : next())

    // Sent again (after the route, which may have cleared it: a phone forgetting itself).
    if (device && cookie && resendDue(device.id) && !c.res.headers.has('set-cookie')) {
      resent.set(device.id, Date.now())
      setDeviceCookie(c, cookie)
    }
  }
}
