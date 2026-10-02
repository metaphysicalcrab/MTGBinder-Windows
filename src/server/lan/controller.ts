import os from 'node:os'
import type { LanPairing, LanStatus } from '../../shared/types.ts'
import type { DB } from '../db/index.ts'
import { getMeta, setMeta } from '../db/meta.ts'
import { ApiError } from '../http.ts'
import type { RunTool } from '../owner-only.ts'
import { createAddressBook, type AddressBook, type Interfaces } from './addresses.ts'
import { createDeviceStore, type DeviceStore } from './devices.ts'
import { createLanListener, type ListenerFetch } from './listener.ts'
import { createPairing, type Pairing } from './pairing.ts'
import { createRateLimiter, type RateLimiter } from './rate-limit.ts'

/** Phone access as the terminal and the tray show it: where phones open Binder, or why they can't. */
export interface LanSummary {
  enabled: boolean
  listening: boolean
  /** The address phones open (the chosen one first), while Binder listens for them. */
  urls: string[]
  error: string | null
}

export interface LanOptions {
  db: DB
  /** The library's `lan/` folder: the devices' secret. */
  dir: string
  /** The phones' port; null when BINDER_LAN=0 turned phone access off for this Binder. */
  port: number | null
  /** Default 0.0.0.0 (every IPv4 network); tests pass 127.0.0.1. */
  host?: string
  /** The app, as the phones' listener serves it. */
  fetch: ListenerFetch
  /** Progress, one line at a time ("[phone] Paired …"). */
  log: (line: string) => void
  /** Told when phone access starts, stops, fails to listen, or moves to another address. */
  onChange?: (summary: LanSummary) => void
  /** Tests pass their own networks, name, clock, and Windows tools. */
  interfaces?: Interfaces
  hostname?: string
  now?: () => number
  platform?: NodeJS.Platform
  run?: RunTool
}

/**
 * Phone access (spec §5.10), owned by startBinder: the phones' listener, started and stopped from Settings while
 * Binder runs (`lan_enabled` in meta, so it's back on after a restart), the address phones open (`lan_address`, or the
 * recommended one), pairing, and the paired devices.
 */
export interface LanController {
  devices: DeviceStore
  pairing: Pairing
  addresses: AddressBook
  limits: {
    /** Routes anyone may call: 120 a minute from one address. */
    public: RateLimiter
    /** Requests without a working cookie: 60 a minute from one address, then 429. */
    unpaired: RateLimiter
    /** Tries at pairing: 10 per 10 minutes from one address. */
    pair: RateLimiter
  }
  hostname: string
  log: (line: string) => void
  status(): LanStatus
  summary(): LanSummary
  /** The address phones open (`http://192.168.1.5:4322`) while Binder listens for them, else null. */
  url(): string | null
  /** Whether phones are on HTTPS; false until HTTPS is turned on. */
  https(): boolean
  /** Turns phone access on or off, and picks the address phones open (null: the recommended one). */
  update(change: { enabled?: boolean; address?: string | null }): Promise<LanStatus>
  /** Opens a pairing window, when Binder is listening for phones. */
  openPairing(): LanPairing
  /** Starts listening when phone access was left on. Never throws: a failure is logged and kept in the status. */
  resume(): Promise<void>
  stop(): Promise<void>
}

const OFF = 'Phone access is off for this Binder: it was started with BINDER_LAN=0'

export function createLanController(options: LanOptions): LanController {
  const { db, log } = options
  const now = options.now ?? Date.now
  const off = options.port === null
  let lastUrl: string | null = null
  const addresses = createAddressBook({
    interfaces: options.interfaces,
    now,
    onChange: () => {
      if (!listener.listening) return
      const url = controller.url()
      if (url !== lastUrl && url !== null) {
        log(`[phone] This PC's address changed: phones now open ${url} (phones paired at the old one must pair again)`)
      }
      changed()
    },
  })
  const listener = createLanListener({
    port: options.port ?? 0,
    host: options.host ?? '0.0.0.0',
    fetch: options.fetch,
    allows: (remote) => addresses.allows(remote),
    platform: options.platform,
  })
  const devices = createDeviceStore({
    db,
    dir: options.dir,
    now: () => new Date(now()),
    platform: options.platform,
    run: options.run,
  })
  const pairing = createPairing({ now })
  const minute = 60_000

  function changed() {
    lastUrl = controller.url()
    options.onChange?.(controller.summary())
  }

  /** The address phones open: the chosen one while it's this PC's, else the recommended one, else the first. */
  function address(): string | null {
    const list = addresses.list()
    const chosen = getMeta(db, 'lan_address')
    if (chosen && list.some((a) => a.address === chosen)) return chosen
    return (list.find((a) => a.recommended) ?? list[0])?.address ?? null
  }

  async function start() {
    await listener.start()
    if (listener.error) {
      log(`[phone] ${listener.error}`)
    } else {
      addresses.watch()
      const url = controller.url()
      log(
        url
          ? `[phone] Phones on this Wi-Fi can open ${url} (pair them in Settings → Phone access)`
          : `[phone] Listening for phones on port ${listener.port}, but this PC isn't on a network a phone can reach`,
      )
    }
    changed()
  }

  async function stop() {
    pairing.cancel()
    addresses.stop()
    await listener.stop()
  }

  const controller: LanController = {
    devices,
    pairing,
    addresses,
    limits: {
      public: createRateLimiter({ limit: 120, perMs: minute, now }),
      unpaired: createRateLimiter({ limit: 60, perMs: minute, now }),
      pair: createRateLimiter({ limit: 10, perMs: 10 * minute, now }),
    },
    hostname: options.hostname ?? os.hostname(),
    log,
    status() {
      const port = listener.port
      return {
        enabled: !off && getMeta(db, 'lan_enabled') === '1',
        https: false,
        port,
        httpsPort: off ? 0 : port + 1,
        listening: listener.listening,
        error: off ? OFF : listener.error,
        addresses: addresses.list(),
        address: getMeta(db, 'lan_address'),
        url: controller.url(),
        setupUrl: null,
        caFingerprint: null,
        pairing: pairing.current(),
        pairingEnded: pairing.ended(),
        devices: devices.list(),
        network: null,
      }
    },
    summary() {
      const chosen = controller.url()
      const others = addresses.list().map((a) => `http://${a.address}:${listener.port}`)
      return {
        enabled: !off && getMeta(db, 'lan_enabled') === '1',
        listening: listener.listening,
        urls: chosen ? [chosen, ...others.filter((url) => url !== chosen)] : [],
        error: off ? OFF : listener.error,
      }
    },
    url() {
      const at = listener.listening ? address() : null
      return at ? `http://${at}:${listener.port}` : null
    },
    https: () => false,
    async update(change) {
      if (change.address != null && !addresses.list().some((a) => a.address === change.address)) {
        throw new ApiError(400, 'bad_address', `${change.address} isn't one of this PC's addresses`)
      }
      if (change.enabled && off) throw new ApiError(409, 'lan_off', OFF)
      if (change.address !== undefined) {
        setMeta(db, 'lan_address', change.address)
        if (listener.listening) changed()
      }
      if (change.enabled !== undefined) setMeta(db, 'lan_enabled', change.enabled ? '1' : '0')
      if (change.enabled === true && !listener.listening) await start()
      if (change.enabled === false && listener.listening) {
        await stop()
        log('[phone] Phone access is off')
        changed()
      }
      return controller.status()
    },
    openPairing() {
      const url = controller.url()
      if (!listener.listening) {
        throw new ApiError(409, 'not_listening', listener.error ?? (off ? OFF : 'Turn on phone access first'))
      }
      if (!url) {
        throw new ApiError(409, 'no_address', "This PC isn't on a network a phone can reach: connect it to the Wi-Fi first")
      }
      return pairing.open((key) => `${url}/pair#k=${key}`)
    },
    async resume() {
      if (!off && getMeta(db, 'lan_enabled') === '1') await start()
    },
    stop,
  }
  return controller
}
