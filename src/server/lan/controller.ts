import os from 'node:os'
import type { LanAddress, LanPairing, LanStatus, LanSummary } from '../../shared/types.ts'
import type { DB } from '../db/index.ts'
import { getMeta, setMeta } from '../db/meta.ts'
import { ApiError } from '../http.ts'
import type { RunTool } from '../owner-only.ts'
import { computerNoun } from '../platform.ts'
import { createAddressBook, type AddressBook, type Interfaces } from './addresses.ts'
import { ensureCertificates, readAuthority, rotateAuthority, type AuthorityInfo, type LanCertificates } from './certs.ts'
import { createDeviceStore, type DeviceStore } from './devices.ts'
import { createLanListener, type ListenerFetch } from './listener.ts'
import { windowsNetworkProfile, type NetworkProfile } from './network-profile.ts'
import { createPairing, type Pairing } from './pairing.ts'
import { createRateLimiter, type RateLimiter } from './rate-limit.ts'

export type { LanSummary } from '../../shared/types.ts'

export interface LanOptions {
  db: DB
  /** The library's `lan/` folder: the devices' secret, and the certificates for HTTPS. */
  dir: string
  /**
   * The phones' port; null when BINDER_LAN=0 turned phone access off for this Binder. HTTPS is on the next one up (0
   * picks a free port for each).
   */
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
  /**
   * Windows' profile of the network an adapter is on (network-profile.ts), read in the background. Networks a test
   * made up (`interfaces`) have none, unless it passes its own.
   */
  networkProfile?: (interfaceName: string) => Promise<NetworkProfile | null>
}

/** Phone access over HTTPS, as the phones' HTTP port needs it (the guard). */
export interface HttpsSetup {
  /** HTTPS for phones is on in Settings. */
  on: boolean
  /** The port Binder takes HTTPS on, while it does; null when it's off or couldn't listen. */
  port: number | null
  /** The certificate authority phones install, once made, while HTTPS is on. */
  authority: AuthorityInfo | null
}

/**
 * Phone access (spec §5.10), owned by startBinder: the phones' listener, started and stopped from Settings while
 * Binder runs (`lan_enabled` in meta, so it's back on after a restart), HTTPS beside it when that's on (`lan_https`),
 * the address phones open (`lan_address`, or the recommended one), pairing, and the paired devices.
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
  /** Whether Binder listens for phones now. */
  listening(): boolean
  /**
   * The address phones open (`http://192.168.1.5:4322`, or `https://192.168.1.5:4323` with HTTPS) while Binder
   * listens for them, else null.
   */
  url(): string | null
  /** Whether phones use HTTPS now: it's on, and Binder takes it. */
  https(): boolean
  httpsSetup(): HttpsSetup
  /**
   * Turns phone access on or off, and HTTPS, and picks the address phones open (null: the recommended one). Changes
   * are made one at a time, in the order they came, so turning it off while it's still starting leaves it off.
   */
  update(change: { enabled?: boolean; https?: boolean; address?: string | null }): Promise<LanStatus>
  /** Makes a new certificate authority for HTTPS, served at once: phones must install it again. */
  rotate(): Promise<LanStatus>
  /** Opens a pairing window, when Binder is listening for phones. */
  openPairing(): LanPairing
  /** Starts listening when phone access was left on. Never throws: a failure is logged and kept in the status. */
  resume(): Promise<void>
  /** Stops listening for phones (Binder is stopping), after any change still being made. */
  stop(): Promise<void>
}

const OFF = 'Phone access is off for this Binder: it was started with BINDER_LAN=0'
const DAY_MS = 86_400_000

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function createLanController(options: LanOptions): LanController {
  const { db, log } = options
  const now = options.now ?? Date.now
  const off = options.port === null
  const hostname = options.hostname ?? os.hostname()
  /** What Settings calls this computer: "Mac", "PC", or "computer". */
  const computer = computerNoun(options.platform)
  let lastUrl: string | null = null
  const addresses = createAddressBook({
    interfaces: options.interfaces,
    now,
    onChange: () => {
      if (!listener.listening) return
      // The server certificate names every address the PC has: one for the new set, served once it's made.
      if (secure.listening) void renew()
      const url = controller.url()
      if (url !== lastUrl && url !== null) {
        log(`[phone] This ${computer}'s address changed: phones now open ${url} (phones paired at the old one must pair again)`)
      }
      changed()
    },
    onPoll: () => {
      readNetwork()
      // At least daily: the server certificate is renewed 30 days before it ends.
      if (secure.listening && now() - checkedAt >= DAY_MS) void renew()
    },
  })
  const allows = (remote: string | undefined) => addresses.allows(remote)
  const host = options.host ?? '0.0.0.0'
  const listener = createLanListener({
    port: options.port ?? 0,
    host,
    fetch: options.fetch,
    allows,
    platform: options.platform,
  })
  // HTTPS, on the next port up, with the certificates made before it starts (startHttps).
  const secure = createLanListener({
    port: options.port ? options.port + 1 : 0,
    host,
    fetch: options.fetch,
    allows,
    certificate: () => certificates!,
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
  /** The last change to phone access (update, rotate, resume, stop), which the next one waits for. */
  let changing: Promise<unknown> = Promise.resolve()
  /** HTTPS's certificates, once made: kept while Binder runs (the setup page offers the authority). */
  let certificates: LanCertificates | null = null
  /** Why they couldn't be made, until they are. */
  let certificateError: string | null = null
  /**
   * The authority in `dir`, as last read for the status while this run has made no certificates (authority()): read
   * once, and again after certify() may have changed the files.
   */
  let stored: { authority: AuthorityInfo | null } | null = null
  /** When they were last checked, and made again if due. */
  let checkedAt = 0
  /** Whether this Binder replaced the authority phones had installed. */
  let replaced = false
  /** Windows' network profile, as last read, for the adapter it was read for. */
  let network: { interfaceName: string; profile: NetworkProfile | null } | null = null
  const networkProfile =
    options.networkProfile ??
    (options.interfaces
      ? async () => null
      : (interfaceName: string) => windowsNetworkProfile({ interfaceName, platform: options.platform }))

  function serially<T>(change: () => Promise<T>): Promise<T> {
    const next = changing.then(change)
    changing = next.catch(() => {})
    return next
  }

  const enabled = () => !off && getMeta(db, 'lan_enabled') === '1'
  const httpsOn = () => !off && getMeta(db, 'lan_https') === '1'

  function changed() {
    lastUrl = controller.url()
    options.onChange?.(controller.summary())
  }

  /** The address phones open: the chosen one while it's this PC's, else the recommended one, else the first. */
  function chosen(): LanAddress | null {
    const list = addresses.list()
    const address = getMeta(db, 'lan_address')
    return list.find((a) => a.address === address) ?? list.find((a) => a.recommended) ?? list[0] ?? null
  }

  /** Where a phone opens Binder at an address: over HTTPS while Binder takes it, else over HTTP. */
  const urlAt = (address: string) =>
    secure.listening ? `https://${address}:${secure.port}` : `http://${address}:${listener.port}`

  /** The page a phone installs the certificate from, while HTTPS is on and Binder listens for phones. */
  function setupUrl(): string | null {
    const address = listener.listening && httpsOn() ? chosen()?.address : undefined
    return address ? `http://${address}:${listener.port}/phone-setup` : null
  }

  /** Why phones can't use HTTPS while it's on and Binder listens for them: its certificate, or its port. */
  function httpsError(): string | null {
    return listener.listening && httpsOn() ? (certificateError ?? secure.error) : null
  }

  /** Reads Windows' network profile for the adapter phones reach the PC through, in the background. */
  function readNetwork(): void {
    const interfaceName = chosen()?.interface
    if (!interfaceName) return
    networkProfile(interfaceName).then(
      (profile) => (network = { interfaceName, profile }),
      () => {},
    )
  }

  /**
   * Makes HTTPS's certificates, or checks them and makes again what's due (a new address, fewer than 30 days left, a
   * damaged file), and serves what's new. With `rotate`, a new authority. Throws when they can't be made.
   */
  async function certify(rotate = false): Promise<void> {
    checkedAt = now()
    const made = await (rotate ? rotateAuthority : ensureCertificates)({
      dir: options.dir,
      // A phone that opens an address sends no name to pick a certificate by, so one names every address.
      addresses: addresses.list().map((a) => a.address),
      hostnames: [hostname, `${hostname}.local`],
      computerName: hostname,
      now: new Date(now()),
      platform: options.platform,
      run: options.run,
    }).finally(() => (stored = null)) // made or not, the files may have changed: the status reads them again
    certificates = made
    certificateError = null
    if (made.reissued) secure.setCertificate(made)
    if (made.authority === 'replaced') {
      replaced = true
      if (!rotate) {
        log(
          "[phone] Binder made a new certificate for HTTPS, as the old one's files were missing, damaged or near " +
            `their end: install it on each phone again, from ${setupUrl() ?? 'the phone setup page'}`,
        )
      }
    }
  }

  /**
   * The authority phones install: the one this run made or checked, else the one in `dir` from before (phone access is
   * off, or HTTPS hasn't started), so the status says the same either way; null when there's none that's usable, or its
   * files can't be read just now.
   */
  function authority(): AuthorityInfo | null {
    if (certificates) return certificates
    try {
      stored ??= { authority: readAuthority(options.dir, new Date(now())) }
    } catch {
      return null // another program has its files open: read them next time
    }
    return stored.authority
  }

  /** certify() in the background: a failure is logged, and the certificate served until then kept. */
  function renew(): Promise<void> {
    return certify().catch((err: unknown) => log(`[phone] Couldn't renew the certificate for HTTPS: ${message(err)}`))
  }

  /** Starts HTTPS beside HTTP: its certificates, then its listener. A failure is logged, and kept in the status. */
  async function startHttps(): Promise<void> {
    try {
      await certify()
    } catch (err) {
      certificateError = `Couldn't make the certificate for HTTPS: ${message(err)}`
      log(`[phone] ${certificateError}`)
      return
    }
    await secure.start()
    if (secure.error) log(`[phone] ${secure.error}`)
  }

  async function stopHttps(): Promise<void> {
    await secure.stop()
    certificateError = null
  }

  async function start() {
    await listener.start()
    if (listener.error) {
      log(`[phone] ${listener.error}`)
    } else {
      addresses.watch()
      readNetwork()
      if (httpsOn()) await startHttps()
      const url = controller.url()
      log(
        url
          ? `[phone] Phones on this Wi-Fi can open ${url} (pair them in Settings → Phone access)`
          : `[phone] Listening for phones on port ${listener.port}, but this ${computer} isn't on a network a phone can reach`,
      )
      const setup = secure.listening ? setupUrl() : null
      if (setup) log(`[phone] Each phone installs Binder's certificate for HTTPS once, from ${setup}`)
    }
    changed()
  }

  async function stop() {
    pairing.cancel()
    addresses.stop()
    await Promise.all([listener.stop(), stopHttps()])
  }

  /** Starts or stops HTTPS as Settings now says, while Binder listens for phones. */
  async function switchHttps() {
    if (httpsOn()) {
      if (secure.listening) return
      await startHttps()
      if (secure.listening) {
        log(
          `[phone] HTTPS is on: phones open ${controller.url() ?? `port ${secure.port}`}. Each installs Binder's ` +
            `certificate once, from ${setupUrl() ?? 'the phone setup page'}; phones paired over HTTP must pair again`,
        )
      }
    } else {
      if (!secure.listening && !secure.error && !certificateError) return
      await stopHttps()
      const url = controller.url() ?? 'Binder over HTTP'
      log(`[phone] HTTPS is off: phones open ${url} (phones paired over HTTPS must pair again)`)
    }
    changed()
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
    hostname,
    log,
    status() {
      const port = listener.port
      const on = httpsOn()
      const ca = on ? authority() : null
      readNetwork() // for next time: the first read on Windows takes a second or two
      const interfaceName = chosen()?.interface
      return {
        enabled: enabled(),
        https: on,
        port,
        httpsPort: secure.listening ? secure.port : off || port === 0 ? 0 : port + 1,
        listening: listener.listening,
        error: off ? OFF : (listener.error ?? httpsError()),
        addresses: addresses.list(),
        address: getMeta(db, 'lan_address'),
        url: controller.url(),
        setupUrl: setupUrl(),
        caFingerprint: ca?.caFingerprint ?? null,
        caName: ca?.caName ?? null,
        caReplaced: on && replaced,
        pairing: pairing.current(),
        pairingEnded: pairing.ended(),
        devices: devices.list(),
        network: network && network.interfaceName === interfaceName ? network.profile : null,
      }
    },
    summary() {
      const url = controller.url()
      const others = addresses.list().map((a) => urlAt(a.address))
      return {
        enabled: enabled(),
        available: !off,
        listening: listener.listening,
        urls: url ? [url, ...others.filter((other) => other !== url)] : [],
        error: off ? OFF : (listener.error ?? httpsError()),
      }
    },
    listening: () => listener.listening,
    url() {
      const address = listener.listening ? chosen()?.address : undefined
      return address ? urlAt(address) : null
    },
    https: () => secure.listening,
    httpsSetup: () => ({
      on: httpsOn(),
      port: secure.listening ? secure.port : null,
      authority: httpsOn() ? certificates : null,
    }),
    async update(change) {
      if (change.address != null && !addresses.list().some((a) => a.address === change.address)) {
        throw new ApiError(400, 'bad_address', `${change.address} isn't one of this ${computer}'s addresses`)
      }
      if ((change.enabled || change.https) && off) throw new ApiError(409, 'lan_off', OFF)
      return serially(async () => {
        if (change.address !== undefined) {
          setMeta(db, 'lan_address', change.address)
          if (listener.listening) {
            readNetwork()
            changed()
          }
        }
        const was = enabled() || listener.listening
        if (change.enabled !== undefined) setMeta(db, 'lan_enabled', change.enabled ? '1' : '0')
        if (change.https !== undefined) setMeta(db, 'lan_https', change.https ? '1' : '0')
        if (change.enabled === true && !listener.listening) await start()
        else if (change.https !== undefined && change.enabled !== false && listener.listening) await switchHttps()
        if (change.enabled === false && was) {
          // Whether it was listening or had failed to: either way it's off now, and its error with it.
          await stop()
          log('[phone] Phone access is off')
          changed()
        }
        return controller.status()
      })
    },
    rotate() {
      if (!httpsOn()) return Promise.reject(new ApiError(409, 'https_off', 'Turn on HTTPS for phones first'))
      return serially(async () => {
        try {
          await certify(true)
        } catch (err) {
          throw new ApiError(500, 'certificate_failed', `Couldn't make a new certificate: ${message(err)}`)
        }
        log(
          '[phone] Binder made a new certificate for HTTPS: on each phone, remove the old one and install this one, ' +
            `from ${setupUrl() ?? 'the phone setup page'}`,
        )
        // HTTPS that couldn't start for want of a certificate starts now.
        if (listener.listening && !secure.listening) {
          await startHttps()
          changed()
        }
        return controller.status()
      })
    },
    openPairing() {
      const url = controller.url()
      if (!listener.listening) {
        throw new ApiError(409, 'not_listening', listener.error ?? (off ? OFF : 'Turn on phone access first'))
      }
      if (!url) {
        const why = `This ${computer} isn't on a network a phone can reach: connect it to the Wi-Fi first`
        throw new ApiError(409, 'no_address', why)
      }
      return pairing.open((key) => `${url}/pair#k=${key}`)
    },
    resume() {
      return serially(async () => {
        if (enabled()) await start()
      })
    },
    stop: () => serially(stop),
  }
  return controller
}
