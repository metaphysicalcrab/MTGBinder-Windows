import type os from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'
import { createApp, type AppDeps } from '../../src/server/app.ts'
import type { BulkImporter } from '../../src/server/bulk/import.ts'
import type { AppEnv } from '../../src/server/http.ts'
import { createLanController, type LanOptions } from '../../src/server/lan/controller.ts'
import type { ScryfallClient } from '../../src/server/scryfall/client.ts'
import type { BulkStatus } from '../../src/shared/types.ts'
import { createTestDb } from './db.ts'
import { tempDir } from './tmp.ts'

export const IDLE: BulkStatus = { state: 'idle', processed: 0, error: null, updatedAt: null, sourceUpdatedAt: null, cardCount: 61 }

export function stubBulk(overrides: Partial<BulkImporter> = {}): BulkImporter {
  return { status: () => IDLE, isStale: () => false, staleReason: () => null, start: () => Promise.resolve(), ...overrides }
}

interface ScryfallStubs {
  getJson?: (path: string) => Promise<unknown>
  postJson?: (path: string, body: unknown) => Promise<unknown>
  download?: (url: string) => Promise<Response>
}

/** A Scryfall client that fails loudly unless a test supplies the calls it expects. */
export function stubScryfall(stubs: ScryfallStubs = {}): ScryfallClient {
  const unexpected = () => Promise.reject(new Error('unexpected Scryfall call'))
  return {
    getJson: <T>(path: string) => (stubs.getJson?.(path) ?? unexpected()) as Promise<T>,
    postJson: <T>(path: string, body: unknown) => (stubs.postJson?.(path, body) ?? unexpected()) as Promise<T>,
    download: (url: string) => stubs.download?.(url) ?? unexpected(),
  }
}

/**
 * The app under test. `app.request()` sends no Host header of its own, so requests carry `Host: localhost:4321`
 * (what a browser on this computer sends) unless the test sets one.
 */
export function makeApp(deps: Partial<AppDeps> = {}) {
  const app = createApp({ db: createTestDb(), bulk: stubBulk(), scryfall: stubScryfall(), ...deps })
  return {
    request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers)
      if (!headers.has('host')) headers.set('host', 'localhost:4321')
      return app.request(path, { ...init, headers })
    },
  }
}

export async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/** An IPv4 address on a network adapter, as os.networkInterfaces() lists it. */
export function ipv4(address: string, bits: number, internal = false): os.NetworkInterfaceInfo {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  const netmask = [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255).join('.')
  return { address, netmask, family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/${bits}` }
}

/** The PC the phone tests run against: on the Wi-Fi at 192.168.1.5/24, with WSL's virtual adapter beside it. */
export const TEST_NETWORKS = () => ({
  lo: [ipv4('127.0.0.1', 8, true)],
  'Wi-Fi': [ipv4('192.168.1.5', 24)],
  'vEthernet (WSL)': [ipv4('172.20.0.1', 20)],
})

/** How a request reaches Binder in makeLanApp: by default, from a phone's browser on the Wi-Fi. */
export interface PhoneRequest {
  /** The phone's cookie header (`binder_device=…`), from pair(). */
  cookie?: string
  /** Where it comes from (default 192.168.1.40, a phone on the Wi-Fi). */
  peer?: string
  /** Default the phones' listener ('lan'). */
  listener?: 'local' | 'lan'
  /** Default 192.168.1.5:4322, the PC's address. */
  host?: string
  /** Sent with a request that changes something, as a browser does: by default the page at Host; null sends none. */
  origin?: string | null
}

/** A JSON request body. */
export function json(value: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

/**
 * The app with phone access: its `lan/` folder (`dir`) in a temporary folder, the PC on TEST_NETWORKS and named `binder-pc`,
 * listening on 127.0.0.1 when a test turns it on. `request()` is a phone's request: in on the phones' listener from
 * 192.168.1.40, to Host 192.168.1.5:4322, with Binder's own page as its Origin when it changes something. `local()` is
 * this computer's, as makeApp's. `pair()` pairs a phone and returns its cookie.
 */
export function makeLanApp(deps: Partial<AppDeps> = {}, options: Partial<LanOptions> = {}) {
  const db = deps.db ?? createTestDb()
  const lines: string[] = []
  const dir = options.dir ?? path.join(tempDir('binder-lan-'), 'lan')
  const lan = createLanController({
    db,
    dir,
    port: 0,
    host: '127.0.0.1',
    fetch: (request, env) => app.fetch(request, env),
    log: (line) => lines.push(line),
    interfaces: TEST_NETWORKS,
    hostname: 'binder-pc',
    ...options,
  })
  onTestFinished(() => lan.stop())
  const app = createApp({ db, bulk: stubBulk(), scryfall: stubScryfall(), ...deps, lan })

  async function request(url: string, init: RequestInit = {}, phone: PhoneRequest = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    const host = phone.host ?? '192.168.1.5:4322'
    if (!headers.has('host')) headers.set('host', host)
    const method = init.method ?? 'GET'
    if (phone.origin !== null && method !== 'GET' && method !== 'HEAD' && !headers.has('origin')) {
      headers.set('origin', phone.origin ?? `http://${host}`)
    }
    if (phone.cookie) headers.set('cookie', phone.cookie)
    const env = { listener: phone.listener ?? 'lan', incoming: { socket: { remoteAddress: phone.peer ?? '192.168.1.40' } } }
    return app.request(url, { ...init, headers }, env as AppEnv['Bindings'])
  }

  async function local(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (!headers.has('host')) headers.set('host', 'localhost:4321')
    return app.request(url, { ...init, headers })
  }

  /** Pairs a phone named `name`, with a pairing window opened just for it; returns its cookie header. */
  async function pair(name = 'Pixel 8', phone: PhoneRequest = {}): Promise<string> {
    const { code } = lan.pairing.open((key) => `http://192.168.1.5:4322/pair#k=${key}`)
    const res = await request('/api/lan/pair', json({ code, name }), phone)
    if (res.status !== 201) throw new Error(`Pairing failed: ${res.status} ${await res.text()}`)
    return res.headers.get('set-cookie')!.split(';')[0]!
  }

  return { app, lan, db, dir, lines, request, local, pair }
}
