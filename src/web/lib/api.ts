import type { ApiErrorBody } from '../../shared/types.ts'
import { isThisComputersHostname } from './platform.ts'

export class ApiRequestError extends Error {
  status: number
  code: string
  /** For query errors: the character range of the query that's wrong. */
  span: { start: number; end: number } | undefined
  /** For a 429: the seconds to wait before trying again (its Retry-After header). */
  retryAfter: number | undefined
  constructor(status: number, code: string, message: string, span?: { start: number; end: number }, retryAfter?: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
    this.span = span
    this.retryAfter = retryAfter
  }
}

/** A Retry-After header's seconds; undefined without one (or with a date, which the server never sends). */
export function retryAfterSeconds(header: string | null): number | undefined {
  const seconds = header === null || header.trim() === '' ? NaN : Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined
}

/**
 * What a request that got no answer at all says, in place of the browser's own words ("Failed to fetch"). On this
 * computer, Binder isn't running. On a phone, the commonest failure over Wi-Fi: Binder quit or turned phone access off,
 * the PC is asleep, or the phone is on another network.
 */
export function noAnswerText(onThisComputer: boolean): string {
  return onThisComputer
    ? "Couldn't reach Binder: check that it's still running"
    : "Couldn't reach Binder on the PC: check that it's running with Phone access on, and that this phone is on the same Wi-Fi"
}

/**
 * fetch, with no answer at all (its TypeError) said as noAnswerText says it, for this page's address. Not an
 * ApiRequestError, so it's still told apart from what the server answered. An abort is a DOMException, and stays one.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init)
  } catch (err) {
    if (!(err instanceof TypeError)) throw err
    const hostname = typeof location === 'undefined' ? 'localhost' : location.hostname
    throw new Error(noAnswerText(isThisComputersHostname(hostname)), { cause: err })
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T
  if (res.ok) return (await res.json()) as T
  let code = 'http_error'
  let message = `Request failed (${res.status})`
  let span: ApiErrorBody['error']['span']
  try {
    const body = (await res.json()) as ApiErrorBody
    code = body.error.code
    message = body.error.message
    span = body.error.span
  } catch {
    // Not a JSON error body; keep the generic message.
  }
  throw new ApiRequestError(res.status, code, message, span, retryAfterSeconds(res.headers.get('retry-after')))
}

/** GETs JSON from the API. Pass React Query's `signal` so superseded requests are cancelled. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return handle<T>(await apiFetch(path, { signal }))
}

/** Sends a change (POST, PUT, PATCH, DELETE) with an optional JSON body. A 204 answer resolves to undefined. */
export async function apiSend<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  return handle<T>(await apiFetch(path, init))
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiSend<T>('POST', path, body)
}

/** POSTs a file, such as a camera capture, as the raw request body. */
export async function apiUpload<T>(path: string, file: Blob): Promise<T> {
  return handle<T>(await apiFetch(path, { method: 'POST', headers: { 'content-type': file.type }, body: file }))
}

/** GETs a plain-text answer (such as a decklist export). */
export async function apiGetText(path: string, signal?: AbortSignal): Promise<string> {
  const res = await apiFetch(path, { signal })
  if (!res.ok) return handle<string>(res)
  return res.text()
}
