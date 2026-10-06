import { describe, expect, it } from 'vitest'
import { ApiRequestError, retryAfterSeconds } from '../../src/web/lib/api.ts'
import {
  apiSignal,
  askAgainIn,
  clientFromAnswer,
  clientOnFailure,
  movedToHttps,
  pairingKeyIn,
  reportApiError,
  reportForgotten,
  watchApiSignals,
} from '../../src/web/lib/client.ts'
import { isThisComputersHostname } from '../../src/web/lib/platform.ts'

describe('the gate (spec §5.10)', () => {
  it('shows the app to the PC and a paired phone, and only the pairing page to a phone that is not paired', () => {
    expect(clientFromAnswer({ client: 'pc' })).toEqual({ kind: 'pc' })
    expect(clientFromAnswer({ client: 'device', id: 3, name: 'Pixel 8' })).toEqual({ kind: 'device', id: 3, name: 'Pixel 8' })
    expect(clientFromAnswer({ client: 'unpaired', https: true })).toEqual({ kind: 'unpaired', https: true })
  })

  const failures = [
    new TypeError('Failed to fetch'),
    new DOMException('The operation timed out.', 'TimeoutError'),
    new ApiRequestError(404, 'not_found', 'No API route for GET /api/lan/me'),
    new ApiRequestError(500, 'internal', 'Something went wrong'),
    new ApiRequestError(429, 'rate_limited', 'Too many requests from this device; try again in 26 s', undefined, 26),
  ]

  it('never locks the PC out: no answer, a Binder from before phones, or a failing server shows the app as before', () => {
    for (const hostname of ['127.0.0.1', 'localhost', 'LOCALHOST', '[::1]']) {
      for (const err of failures) expect(clientOnFailure(err, hostname)).toEqual({ kind: 'pc' })
    }
  })

  it("asks again on a phone's address, rather than show a phone the PC's view", () => {
    for (const hostname of ['192.168.1.20', 'desktop-binder.local', '10.0.0.5']) {
      for (const err of failures) expect(clientOnFailure(err, hostname)).toBeNull()
    }
  })

  it('shows the pairing page when the server says this phone is not paired', () => {
    for (const hostname of ['192.168.1.20', '127.0.0.1']) {
      expect(clientOnFailure(new ApiRequestError(401, 'unpaired', 'Pair this phone'), hostname)).toEqual({ kind: 'unpaired', https: false })
    }
  })

  it("takes only this computer's own hostnames as the PC's, as the server does", () => {
    expect(isThisComputersHostname('127.0.0.1')).toBe(true)
    expect(isThisComputersHostname('localhost')).toBe(true)
    expect(isThisComputersHostname('[::1]')).toBe(true)
    expect(isThisComputersHostname('192.168.1.20')).toBe(false)
    expect(isThisComputersHostname('desktop-binder')).toBe(false)
    expect(isThisComputersHostname('localhost.example.com')).toBe(false)
  })

  it('asks again as soon as a 429 allows, else after 1 s, 2 s, 4 s… and never more than 10 s apart', () => {
    expect(askAgainIn(new ApiRequestError(429, 'rate_limited', 'Too many requests', undefined, 26), 1)).toBe(26_000)
    expect(askAgainIn(new ApiRequestError(429, 'rate_limited', 'Too many requests', undefined, 0), 3)).toBe(1000)
    const noAnswer = new TypeError('Failed to fetch')
    expect([1, 2, 3, 4, 5, 9].map((attempt) => askAgainIn(noAnswer, attempt))).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000])
    expect(askAgainIn(new ApiRequestError(500, 'internal', 'Something went wrong'), 2)).toBe(2000)
  })
})

describe('movedToHttps', () => {
  it('knows a page left on plain HTTP after the PC turned HTTPS on, and nothing else', () => {
    expect(movedToHttps(new ApiRequestError(403, 'use_https', 'Open Binder at https://192.168.1.5:4323'))).toBe(true)
    expect(movedToHttps(new ApiRequestError(403, 'pc_only', 'Change this on the PC running Binder'))).toBe(false)
    expect(movedToHttps(new ApiRequestError(401, 'unpaired', 'Pair this phone'))).toBe(false)
    expect(movedToHttps(new Error('use_https'))).toBe(false)
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
