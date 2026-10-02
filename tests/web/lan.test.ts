import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanStatus } from '../../src/shared/types.ts'
import { ApiRequestError } from '../../src/web/lib/api.ts'
import {
  addressInUse,
  agoText,
  cancelPairingAsPageGoes,
  codeDigits,
  countdownText,
  firewallNotes,
  groupCode,
  lastSeenText,
  pairErrorText,
  pairingEndedText,
  pairsAgainText,
  phoneNameGuess,
  phonesUseHttps,
  waitText,
} from '../../src/web/lib/lan.ts'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MINUTE = 60_000

describe('the pairing code', () => {
  it('keeps only the digits typed, spaces and dashes left out, and no more than 8', () => {
    expect(codeDigits('4821 0937')).toBe('48210937')
    expect(codeDigits('4821-0937')).toBe('48210937')
    expect(codeDigits(' 48 21 – 09 37 ')).toBe('48210937')
    expect(codeDigits('482109371')).toBe('48210937')
    expect(codeDigits('abc')).toBe('')
  })

  it('is shown in two groups of four, as the PC shows it, and grouped as it is typed', () => {
    expect(groupCode('48210937')).toBe('4821 0937')
    expect(groupCode('4821-0937')).toBe('4821 0937')
    expect(groupCode('4821')).toBe('4821')
    expect(groupCode('48210')).toBe('4821 0')
    expect(groupCode('')).toBe('')
  })
})

describe('when a phone was last seen', () => {
  it('says how long ago, as a person would', () => {
    expect(agoText(ago(20_000), NOW)).toBe('just now')
    expect(agoText(ago(2 * MINUTE + 5000), NOW)).toBe('2 min ago')
    expect(agoText(ago(59 * MINUTE), NOW)).toBe('59 min ago')
    expect(agoText(ago(60 * MINUTE), NOW)).toBe('an hour ago')
    expect(agoText(ago(5 * 60 * MINUTE), NOW)).toBe('5 hours ago')
    expect(agoText(ago(30 * 60 * MINUTE), NOW)).toBe('yesterday')
    expect(agoText(ago(6 * 24 * 60 * MINUTE), NOW)).toBe('6 days ago')
    expect(agoText(ago(40 * 24 * 60 * MINUTE), NOW)).toMatch(/^on .*2026/)
    // A phone's clock a little ahead of the PC's.
    expect(agoText(ago(-5000), NOW)).toBe('just now')
  })

  it('says from where, when the PC knows', () => {
    expect(lastSeenText({ lastSeenAt: ago(2 * MINUTE), lastIp: '192.168.1.23' }, NOW)).toBe('Last seen 2 min ago from 192.168.1.23')
    expect(lastSeenText({ lastSeenAt: ago(2 * MINUTE), lastIp: null }, NOW)).toBe('Last seen 2 min ago')
    expect(lastSeenText({ lastSeenAt: null, lastIp: null }, NOW)).toBe('Not seen since it paired')
  })
})

describe('the pairing dialog', () => {
  it('counts down the time left on the code, to 0:00', () => {
    expect(countdownText(new Date(NOW + 5 * MINUTE).toISOString(), NOW)).toBe('5:00')
    expect(countdownText(new Date(NOW + 299_400).toISOString(), NOW)).toBe('5:00')
    expect(countdownText(new Date(NOW + 61_000).toISOString(), NOW)).toBe('1:01')
    expect(countdownText(new Date(NOW + 9_000).toISOString(), NOW)).toBe('0:09')
    expect(countdownText(new Date(NOW - 3_000).toISOString(), NOW)).toBe('0:00')
  })

  it('says how pairing ended', () => {
    expect(pairingEndedText({ reason: 'paired', name: 'Pixel 8' })).toBe('Paired “Pixel 8”.')
    expect(pairingEndedText({ reason: 'expired', name: null })).toBe('The code expired before a phone used it.')
    expect(pairingEndedText({ reason: 'too_many_tries', name: null })).toBe('Too many wrong codes, so pairing stopped.')
  })
})

describe('the pairing page', () => {
  it("offers the phone's model as its name where the browser says it, else what kind of device it is", () => {
    const android = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36'
    expect(phoneNameGuess('Pixel 8', android, 'android')).toBe('Pixel 8')
    expect(phoneNameGuess(' SM-S918B ', android, 'android')).toBe('SM-S918B')
    expect(phoneNameGuess(undefined, android, 'android')).toBe('Android phone')
    expect(phoneNameGuess('', android, 'android')).toBe('Android phone')
    expect(phoneNameGuess(undefined, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'other')).toBe('iPhone')
    expect(phoneNameGuess(undefined, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows')).toBe('Windows PC')
    expect(phoneNameGuess('x'.repeat(80), android, 'android')).toHaveLength(60)
  })

  it("says why pairing failed: the server's words, how long to wait, or what to check when nothing answered", () => {
    expect(pairErrorText(new ApiRequestError(400, 'wrong_code', "That code isn't right: check the code on the PC and type it again"))).toBe(
      "That code isn't right: check the code on the PC and type it again.",
    )
    expect(pairErrorText(new ApiRequestError(409, 'not_pairing', 'That code has expired: on the PC, start pairing again'))).toBe(
      'That code has expired: on the PC, start pairing again.',
    )
    const limited = new ApiRequestError(
      429,
      'rate_limited',
      'Too many tries at pairing from this phone; try again in 412 s',
      undefined,
      412,
    )
    expect(pairErrorText(limited)).toBe('Too many tries at pairing from this phone: try again in 7\u00a0min.')
    const shortWait = new ApiRequestError(
      429,
      'rate_limited',
      'Too many tries at pairing from this phone; try again in 40 s',
      undefined,
      40,
    )
    expect(pairErrorText(shortWait)).toBe('Too many tries at pairing from this phone: try again in 40\u00a0s.')
    expect(pairErrorText(new TypeError('Failed to fetch'))).toMatch(/^Couldn't reach Binder on the PC/)
  })

  it('says a wait as a person would, the number and its unit kept on one line', () => {
    expect(waitText(0.2)).toBe('1\u00a0s')
    expect(waitText(59)).toBe('59\u00a0s')
    expect(waitText(60)).toBe('1\u00a0min')
    expect(waitText(61)).toBe('2\u00a0min')
  })
})

/** A PC's phone access, as GET /api/lan answers it. */
function status(change: Partial<LanStatus> = {}): Pick<LanStatus, 'network' | 'addresses' | 'address'> {
  return {
    addresses: [
      { address: '192.168.1.5', interface: 'Wi-Fi', recommended: true },
      { address: '10.0.0.7', interface: 'Ethernet', recommended: false },
      { address: '172.24.0.1', interface: 'vEthernet (WSL)', recommended: false },
    ],
    address: null,
    network: null,
    ...change,
  }
}

describe('the address phones open', () => {
  it('is the chosen one while it is this PC’s, else the recommended one', () => {
    expect(addressInUse(status())).toBe('192.168.1.5')
    expect(addressInUse(status({ address: '10.0.0.7' }))).toBe('10.0.0.7')
    expect(addressInUse(status({ address: '192.168.7.7' }))).toBe('192.168.1.5')
    expect(addressInUse({ address: null, addresses: [{ address: '10.0.0.7', interface: 'eth0', recommended: false }] })).toBe('10.0.0.7')
    expect(addressInUse({ address: null, addresses: [] })).toBeNull()
  })
})

describe('the paired phones', () => {
  const http = { https: false, url: 'http://192.168.1.5:4322' }
  const https = { https: true, url: 'https://192.168.1.5:4323' }

  it('say which must pair again: paired over HTTP while phones open Binder over HTTPS, and the reverse', () => {
    expect(pairsAgainText({ https: false }, http)).toBeNull()
    expect(pairsAgainText({ https: true }, https)).toBeNull()
    expect(pairsAgainText({ https: false }, https)).toBe('Paired over HTTP: it must pair again to open Binder over HTTPS.')
    expect(pairsAgainText({ https: true }, http)).toBe('Paired over HTTPS: it must pair again to open Binder while HTTPS is off.')
  })

  it('go by the address phones open: HTTPS turned on but not working leaves them on HTTP; with phone access off, as it will be', () => {
    // HTTPS is on, but its port or certificate failed: phones open Binder over HTTP meanwhile, as they paired.
    const failed = { https: true, url: 'http://192.168.1.5:4322' }
    expect(phonesUseHttps(failed)).toBe(false)
    expect(pairsAgainText({ https: false }, failed)).toBeNull()
    expect(phonesUseHttps({ https: true, url: null })).toBe(true)
    expect(phonesUseHttps({ https: false, url: null })).toBe(false)
    expect(pairsAgainText({ https: false }, { https: true, url: null })).toMatch(/^Paired over HTTP:/)
  })
})

describe('the firewall notes', () => {
  it('warns on Windows when it calls the network Public, saying where to make it Private, for Wi-Fi or Ethernet', () => {
    const wifi = firewallNotes(status({ network: { publicProfile: true, name: 'Home 5G' } }), 'windows', false, true)
    expect(wifi).toEqual([
      {
        tone: 'warning',
        text:
          'Windows has Home 5G as a Public network, where its firewall blocks phones: make it Private (Windows 11: Settings → ' +
          'Network & internet → Wi-Fi → Home 5G properties → Network profile type → Private network; Windows 10: Settings → ' +
          'Network & Internet → Wi-Fi → Home 5G → Network profile → Private).',
      },
    ])
    const ethernet = status({ address: '10.0.0.7', network: { publicProfile: true, name: 'Network 2' } })
    const wired = firewallNotes(ethernet, 'windows', false, true)
    expect(wired[0]!.text).toContain('Network & internet → Ethernet → Network profile type → Private network')
    expect(firewallNotes(status({ network: { publicProfile: false, name: 'Home 5G' } }), 'windows', false, true)).toEqual([])
  })

  it("says what the system's firewall asks, until a phone has paired", () => {
    const windows = firewallNotes(status(), 'windows', true, true)
    expect(windows).toEqual([
      {
        tone: 'tip',
        text:
          'The first time, Windows asks whether Binder may use the network: allow it on Private networks. If it was cancelled, ' +
          "phones can't connect until Binder is allowed in Windows Security → Firewall & network protection → Allow an app through " +
          'firewall.',
      },
    ])
    // Under pnpm start, Node.js listens for phones, and Windows asks about it, and lists it, by its own name.
    expect(firewallNotes(status(), 'windows', true, false)).toEqual([
      {
        tone: 'tip',
        text:
          'The first time, Windows asks whether Node.js JavaScript Runtime (node.exe, which runs Binder from the terminal) may use ' +
          "the network: allow it on Private networks. If it was cancelled, phones can't connect until Node.js JavaScript Runtime " +
          'is allowed in Windows Security → Firewall & network protection → Allow an app through firewall.',
      },
    ])
    expect(firewallNotes(status(), 'mac', true, true)).toEqual([
      {
        tone: 'tip',
        text: 'macOS may ask whether Binder may accept incoming connections: choose Allow. It may ask again after Binder is rebuilt.',
      },
    ])
    expect(firewallNotes(status(), 'mac', false, true)).toEqual([])
    expect(firewallNotes(status(), 'other', true, true)).toEqual([])
    // Only Windows has network profiles.
    expect(firewallNotes(status({ network: { publicProfile: true, name: 'Home 5G' } }), 'mac', false, true)).toEqual([])
  })
})

describe('closing the pairing window as the page goes away', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the cancel as a request that outlives the page, and minds no failure', async () => {
    const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.reject(new TypeError('Failed to fetch')))
    vi.stubGlobal('fetch', fetch)
    cancelPairingAsPageGoes()
    expect(fetch).toHaveBeenCalledWith('/api/lan/pairing', { method: 'DELETE', keepalive: true })
    await Promise.resolve()
  })
})
