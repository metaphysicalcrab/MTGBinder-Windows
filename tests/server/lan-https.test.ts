import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import type os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { openDb } from '../../src/server/db/index.ts'
import { setMeta } from '../../src/server/db/meta.ts'
import { lanListenFailure } from '../../src/server/lan/listener.ts'
import type { NetworkProfile } from '../../src/server/lan/network-profile.ts'
import { type BinderOptions, type RunningBinder, startBinder } from '../../src/server/start.ts'
import type { ApiErrorBody, LanPairing, LanStatus } from '../../src/shared/types.ts'
import { body, ipv4, json, makeLanApp, stubScryfall, TEST_NETWORKS } from '../helpers/app.ts'
import { tempDir } from '../helpers/tmp.ts'

const error = async (res: Response) => [res.status, (await body<ApiErrorBody>(res)).error.code]

/** Phone access turned on from Settings on the PC, with HTTPS, listening on 127.0.0.1 (so no firewall asks). */
async function withHttps(app: ReturnType<typeof makeLanApp>): Promise<LanStatus> {
  const res = await app.local('/api/lan', json({ enabled: true, https: true }, 'PUT'))
  expect(res.status).toBe(200)
  return body<LanStatus>(res)
}

/** The authority a phone downloads from the setup page, as PEM. */
async function downloadAuthority(app: ReturnType<typeof makeLanApp>): Promise<string> {
  const res = await app.request('/binder-ca.crt')
  expect(res.status).toBe(200)
  return new crypto.X509Certificate(Buffer.from(await res.arrayBuffer())).toString()
}

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}

/**
 * A request to the HTTPS listener on 127.0.0.1, from a client that trusts only `ca` and checks that the certificate is
 * for `as`, as a phone that opened https://<as>:<port> does (with that as its Host).
 */
function overHttps(port: number, ca: string, url: string, init: { as?: string } = {}): Promise<Answer> {
  const as = init.as ?? '192.168.1.5'
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: '127.0.0.1',
        port,
        path: url,
        ca,
        agent: false,
        headers: { host: `${as}:${port}` },
        checkServerIdentity: (_host, cert) => tls.checkServerIdentity(as, cert),
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
      },
    )
    request.on('error', reject)
    request.end()
  })
}

/** Sends `request` as it is to 127.0.0.1:`port`, and returns what came back, once the connection closes. */
function rawHttp(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request))
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (text += chunk))
    socket.on('end', () => resolve(text))
    socket.on('error', reject)
  })
}

/** A port another program is listening on, with the port just below it free. */
async function takenPortAboveAFreeOne(): Promise<number> {
  for (;;) {
    const taken = net.createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
    const port = (taken.address() as net.AddressInfo).port
    const below = net.createServer()
    const free = await new Promise<boolean>((resolve) => {
      below.once('error', () => resolve(false))
      below.listen(port - 1, '127.0.0.1', () => below.close(() => resolve(true)))
    })
    if (free) {
      onTestFinished(() => new Promise<void>((resolve) => taken.close(() => resolve())))
      return port
    }
    taken.close()
  }
}

describe('phone access over HTTPS (spec §5.10)', () => {
  it("serves phones over HTTPS on the next port, with a certificate only Binder's authority vouches for", async () => {
    const app = makeLanApp()
    const status = await withHttps(app)
    expect(status).toMatchObject({ enabled: true, https: true, listening: true, error: null, caReplaced: false })
    expect(status.httpsPort).toBeGreaterThan(0)
    expect(status.httpsPort).not.toBe(status.port)
    expect(status.url).toBe(`https://192.168.1.5:${status.httpsPort}`)
    expect(status.setupUrl).toBe(`http://192.168.1.5:${status.port}/phone-setup`)
    expect(status.caFingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/)
    expect(status.caName).toMatch(/^Binder on binder-pc \(\d{4}-\d{2}-\d{2}\)$/)
    expect(app.lan.summary().urls[0]).toBe(status.url)

    const ca = await downloadAuthority(app)
    expect(new crypto.X509Certificate(ca).fingerprint256).toBe(status.caFingerprint)
    const health = await overHttps(status.httpsPort, ca, '/api/health')
    expect([health.status, JSON.parse(health.text)]).toEqual([200, { ok: true }])
    // By the PC's name too, and the same app by the phones' rules: who's asking, and nothing without pairing.
    expect(JSON.parse((await overHttps(status.httpsPort, ca, '/api/lan/me', { as: 'binder-pc.local' })).text)).toEqual({
      client: 'unpaired',
      https: true,
    })
    expect((await overHttps(status.httpsPort, ca, '/api/collection/stats')).status).toBe(401)
    // A phone that hasn't installed Binder's authority trusts none of it.
    await expect(overHttps(status.httpsPort, tls.rootCertificates.join('\n'), '/api/health')).rejects.toMatchObject({
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    })
    expect(app.lines.slice(-2)).toEqual([
      `[phone] Phones on this Wi-Fi can open https://192.168.1.5:${status.httpsPort} (pair them in Settings → Phone access)`,
      `[phone] Each phone installs Binder's certificate for HTTPS once, from http://192.168.1.5:${status.port}/phone-setup`,
    ])
  })

  it('sends phones on the HTTP port to HTTPS: pages to the same address there, the API refused', async () => {
    const app = makeLanApp()
    const { httpsPort } = await withHttps(app)
    const page = await app.request('/decks/12?tab=cards')
    expect([page.status, page.headers.get('location')]).toEqual([302, `https://192.168.1.5:${httpsPort}/decks/12?tab=cards`])
    // At the address or name the phone used.
    const named = await app.request('/', {}, { host: 'binder-pc.local:4322' })
    expect(named.headers.get('location')).toBe(`https://binder-pc.local:${httpsPort}/`)
    const api = await app.request('/api/health')
    expect(await body(api)).toEqual({ error: { code: 'use_https', message: `Open Binder at https://192.168.1.5:${httpsPort}` } })
    expect(api.status).toBe(403)
    expect(await error(await app.request('/api/lan/pair', json({ code: '12345678', name: 'Pixel 8' })))).toEqual([403, 'use_https'])
    // Still refused for a Host that isn't this PC.
    expect(await error(await app.request('/decks', {}, { host: 'evil.example' }))).toEqual([403, 'wrong_host'])
    // This computer's listener is as it was.
    expect((await app.local('/api/health')).status).toBe(200)
  })

  it('offers the setup page and the authority on the HTTP port to any phone, by its address or name', async () => {
    const app = makeLanApp()
    const status = await withHttps(app)
    const page = await app.request('/phone-setup')
    expect([page.status, page.headers.get('content-type')]).toEqual([200, 'text/html; charset=UTF-8'])
    const html = await page.text()
    expect(html).toContain(status.caName!)
    // The fingerprint in lines of 8 bytes, to compare with the phone's.
    const lines = status.caFingerprint!.match(/[0-9A-F]{2}(:[0-9A-F]{2}){7}/g)!
    expect(lines).toHaveLength(4)
    expect(html).toContain(lines.join('<br>'))
    expect(html).toContain('href="/binder-ca.crt"')
    expect(html).toContain(`href="https://192.168.1.5:${status.httpsPort}/pair"`)

    const ca = await app.request('/binder-ca.crt', {}, { host: 'binder-pc:4322' })
    expect(ca.status).toBe(200)
    expect(ca.headers.get('content-type')).toBe('application/octet-stream')
    expect(ca.headers.get('content-disposition')).toBe('attachment; filename="binder-ca.crt"')
    const der = new crypto.X509Certificate(Buffer.from(await ca.arrayBuffer()))
    expect(der.fingerprint256).toBe(status.caFingerprint)
    expect(await error(await app.request('/phone-setup', {}, { host: 'evil.example' }))).toEqual([403, 'wrong_host'])
    // Over HTTPS, the same page.
    const secure = await overHttps(status.httpsPort, der.toString(), '/phone-setup')
    expect(secure.text).toContain(status.caName!)
  })

  it('says on the setup page when HTTPS is off, and keeps the HTTP port as it was', async () => {
    const app = makeLanApp()
    await app.lan.update({ enabled: true })
    const page = await app.request('/phone-setup')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('HTTPS for phones is off')
    expect((await app.request('/binder-ca.crt')).status).toBe(404)
    expect((await app.request('/api/health')).status).toBe(200)
    expect(app.lan.status()).toMatchObject({ https: false, setupUrl: null, caFingerprint: null, caName: null })
  })

  it('stops only the HTTPS listener when HTTPS is turned off, and starts it again with the same authority', async () => {
    const app = makeLanApp()
    const on = await withHttps(app)
    const ca = await downloadAuthority(app)
    const off = await body<LanStatus>(await app.local('/api/lan', json({ https: false }, 'PUT')))
    expect(off).toMatchObject({ enabled: true, listening: true, https: false, url: `http://192.168.1.5:${on.port}`, setupUrl: null })
    await expect(overHttps(on.httpsPort, ca, '/api/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect((await app.request('/decks')).status).toBe(404) // the app's own answer, not a redirect
    expect(app.lines.at(-1)).toBe(
      `[phone] HTTPS is off: phones open http://192.168.1.5:${on.port} (phones paired over HTTPS must pair again)`,
    )
    // Turning it off again changes nothing, and says nothing.
    const said = app.lines.length
    await app.lan.update({ https: false })
    expect(app.lines.length).toBe(said)

    const again = await withHttps(app)
    expect([again.caFingerprint, again.caReplaced]).toEqual([on.caFingerprint, false])
    expect((await overHttps(again.httpsPort, ca, '/api/health')).status).toBe(200)
    expect(app.lines.at(-1)).toBe(
      `[phone] HTTPS is on: phones open https://192.168.1.5:${again.httpsPort}. Each installs Binder's certificate ` +
        `once, from http://192.168.1.5:${again.port}/phone-setup; phones paired over HTTP must pair again`,
    )
  })

  it('names the authority phones installed while phone access is off, after a restart too', async () => {
    const app = makeLanApp()
    const on = await withHttps(app)
    const off = await app.lan.update({ enabled: false })
    expect(off).toMatchObject({ enabled: false, https: true, caFingerprint: on.caFingerprint, caName: on.caName })
    // Started again with phone access off: nothing has made or checked it this time, and the same is said.
    const restarted = makeLanApp({}, { dir: app.dir })
    setMeta(restarted.db, 'lan_https', '1')
    expect(restarted.lan.status()).toMatchObject({
      enabled: false,
      https: true,
      caFingerprint: on.caFingerprint,
      caName: on.caName,
    })
    // A new one, made while it's off, is named from then on.
    const rotated = await restarted.lan.rotate()
    expect(rotated.caFingerprint).not.toBe(on.caFingerprint)
    const installed = new crypto.X509Certificate(fs.readFileSync(path.join(app.dir, 'ca.pem')))
    expect(rotated.caFingerprint).toBe(installed.fingerprint256)
    // None made yet: none to name.
    const fresh = makeLanApp()
    setMeta(fresh.db, 'lan_https', '1')
    expect(fresh.lan.status()).toMatchObject({ https: true, caFingerprint: null, caName: null })
  })

  it('makes a new authority when rotated, served at once, and says phones must install it again', async () => {
    const app = makeLanApp()
    const before = await withHttps(app)
    const oldCa = await downloadAuthority(app)
    // Only this computer may: not a phone, paired or not.
    const phone = { host: `192.168.1.5:${before.httpsPort}`, origin: `https://192.168.1.5:${before.httpsPort}` }
    const rotate = `https://192.168.1.5:${before.httpsPort}/api/lan/https/rotate`
    expect(await error(await app.request(rotate, { method: 'POST' }, phone))).toEqual([401, 'unpaired'])
    const { code } = app.lan.pairing.open((key) => key)
    const paired = await app.request(`https://${phone.host}/api/lan/pair`, json({ code, name: 'Pixel 8' }), phone)
    const cookie = paired.headers.get('set-cookie')!.split(';')[0]!
    expect(await error(await app.request(rotate, { method: 'POST' }, { ...phone, cookie }))).toEqual([403, 'pc_only'])

    const res = await app.local('/api/lan/https/rotate', { method: 'POST' })
    expect(res.status).toBe(200)
    const after = await body<LanStatus>(res)
    expect(after.caFingerprint).not.toBe(before.caFingerprint)
    expect(after).toMatchObject({ caReplaced: true, httpsPort: before.httpsPort, url: before.url })
    const newCa = await downloadAuthority(app)
    expect(new crypto.X509Certificate(newCa).fingerprint256).toBe(after.caFingerprint)
    // The listener serves a certificate from the new authority without a restart: the old one vouches for nothing.
    expect((await overHttps(after.httpsPort, newCa, '/api/health')).status).toBe(200)
    await expect(overHttps(after.httpsPort, oldCa, '/api/health')).rejects.toThrow()
    expect(app.lines).toContain(
      '[phone] Binder made a new certificate for HTTPS: on each phone, remove the old one and install this one, from ' +
        `http://192.168.1.5:${after.port}/phone-setup`,
    )

    // With HTTPS off there's nothing to rotate.
    await app.lan.update({ https: false })
    expect(await error(await app.local('/api/lan/https/rotate', { method: 'POST' }))).toEqual([409, 'https_off'])
  })

  it("issues a certificate for the PC's new address when it changes, served without a restart", async () => {
    let at = Date.now()
    const networks: NodeJS.Dict<os.NetworkInterfaceInfo[]> = TEST_NETWORKS()
    const app = makeLanApp({}, { interfaces: () => networks, now: () => at })
    const { httpsPort } = await withHttps(app)
    const ca = await downloadAuthority(app)
    await expect(overHttps(httpsPort, ca, '/api/health', { as: '192.168.1.9' })).rejects.toMatchObject({
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    })
    networks['Wi-Fi'] = [ipv4('192.168.1.9', 24)]
    at += 30_000 // the addresses are read again
    expect(app.lan.status().url).toBe(`https://192.168.1.9:${httpsPort}`)
    await vi.waitFor(async () => expect((await overHttps(httpsPort, ca, '/api/health', { as: '192.168.1.9' })).status).toBe(200))
    expect(app.lan.status().caFingerprint).toBe(new crypto.X509Certificate(ca).fingerprint256)
  })

  it('pairs phones over HTTPS, with a cookie for HTTPS alone; one paired over HTTP pairs again', async () => {
    const app = makeLanApp()
    await app.lan.update({ enabled: true })
    const plain = await app.pair('Pixel 8')
    expect((await app.request('/api/collection/stats', {}, { cookie: plain })).status).toBe(200)

    const { httpsPort } = await withHttps(app)
    const phone = { host: `192.168.1.5:${httpsPort}`, origin: `https://192.168.1.5:${httpsPort}` }
    const at = (url: string) => `https://192.168.1.5:${httpsPort}${url}`
    // Its HTTP cookie is no use now: HTTP sends it to HTTPS, where it names no phone.
    expect(await error(await app.request('/api/collection/stats', {}, { cookie: plain }))).toEqual([403, 'use_https'])
    expect(await error(await app.request(at('/api/collection/stats'), {}, { ...phone, cookie: plain }))).toEqual([401, 'unpaired'])
    // Nor its value under HTTPS's name, as anyone who read it off the Wi-Fi could send it: a cookie works only as paired.
    const sniffed = { ...phone, cookie: plain.replace(/^binder_device=/, '__Host-binder_device=') }
    expect(await error(await app.request(at('/api/collection/stats'), {}, sniffed))).toEqual([401, 'unpaired'])
    expect(await body(await app.request(at('/api/lan/me'), {}, sniffed))).toEqual({ client: 'unpaired', https: true })

    const window = await body<LanPairing>(await app.local('/api/lan/pairing', { method: 'POST' }))
    expect(window.url).toMatch(new RegExp(`^https://192\\.168\\.1\\.5:${httpsPort}/pair#k=[A-Za-z0-9_-]{22}$`))
    // The phone, sending the cookie it had over HTTP (no HTTPS cookie), is the same phone: it replaces itself.
    const res = await app.request(at('/api/lan/pair'), json({ code: window.code, name: 'Pixel 8' }), { ...phone, cookie: plain })
    expect(res.status).toBe(201)
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/^__Host-binder_device=\d+\.[A-Za-z0-9_-]{43}; Max-Age=34560000; Path=\/; HttpOnly; Secure; SameSite=Strict$/)
    const secure = { ...phone, cookie: cookie.split(';')[0]! }
    expect(await body(await app.request(at('/api/lan/me'), {}, secure))).toEqual({ client: 'device', id: 2, name: 'Pixel 8' })
    expect(app.lan.status().devices).toEqual([expect.objectContaining({ id: 2, name: 'Pixel 8', https: true })])
    // And the other way: with HTTPS off again, its cookie's value names no phone over HTTP, where it would go in clear.
    await app.lan.update({ https: false })
    const overHttp = { cookie: secure.cookie.replace(/^__Host-binder_device=/, 'binder_device=') }
    expect(await error(await app.request('/api/collection/stats', {}, overHttp))).toEqual([401, 'unpaired'])
  })

  it('takes a request on the HTTP port as HTTP, whatever URL its request line names', async () => {
    const app = makeLanApp()
    const { port, httpsPort } = await withHttps(app)
    // A whole https:// URL in the request line, which no browser sends, doesn't make plain HTTP into HTTPS.
    const answer = await rawHttp(
      port,
      `GET https://192.168.1.5:${httpsPort}/api/collection/stats HTTP/1.1\r\nHost: 192.168.1.5:${port}\r\nConnection: close\r\n\r\n`,
    )
    expect(answer).toMatch(/^HTTP\/1\.1 403 /)
    expect(answer).toContain('"code":"use_https"')
  })

  it('keeps a phone paired over HTTP working over HTTP while HTTPS is off', async () => {
    const app = makeLanApp()
    await app.lan.update({ enabled: true })
    const cookie = await app.pair()
    expect(app.lan.status().devices).toEqual([expect.objectContaining({ https: false })])
    await app.lan.update({ https: true })
    expect(await error(await app.request('/api/collection/stats', {}, { cookie }))).toEqual([403, 'use_https'])
    await app.lan.update({ https: false })
    expect((await app.request('/api/collection/stats', {}, { cookie })).status).toBe(200)
  })

  it("says why HTTPS can't listen, and phones use HTTP meanwhile", async () => {
    const taken = await takenPortAboveAFreeOne()
    const app = makeLanApp({}, { port: taken - 1 })
    const status = await withHttps(app)
    const failure = lanListenFailure(Object.assign(new Error('in use'), { code: 'EADDRINUSE' }), taken, process.platform, true)
    expect(failure).toMatch(new RegExp(`^Couldn't listen on port ${taken} for HTTPS: another program is using it\\. `))
    expect(status).toMatchObject({ listening: true, https: true, error: failure, url: `http://192.168.1.5:${taken - 1}` })
    expect(app.lan.summary()).toMatchObject({
      listening: true,
      error: failure,
      urls: [`http://192.168.1.5:${taken - 1}`, `http://172.20.0.1:${taken - 1}`],
    })
    expect(app.lines).toContain(`[phone] ${failure}`)
    expect((await app.request('/api/health')).status).toBe(200)
    expect(app.lan.https()).toBe(false)
    // Turned off, its error goes with it.
    expect((await app.lan.update({ https: false })).error).toBeNull()
  })

  it("says why the certificate can't be made, and phones use HTTP meanwhile", async () => {
    const dir = path.join(tempDir('binder-lan-'), 'lan')
    fs.writeFileSync(dir, 'not a folder')
    const app = makeLanApp({}, { dir })
    const status = await withHttps(app)
    expect(status.error).toMatch(/^Couldn't make the certificate for HTTPS: /)
    expect(status).toMatchObject({ listening: true, url: `http://192.168.1.5:${status.port}`, caFingerprint: null })
    expect((await app.request('/api/health')).status).toBe(200)
    expect(await (await app.request('/phone-setup')).text()).toContain("Binder couldn't make its certificate")
  })

  it("reads Windows' network profile in the background, for the adapter phones reach the PC through", async () => {
    const asked: string[] = []
    let answer: (profile: NetworkProfile | null) => void = () => {}
    const networkProfile = vi.fn((interfaceName: string) => {
      asked.push(interfaceName)
      return new Promise<NetworkProfile | null>((resolve) => (answer = resolve))
    })
    const app = makeLanApp({}, { networkProfile })
    // Settings never waits for it: the first answer has none yet.
    expect((await body<LanStatus>(await app.local('/api/lan'))).network).toBeNull()
    expect(asked.at(-1)).toBe('Wi-Fi')
    answer({ publicProfile: true, name: 'CafeWifi' })
    await vi.waitFor(() => expect(app.lan.status().network).toEqual({ publicProfile: true, name: 'CafeWifi' }))
    // Another address is another adapter: its own profile, not the Wi-Fi's.
    await app.lan.update({ address: '172.20.0.1' })
    expect(app.lan.status().network).toBeNull()
    expect(asked.at(-1)).toBe('vEthernet (WSL)')
  })
})

describe('HTTPS left on (startBinder)', () => {
  it('is back on after a restart, says where phones install the certificate, and the tray turns phone access off and on', async () => {
    const dir = tempDir('binder-lan-https-')
    const lines: string[] = []
    const options: BinderOptions = {
      dataDir: path.join(dir, 'library'),
      envPath: path.join(dir, 'library', '.env'),
      ocr: { command: null, engine: 'none' },
      scryfall: stubScryfall(),
      port: 0,
      lanPort: 0,
      lanHost: '127.0.0.1',
      log: (line) => lines.push(line),
    }
    fs.mkdirSync(options.dataDir, { recursive: true })
    const db = openDb(path.join(options.dataDir, 'binder.db'))
    setMeta(db, 'lan_enabled', '1')
    setMeta(db, 'lan_https', '1')
    db.close()
    const binder: RunningBinder = await startBinder(options)
    onTestFinished(() => binder.stop())
    const status = (await (await fetch(`${binder.url}/api/lan`)).json()) as LanStatus
    expect(status).toMatchObject({ enabled: true, https: true, listening: true, error: null })
    expect(binder.lan.urls.every((url) => url.startsWith(`https://`))).toBe(true)
    // Where phones install it: this PC's address, when it's on a network a phone can reach.
    const setup = `[phone] Each phone installs Binder's certificate for HTTPS once, from ${status.setupUrl}`
    expect(lines.includes(setup)).toBe(status.setupUrl !== null)
    const ca = fs.readFileSync(path.join(options.dataDir, 'lan', 'ca.pem'), 'utf8')
    expect((await overHttps(status.httpsPort, ca, '/api/health', { as: '127.0.0.1' })).status).toBe(200)

    expect(await binder.setLan(false)).toMatchObject({ enabled: false, listening: false, urls: [] })
    await expect(overHttps(status.httpsPort, ca, '/api/health', { as: '127.0.0.1' })).rejects.toThrow()
    expect(await binder.setLan(true)).toMatchObject({ enabled: true, listening: true, error: null })
  })
})
