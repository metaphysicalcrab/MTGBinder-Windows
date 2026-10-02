import { describe, expect, it } from 'vitest'
import { ApiRequestError, retryAfterSeconds } from '../../src/web/lib/api.ts'
import {
  apiSignal,
  clientFromAnswer,
  clientOnFailure,
  pairingKeyIn,
  reportApiError,
  reportForgotten,
  watchApiSignals,
} from '../../src/web/lib/client.ts'

describe('the gate (spec §5.10)', () => {
  it('shows the app to the PC and a paired phone, and only the pairing page to a phone that is not paired', () => {
    expect(clientFromAnswer({ client: 'pc' })).toEqual({ kind: 'pc' })
    expect(clientFromAnswer({ client: 'device', id: 3, name: 'Pixel 8' })).toEqual({ kind: 'device', id: 3, name: 'Pixel 8' })
    expect(clientFromAnswer({ client: 'unpaired', https: true })).toEqual({ kind: 'unpaired', https: true })
  })

  it('never locks the PC out: no answer, a Binder from before phones, or a failing server shows the app as before', () => {
    expect(clientOnFailure(new TypeError('Failed to fetch'))).toEqual({ kind: 'pc' })
    expect(clientOnFailure(new DOMException('The operation timed out.', 'TimeoutError'))).toEqual({ kind: 'pc' })
    expect(clientOnFailure(new ApiRequestError(404, 'not_found', 'No API route for GET /api/lan/me'))).toEqual({ kind: 'pc' })
    expect(clientOnFailure(new ApiRequestError(500, 'internal', 'Something went wrong'))).toEqual({ kind: 'pc' })
    // Too many requests from a phone: it gets the app, and its first request sends it to the pairing page if need be.
    expect(clientOnFailure(new ApiRequestError(429, 'rate_limited', 'Too many requests'))).toEqual({ kind: 'pc' })
  })

  it('shows the pairing page when the server says this phone is not paired', () => {
    expect(clientOnFailure(new ApiRequestError(401, 'unpaired', 'Pair this phone'))).toEqual({ kind: 'unpaired', https: false })
  })
})

describe('apiSignal', () => {
  it('picks out the errors about this page: forgotten by the PC, or a change only the PC may make', () => {
    expect(apiSignal(new ApiRequestError(401, 'unpaired', 'Pair this phone'))).toBe('unpaired')
    expect(apiSignal(new ApiRequestError(403, 'pc_only', 'Change this on the PC running Binder'))).toBe('pc_only')
    expect(apiSignal(new ApiRequestError(403, 'forbidden', 'Requests must come from this computer'))).toBeNull()
    expect(apiSignal(new ApiRequestError(409, 'recently_refreshed', 'Card data was refreshed in the last hour'))).toBeNull()
    expect(apiSignal(new Error('unpaired'))).toBeNull()
  })

  it('passes them on to whoever watches (the gate), until it stops watching', () => {
    const seen: string[] = []
    const stop = watchApiSignals((signal, message) => seen.push(`${signal}: ${message}`))
    reportApiError(new ApiRequestError(401, 'unpaired', 'Pair this phone'))
    reportApiError(new ApiRequestError(400, 'bad_request', 'name: Too long'))
    reportApiError(new ApiRequestError(403, 'pc_only', 'Change this on the PC running Binder'))
    reportForgotten()
    stop()
    reportApiError(new ApiRequestError(401, 'unpaired', 'Pair this phone'))
    expect(seen).toEqual(['unpaired: Pair this phone', 'pc_only: Change this on the PC running Binder', 'forgotten: '])
  })
})

describe('pairingKeyIn', () => {
  it("reads the key a pairing QR code's link carries after #k=", () => {
    expect(pairingKeyIn('#k=Qm9vbGVhbiBrZXkgaGVyZQ')).toBe('Qm9vbGVhbiBrZXkgaGVyZQ')
    expect(pairingKeyIn('k=abc-DEF_123456')).toBe('abc-DEF_123456')
    expect(pairingKeyIn('#x=1&k=abc-DEF_123456&y=2')).toBe('abc-DEF_123456')
  })

  it('finds none in another fragment, or in one that is not a key', () => {
    expect(pairingKeyIn('')).toBeNull()
    expect(pairingKeyIn('#phone-access')).toBeNull()
    expect(pairingKeyIn('#k=')).toBeNull()
    expect(pairingKeyIn('#k=short')).toBeNull()
    expect(pairingKeyIn('#k=has spaces in it')).toBeNull()
    expect(pairingKeyIn('#kk=abcdefghijklmnop')).toBeNull()
  })
})

describe('retryAfterSeconds', () => {
  it("reads a Retry-After header's seconds, and nothing else", () => {
    expect(retryAfterSeconds('42')).toBe(42)
    expect(retryAfterSeconds('0')).toBe(0)
    expect(retryAfterSeconds(null)).toBeUndefined()
    expect(retryAfterSeconds('')).toBeUndefined()
    expect(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined()
  })
})
