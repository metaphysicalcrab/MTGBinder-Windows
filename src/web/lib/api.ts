import type { ApiErrorBody } from '../../shared/types.ts'

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
  return handle<T>(await fetch(path, { signal }))
}

/** Sends a change (POST, PUT, PATCH, DELETE) with an optional JSON body. A 204 answer resolves to undefined. */
export async function apiSend<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  return handle<T>(await fetch(path, init))
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiSend<T>('POST', path, body)
}

/** POSTs a file, such as a camera capture, as the raw request body. */
export async function apiUpload<T>(path: string, file: Blob): Promise<T> {
  return handle<T>(await fetch(path, { method: 'POST', headers: { 'content-type': file.type }, body: file }))
}

/** GETs a plain-text answer (such as a decklist export). */
export async function apiGetText(path: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(path, { signal })
  if (!res.ok) return handle<string>(res)
  return res.text()
}
