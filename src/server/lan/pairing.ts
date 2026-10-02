import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { LanPairing, LanStatus } from '../../shared/types.ts'

/** How long a pairing window stays open. */
export const PAIRING_MS = 5 * 60_000
/** Wrong codes from one address after which it may try no more at this window. */
export const PAIRING_TRIES = 5
/**
 * Wrong codes from anywhere that close the window: with 8 digits, strangers guess right at most once in 5 million
 * windows. One address can't close it on its own, so a device on the Wi-Fi can't keep the owner from pairing.
 */
export const PAIRING_ALL_TRIES = 20

const digest = (text: string) => createHash('sha256').update(text).digest()

/** What a phone's try at pairing came to. */
export type PairingAttempt =
  | { outcome: 'paired' }
  /**
   * A wrong code or key: this address's `failures`th (its last at PAIRING_TRIES); `closed` when it was the last one
   * the window allowed from anywhere.
   */
  | { outcome: 'wrong'; failures: number; closed: boolean }
  /** No window is open (none was, it expired, or too many wrong codes closed it), or this address may try no more. */
  | { outcome: 'closed'; reason: 'none' | 'expired' | 'too_many_tries' }

/**
 * Pairing a phone (spec §5.10): one window at a time, opened on the PC, kept in memory only (a restart closes it).
 * It holds an 8-digit code to type on the phone and a 128-bit key for the QR code's link, after its `#`: opening the
 * link doesn't send it (no request line, log or Referer holds it), and the pairing page posts it. It closes when a
 * phone pairs (each window pairs one phone), after 5 minutes, after 20 wrong tries, or when the PC cancels it; an
 * address with 5 wrong tries may try no more at it. Codes and keys are compared as SHA-256 digests in constant time.
 */
export interface Pairing {
  /** Opens a new window, closing any open one. `link` makes the QR code's address from the key. */
  open(link: (key: string) => string): LanPairing
  /** The open window, or null. */
  current(): LanPairing | null
  /** How the last window ended (LanStatus.pairingEnded). */
  ended(): LanStatus['pairingEnded']
  /** Closes the window without saying why: the PC closed the dialog. */
  cancel(): void
  /**
   * Checks a phone's code (spaces and dashes ignored) or key, from the address it came from. A right one closes the
   * window, so it pairs one phone.
   */
  attempt(input: { code?: string; key?: string }, from: string): PairingAttempt
  /** Notes the phone a right code paired, for the PC to show. */
  paired(name: string): void
}

interface OpenWindow {
  /** What the PC shows. */
  shown: LanPairing
  code: Buffer
  key: Buffer
  expires: number
  /** Wrong tries from each address, and from all of them. */
  failures: Map<string, number>
  allFailures: number
}

export function createPairing(options: { now?: () => number } = {}): Pairing {
  const now = options.now ?? Date.now
  let open: OpenWindow | null = null
  let ended: LanStatus['pairingEnded'] = null

  /** The open window, closing it first if its time is up. */
  function live(): OpenWindow | null {
    if (open && now() >= open.expires) {
      open = null
      ended = { reason: 'expired', name: null }
    }
    return open
  }

  return {
    open(link) {
      const code = String(randomInt(0, 100_000_000)).padStart(8, '0')
      const key = randomBytes(16).toString('base64url')
      const expires = now() + PAIRING_MS
      open = {
        shown: { code, url: link(key), expiresAt: new Date(expires).toISOString() },
        code: digest(code),
        key: digest(key),
        expires,
        failures: new Map(),
        allFailures: 0,
      }
      ended = null
      return open.shown
    },
    current: () => live()?.shown ?? null,
    ended: () => (live(), ended),
    cancel() {
      open = null
      ended = null
    },
    attempt(input, from) {
      const opened = live()
      if (!opened) {
        const reason = ended?.reason === 'too_many_tries' || ended?.reason === 'expired' ? ended.reason : 'none'
        return { outcome: 'closed', reason }
      }
      const tried = opened.failures.get(from) ?? 0
      if (tried >= PAIRING_TRIES) return { outcome: 'closed', reason: 'too_many_tries' }
      const code = input.code?.replace(/[\s-]/g, '')
      const right =
        (code !== undefined && timingSafeEqual(digest(code), opened.code)) ||
        (input.key !== undefined && timingSafeEqual(digest(input.key), opened.key))
      if (right) {
        open = null
        ended = { reason: 'paired', name: null }
        return { outcome: 'paired' }
      }
      opened.failures.set(from, tried + 1)
      opened.allFailures++
      const closed = opened.allFailures >= PAIRING_ALL_TRIES
      if (closed) {
        open = null
        ended = { reason: 'too_many_tries', name: null }
      }
      return { outcome: 'wrong', failures: tried + 1, closed }
    },
    paired(name) {
      if (ended?.reason === 'paired') ended = { reason: 'paired', name }
    },
  }
}
