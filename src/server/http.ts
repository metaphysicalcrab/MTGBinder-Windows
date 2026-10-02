import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { Span } from '../shared/search/ast.ts'

/** An error with an HTTP status, rendered as `{ error: { code, message } }` by the app's error handler. */
export class ApiError extends Error {
  status: ContentfulStatusCode
  code: string
  /** For query errors: the part of the query that's wrong. */
  span: Span | undefined
  /** For 429s: the seconds to wait before trying again (the Retry-After header). */
  retryAfter: number | undefined
  constructor(status: ContentfulStatusCode, code: string, message: string, span?: Span) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.span = span
  }
}

/** A 429 `rate_limited`, saying how many seconds to wait (and in its Retry-After header). */
export function rateLimited(seconds: number, message = 'Too many requests from this device'): ApiError {
  const err = new ApiError(429, 'rate_limited', `${message}; try again in ${seconds} s`)
  err.retryAfter = seconds
  return err
}

/** Validates input with a zod schema; throws a 400 ApiError listing every problem. */
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const message = result.error.issues.map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ')
  throw new ApiError(400, 'bad_request', message)
}

/** Reads a JSON request body, answering 400 (not 500) when it isn't JSON. */
export async function readJson(req: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new ApiError(400, 'bad_request', 'The request body must be JSON')
  }
}

/**
 * An id in a URL: a plain whole number from 1, written in decimal, so `0x1`, `1e0`, `01`, ` 1` and `1.0` name
 * nothing rather than aliasing id 1.
 */
export const PathId = z
  .string()
  .regex(/^[1-9]\d{0,14}$/, 'must be a whole number from 1')
  .transform(Number)

/** The id in a URL, or a 404 `not_found` with `message` when there's no such thing. */
export function pathId(param: string | undefined, message: string): number {
  const parsed = PathId.safeParse(param)
  if (!parsed.success) throw new ApiError(404, 'not_found', message)
  return parsed.data
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True for a hostname that names this computer: `localhost`, `127.0.0.1`, or `[::1]` (any letter case). */
export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase())
}

/** The hostname part of a Host header: `[::1]:4321` → `[::1]`, `localhost:5173` → `localhost`, `127.0.0.1` → itself. */
export function hostHeaderHostname(host: string): string {
  return /^(\[[^\]]*\]|[^:]*)(?::\d*)?$/.exec(host.trim())?.[1] ?? ''
}

/**
 * Whether an Origin is the page this server answers for: the same host and port as the Host header. That is Binder's
 * own page, or the dev server's page, which it proxies with its own Host. Another page on this computer (another
 * port) is another origin.
 */
export function isSameOrigin(origin: string, host: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase()
  } catch {
    return false
  }
}

/** `Sec-Fetch-Site` values a browser sends for Binder's own page, or for a request typed by hand. */
export const OWN_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none'])

/** The listener a request came in on: this computer's (127.0.0.1:4321, spec §6), or the phones' (spec §5.10). */
export type Listener = 'local' | 'lan'

/**
 * Who a request is from, as the guard (lan/guard.ts) found it: this computer, a paired phone, or a phone that isn't
 * paired yet (only on the routes anyone may use).
 */
export type Client = { kind: 'pc' } | { kind: 'device'; id: number; name: string } | { kind: 'unpaired' }

/**
 * The app's Hono environment. `c.env` is what the listener passes in: Node's request and response, and which listener
 * it is (none, as from `app.request()` in tests, is this computer's). `c.var.client` is set by the guard.
 */
export interface AppEnv {
  Bindings: { incoming?: IncomingMessage; outgoing?: ServerResponse; listener?: Listener }
  Variables: { client: Client }
}
