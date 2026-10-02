import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDeviceStore } from '../../src/server/lan/devices.ts'
import { PAIRING_MS } from '../../src/server/lan/pairing.ts'
import type { ApiErrorBody, LanDevice, LanPairing, LanStatus } from '../../src/shared/types.ts'
import { body, ipv4, json, makeLanApp } from '../helpers/app.ts'
import { createTestDb } from '../helpers/db.ts'
import { expectOwnerOnly } from '../helpers/private.ts'
import { tempDir } from '../helpers/tmp.ts'

const error = async (res: Response) => [res.status, (await body<ApiErrorBody>(res)).error.code]

/** A clock a test moves by hand. */
function clock() {
  let at = Date.parse('2026-10-02T12:00:00.000Z')
  return { now: () => at, add: (ms: number) => (at += ms) }
}

/** Phone access turned on (listening on 127.0.0.1), and a pairing window opened from Settings. */
async function pairing(app: ReturnType<typeof makeLanApp>): Promise<LanPairing> {
  expect((await app.local('/api/lan', json({ enabled: true }, 'PUT'))).status).toBe(200)
  const res = await app.local('/api/lan/pairing', { method: 'POST' })
  expect(res.status).toBe(200)
  return body<LanPairing>(res)
}

const pair = (app: ReturnType<typeof makeLanApp>, input: Record<string, unknown>, peer = '192.168.1.40') =>
  app.request('/api/lan/pair', json({ name: 'Pixel 8', ...input }), { peer })

describe('pairing a phone (spec §5.10)', () => {
  it('pairs a phone with the code the PC shows, once, giving it its cookie', async () => {
    const app = makeLanApp()
    const window = await pairing(app)
    const port = app.lan.status().port
    expect(window.code).toMatch(/^\d{8}$/)
    expect(window.url).toMatch(new RegExp(`^http://192\\.168\\.1\\.5:${port}/pair#k=[A-Za-z0-9_-]{22}$`))
    expect(Date.parse(window.expiresAt) - Date.now()).toBeGreaterThan(PAIRING_MS - 5000)
    expect((await body<LanStatus>(await app.local('/api/lan'))).pairing).toEqual(window)

    // Typed as the PC shows it: "4821 0937".
    const res = await pair(app, { code: `${window.code.slice(0, 4)} ${window.code.slice(4)}`, name: ' Pixel 8 ' })
    expect(res.status).toBe(201)
    expect(await body(res)).toEqual({ id: 1, name: 'Pixel 8' })
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/^binder_device=1\.[A-Za-z0-9_-]{43}; Max-Age=34560000; Path=\/; HttpOnly; SameSite=Strict$/)
    expect(app.lines).toContain('[phone] Paired "Pixel 8" from 192.168.1.40')

    const status = await body<LanStatus>(await app.local('/api/lan'))
    expect(status.pairing).toBeNull()
    expect(status.pairingEnded).toEqual({ reason: 'paired', name: 'Pixel 8' })
    expect(status.devices).toEqual([
      {
        id: 1,
        name: 'Pixel 8',
        createdAt: expect.any(String),
        lastSeenAt: expect.any(String),
        lastIp: '192.168.1.40',
        https: false,
      },
    ] satisfies LanDevice[])
    // One phone per window: the code doesn't pair another.
    expect(await error(await pair(app, { code: window.code }, '192.168.1.41'))).toEqual([409, 'not_pairing'])
  })

  it('gives a phone on HTTPS a cookie only that host can set, sent only over HTTPS', async () => {
    const app = makeLanApp()
    const { code } = app.lan.pairing.open((key) => key)
    const res = await app.request('https://192.168.1.5:4323/api/lan/pair', json({ code, name: 'Pixel 8' }), {
      host: '192.168.1.5:4323',
      origin: 'https://192.168.1.5:4323',
    })
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/^__Host-binder_device=1\.[A-Za-z0-9_-]{43}; Max-Age=34560000; Path=\/; HttpOnly; Secure; SameSite=Strict$/)
    const sent = cookie.split(';')[0]!
    const https = { host: '192.168.1.5:4323', cookie: sent }
    expect((await app.request('https://192.168.1.5:4323/api/collection/stats', {}, https)).status).toBe(200)
    // Over HTTP it names no phone: that cookie is HTTPS's alone.
    expect((await app.request('/api/collection/stats', {}, { cookie: sent })).status).toBe(401)
  })

  it("pairs with the QR code's key, which never reaches the server's log", async () => {
    const app = makeLanApp()
    const window = await pairing(app)
    const key = window.url.split('#k=')[1]!
    expect((await pair(app, { key })).status).toBe(201)
    const logged = app.lines.join('\n')
    expect(logged).not.toContain(key)
    expect(logged).not.toContain(window.code)
  })

  it('stops an address after 5 wrong codes, but not the others: one device on the Wi-Fi can\'t keep the owner from pairing', async () => {
    const app = makeLanApp()
    const window = await pairing(app)
    const wrong = window.code === '00000000' ? '00000001' : '00000000'
    for (let i = 1; i <= 4; i++) {
      const res = await pair(app, { code: wrong })
      expect([res.status, (await body<ApiErrorBody>(res)).error.message]).toEqual([
        400,
        `That code isn't right: check the code on the PC and type it again (${5 - i} ${5 - i === 1 ? 'try' : 'tries'} left)`,
      ])
    }
    expect(await body(await pair(app, { key: 'not-the-key' }))).toEqual({
      error: { code: 'wrong_code', message: 'Too many wrong codes, so pairing stopped: on the PC, start pairing again' },
    })
    expect(app.lines.filter((line) => line.startsWith('[phone] Wrong'))).toEqual(
      [1, 2, 3, 4, 5].map((n) => `[phone] Wrong pairing code from 192.168.1.40 (${n} of 5)`),
    )
    expect(app.lines).toContain("[phone] Too many wrong codes from 192.168.1.40: it can't pair until pairing starts again")
    // The right code is too late from that address now.
    const late = await pair(app, { code: window.code })
    expect([late.status, (await body<ApiErrorBody>(late)).error.message]).toEqual([
      409,
      'Too many wrong codes, so pairing stopped: on the PC, start pairing again',
    ])
    // The window is still open on the PC, and another phone pairs with it.
    expect((await body<LanStatus>(await app.local('/api/lan'))).pairing).toEqual(window)
    expect((await pair(app, { code: window.code }, '192.168.1.41')).status).toBe(201)
  })

  it('stops pairing after 20 wrong codes from anywhere, saying so on the PC', async () => {
    const app = makeLanApp()
    const window = await pairing(app)
    const wrong = window.code === '00000000' ? '00000001' : '00000000'
    for (const peer of ['192.168.1.41', '192.168.1.42', '192.168.1.43', '192.168.1.44']) {
      for (let i = 0; i < 5; i++) expect((await pair(app, { code: wrong }, peer)).status).toBe(400)
    }
    expect(app.lines).toContain('[phone] Too many wrong codes; pairing stopped')
    const late = await pair(app, { code: window.code }, '192.168.1.45')
    expect([late.status, (await body<ApiErrorBody>(late)).error.message]).toEqual([
      409,
      'Too many wrong codes, so pairing stopped: on the PC, start pairing again',
    ])
    const status = await body<LanStatus>(await app.local('/api/lan'))
    expect([status.pairing, status.pairingEnded, status.devices]).toEqual([null, { reason: 'too_many_tries', name: null }, []])
  })

  it('closes the window after 5 minutes', async () => {
    const time = clock()
    const app = makeLanApp({}, { now: time.now })
    const window = await pairing(app)
    expect(window.expiresAt).toBe('2026-10-02T12:05:00.000Z')
    time.add(PAIRING_MS - 1)
    expect((await body<LanStatus>(await app.local('/api/lan'))).pairing).toEqual(window)
    time.add(1)
    const late = await pair(app, { code: window.code })
    expect([late.status, (await body<ApiErrorBody>(late)).error.message]).toEqual([409, 'That code has expired: on the PC, start pairing again'])
    expect((await body<LanStatus>(await app.local('/api/lan'))).pairingEnded).toEqual({ reason: 'expired', name: null })
  })

  it('closes the window when the PC cancels it', async () => {
    const app = makeLanApp()
    const window = await pairing(app)
    expect((await app.local('/api/lan/pairing', { method: 'DELETE' })).status).toBe(204)
    const status = await body<LanStatus>(await app.local('/api/lan'))
    expect([status.pairing, status.pairingEnded]).toEqual([null, null])
    const res = await pair(app, { code: window.code })
    expect([res.status, (await body<ApiErrorBody>(res)).error.message]).toEqual([
      409,
      "Binder isn't pairing right now: on the PC, open Settings → Phone access → Pair a phone",
    ])
  })

  it('limits how often one address may try, with Retry-After', async () => {
    const time = clock()
    const app = makeLanApp({}, { now: time.now })
    await pairing(app)
    for (let i = 0; i < 10; i++) expect((await pair(app, { code: '1' })).status).not.toBe(429)
    const limited = await pair(app, { code: '1' })
    expect(await error(limited)).toEqual([429, 'rate_limited'])
    expect(limited.headers.get('retry-after')).toBe('60')
    // Another address may still try; this one may again in a minute (though its 5 wrong codes have stopped it).
    expect((await pair(app, { code: '1' }, '192.168.1.41')).status).toBe(400)
    time.add(60_000)
    expect((await pair(app, { code: '1' })).status).toBe(409)
  })

  it("opens a window only while Binder listens for phones, and pairs only from the phones' side", async () => {
    const app = makeLanApp()
    expect(await body(await app.local('/api/lan/pairing', { method: 'POST' }))).toEqual({
      error: { code: 'not_listening', message: 'Turn on phone access first' },
    })
    const window = await pairing(app)
    expect(await error(await app.local('/api/lan/pair', json({ code: window.code, name: 'PC' })))).toEqual([404, 'not_found'])
    expect(await error(await pair(app, { name: 'Pixel 8' }))).toEqual([400, 'bad_request'])
    expect(await error(await pair(app, { code: window.code, name: '  ' }))).toEqual([400, 'bad_request'])
  })

  it("says when this computer isn't on a network a phone can reach, naming it as Settings does", async () => {
    // On a Mac, with only its loopback: "this Mac", as Settings says it there ("this PC" on Windows).
    const app = makeLanApp({}, { interfaces: () => ({ lo0: [ipv4('127.0.0.1', 8, true)] }), platform: 'darwin' })
    expect((await app.local('/api/lan', json({ enabled: true }, 'PUT'))).status).toBe(200)
    const port = app.lan.status().port
    expect(app.lines).toContain(`[phone] Listening for phones on port ${port}, but this Mac isn't on a network a phone can reach`)
    expect(await body(await app.local('/api/lan/pairing', { method: 'POST' }))).toEqual({
      error: { code: 'no_address', message: "This Mac isn't on a network a phone can reach: connect it to the Wi-Fi first" },
    })
    expect(await body(await app.local('/api/lan', json({ address: '10.9.9.9' }, 'PUT')))).toEqual({
      error: { code: 'bad_address', message: "10.9.9.9 isn't one of this Mac's addresses" },
    })
  })

  it('replaces a phone that pairs again', async () => {
    const app = makeLanApp()
    const old = await app.pair('Pixel 8')
    const { code } = app.lan.pairing.open((key) => key)
    const res = await app.request('/api/lan/pair', json({ code, name: 'Pixel 8 Pro' }), { cookie: old })
    expect(res.status).toBe(201)
    expect(app.lan.devices.list().map((d) => [d.id, d.name])).toEqual([[2, 'Pixel 8 Pro']])
    expect((await app.request('/api/collection/stats', {}, { cookie: old })).status).toBe(401)
  })
})

describe('paired phones (spec §5.10)', () => {
  it('renames and forgets a phone from the PC', async () => {
    const app = makeLanApp()
    await app.pair('Android phone')
    const renamed = await app.local('/api/lan/devices/1', json({ name: 'Kitchen tablet' }, 'PATCH'))
    expect(await body(renamed)).toMatchObject({ id: 1, name: 'Kitchen tablet' })
    expect(await error(await app.local('/api/lan/devices/9', json({ name: 'X' }, 'PATCH')))).toEqual([404, 'not_found'])
    expect((await app.local('/api/lan/devices/1', { method: 'DELETE' })).status).toBe(204)
    expect(await error(await app.local('/api/lan/devices/1', { method: 'DELETE' }))).toEqual([404, 'not_found'])
    expect(app.lines).toContain('[phone] Forgot "Kitchen tablet"')
  })

  it('lets a phone forget itself, clearing its cookie', async () => {
    const app = makeLanApp()
    const cookie = await app.pair('Pixel 8')
    const res = await app.request('/api/lan/forget', { method: 'POST' }, { cookie })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toMatch(/^binder_device=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict$/)
    expect((await app.request('/api/collection/stats', {}, { cookie })).status).toBe(401)
    expect(app.lan.devices.list()).toEqual([])
    expect(app.lines).toContain('[phone] "Pixel 8" forgot itself')
    expect(await error(await app.local('/api/lan/forget', { method: 'POST' }))).toEqual([404, 'not_found'])
  })

  it('forgets every phone by changing the secret, so a database brought back from a backup lets none in, nor lists them', async () => {
    const app = makeLanApp()
    const cookie = await app.pair('Pixel 8')
    const secret = fs.readFileSync(path.join(app.dir, 'secret'), 'utf8')
    const rows = app.db.prepare('SELECT * FROM lan_devices').all() as Array<Record<string, unknown>>
    expect((await app.local('/api/lan/forget-all', { method: 'POST' })).status).toBe(204)
    expect(fs.readFileSync(path.join(app.dir, 'secret'), 'utf8')).not.toBe(secret)
    expectOwnerOnly(path.join(app.dir, 'secret'))
    // Every id given out so far, in one line.
    expect(fs.readFileSync(path.join(app.dir, 'forgotten'), 'utf8')).toBe('1-1\n')
    // The backup's rows come back, and Binder starts again: the phone's cookie still doesn't work, nor does Settings
    // list it as paired.
    const insert = app.db.prepare(
      `INSERT INTO lan_devices (id, name, token_hash, created_at, last_seen_at, last_ip, origin, user_agent)
       VALUES (@id, @name, @token_hash, @created_at, @last_seen_at, @last_ip, @origin, @user_agent)`,
    )
    for (const row of rows) insert.run(row)
    const restarted = makeLanApp({ db: app.db }, { dir: app.dir })
    expect((await restarted.request('/api/collection/stats', {}, { cookie })).status).toBe(401)
    expect(restarted.lan.devices.list()).toEqual([])
    // A phone paired now gets in.
    const next = await restarted.pair('Pixel 9')
    expect((await restarted.request('/api/collection/stats', {}, { cookie: next })).status).toBe(200)
    // Before the secret changed, the same rows would have let it in.
    for (const row of rows) insert.run(row)
    const before = makeLanApp({ db: app.db })
    fs.mkdirSync(before.dir, { recursive: true })
    fs.writeFileSync(path.join(before.dir, 'secret'), secret)
    expect((await before.request('/api/collection/stats', {}, { cookie })).status).toBe(200)
  })

  it("never gives a new phone a forgotten one's id, though a backup brought back counts ids from before", async () => {
    const app = makeLanApp()
    await app.pair('A')
    await app.pair('B')
    expect((await app.local('/api/lan/devices/2', { method: 'DELETE' })).status).toBe(204)
    // A backup from when only A was paired comes back, counting 1 id given out, and Binder starts again.
    app.db.prepare("UPDATE sqlite_sequence SET seq = 1 WHERE name = 'lan_devices'").run()
    const restarted = makeLanApp({ db: app.db }, { dir: app.dir })
    const c = await restarted.pair('C')
    expect(c).toMatch(/^binder_device=3\./)
    expect(await body(await restarted.request('/api/lan/me', {}, { cookie: c }))).toEqual({ client: 'device', id: 3, name: 'C' })
    expect(restarted.lan.devices.list().map((d) => [d.id, d.name])).toEqual([
      [1, 'A'],
      [3, 'C'],
    ])
    // A backup from before any phone paired, which counts none: still past every forgotten id.
    for (const id of [1, 3]) expect((await restarted.local(`/api/lan/devices/${id}`, { method: 'DELETE' })).status).toBe(204)
    app.db.prepare('DELETE FROM lan_devices').run()
    app.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'lan_devices'").run()
    const again = makeLanApp({ db: app.db }, { dir: app.dir })
    const d = await again.pair('D')
    expect(d).toMatch(/^binder_device=4\./)
    expect((await again.request('/api/collection/stats', {}, { cookie: d })).status).toBe(200)
  })

  it('keeps a phone forgotten on its own forgotten when a backup brings its row back', async () => {
    const app = makeLanApp()
    const stolen = await app.pair('Stolen phone')
    const kept = await app.pair('Pixel 8')
    const rows = app.db.prepare('SELECT * FROM lan_devices WHERE id = 1').all() as Array<Record<string, unknown>>
    expect((await app.local('/api/lan/devices/1', { method: 'DELETE' })).status).toBe(204)
    const forgotten = path.join(app.dir, 'forgotten')
    expect(fs.readFileSync(forgotten, 'utf8')).toBe('1\n')
    expectOwnerOnly(forgotten)
    // The backup's row comes back, and Binder starts again: the stolen phone's cookie still doesn't work.
    const insert = app.db.prepare(
      `INSERT INTO lan_devices (id, name, token_hash, created_at, last_seen_at, last_ip, origin, user_agent)
       VALUES (@id, @name, @token_hash, @created_at, @last_seen_at, @last_ip, @origin, @user_agent)`,
    )
    for (const row of rows) insert.run(row)
    const restarted = makeLanApp({ db: app.db }, { dir: app.dir })
    expect((await restarted.request('/api/collection/stats', {}, { cookie: stolen })).status).toBe(401)
    expect((await restarted.request('/api/collection/stats', {}, { cookie: kept })).status).toBe(200)
    expect(restarted.lan.devices.list().map((d) => d.name)).toEqual(['Pixel 8'])
    // Forgetting every phone changes the secret: every id given out so far is forgotten, in one line.
    expect((await restarted.local('/api/lan/forget-all', { method: 'POST' })).status).toBe(204)
    expect(fs.readFileSync(forgotten, 'utf8')).toBe('1-2\n')
  })

  it("drops the phones of a library moved or brought back without its lan/ folder, which can't be let in again", async () => {
    const app = makeLanApp()
    const cookie = await app.pair('Pixel 8')
    const count = () => app.db.prepare('SELECT count(*) FROM lan_devices').pluck().get()
    // A secret that's there but can't be read keeps them: it may be readable again next time.
    const unreadable = makeLanApp({ db: app.db })
    fs.mkdirSync(path.join(unreadable.dir, 'secret'), { recursive: true })
    expect((await body<LanStatus>(await unreadable.local('/api/lan'))).devices).toHaveLength(1)
    // binder.db somewhere else, with no lan/ beside it.
    const moved = makeLanApp({ db: app.db })
    expect((await moved.request('/api/collection/stats', {}, { cookie })).status).toBe(401)
    expect((await body<LanStatus>(await moved.local('/api/lan'))).devices).toEqual([])
    expect(count()).toBe(0)
    expect(fs.existsSync(moved.dir)).toBe(false)
  })

  it('turns phone access on and off, and picks the address phones open', async () => {
    const app = makeLanApp()
    const off = await body<LanStatus>(await app.local('/api/lan'))
    expect(off).toMatchObject({ enabled: false, listening: false, https: false, url: null, error: null, address: null, pairing: null })
    expect(off.addresses).toEqual([
      { address: '192.168.1.5', interface: 'Wi-Fi', recommended: true },
      { address: '172.20.0.1', interface: 'vEthernet (WSL)', recommended: false },
    ])
    const on = await body<LanStatus>(await app.local('/api/lan', json({ enabled: true }, 'PUT')))
    expect(on).toMatchObject({ enabled: true, listening: true, url: `http://192.168.1.5:${on.port}`, httpsPort: on.port + 1 })
    expect(on.port).toBeGreaterThan(0)
    expect(app.lines).toContain(`[phone] Phones on this Wi-Fi can open http://192.168.1.5:${on.port} (pair them in Settings → Phone access)`)
    const moved = await body<LanStatus>(await app.local('/api/lan', json({ address: '172.20.0.1' }, 'PUT')))
    expect([moved.address, moved.url]).toEqual(['172.20.0.1', `http://172.20.0.1:${on.port}`])
    expect(await error(await app.local('/api/lan', json({ address: '10.9.9.9' }, 'PUT')))).toEqual([400, 'bad_address'])
    expect(await error(await app.local('/api/lan', json({ enabled: 'yes' }, 'PUT')))).toEqual([400, 'bad_request'])
    const back = await body<LanStatus>(await app.local('/api/lan', json({ enabled: false, address: null }, 'PUT')))
    expect(back).toMatchObject({ enabled: false, listening: false, url: null, address: null })
    expect(app.lines.at(-1)).toBe('[phone] Phone access is off')
  })

  it('keeps phone access off when this Binder was started with BINDER_LAN=0', async () => {
    const app = makeLanApp({}, { port: null })
    const off = 'Phone access is off for this Binder: it was started with BINDER_LAN=0'
    expect(await body(await app.local('/api/lan', json({ enabled: true }, 'PUT')))).toEqual({ error: { code: 'lan_off', message: off } })
    expect(await body<LanStatus>(await app.local('/api/lan'))).toMatchObject({ enabled: false, listening: false, error: off })
  })
})

describe('the devices secret', () => {
  it("is made with the first phone, in the library's lan/ folder, private to its owner; the database holds no token", async () => {
    const app = makeLanApp()
    expect(fs.existsSync(app.dir)).toBe(false)
    const cookie = await app.pair()
    const file = path.join(app.dir, 'secret')
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/)
    expectOwnerOnly(file)
    expect(fs.readdirSync(app.dir)).toEqual(['secret'])
    const token = Buffer.from(cookie.split('.')[1]!, 'base64url')
    const { token_hash: hash } = app.db.prepare('SELECT token_hash FROM lan_devices').get() as { token_hash: Buffer }
    expect(hash).toHaveLength(32)
    expect(hash.equals(token)).toBe(false)
  })

  it('is made private on Windows by its access list, before the secret goes in', () => {
    const db = createTestDb()
    const dir = path.join(tempDir('binder-lan-'), 'lan')
    const calls: Array<{ command: string; args: string[]; contents?: string }> = []
    const run = (command: string, args: string[]) => {
      const tool = path.win32.basename(command)
      if (tool === 'whoami.exe') {
        calls.push({ command: tool, args })
        return '"pc\\me","S-1-5-21-1-2-3-1001"\r\n'
      }
      calls.push({ command: tool, args, contents: fs.readFileSync(args[0]!, 'utf8') })
      return ''
    }
    const devices = createDeviceStore({ db, dir, platform: 'win32', run })
    const { cookie } = devices.add({ name: 'Pixel 8', ip: '192.168.1.40', origin: 'http://192.168.1.5:4322', userAgent: null })
    expect(calls).toEqual([
      { command: 'whoami.exe', args: ['/user', '/fo', 'csv', '/nh'] },
      {
        command: 'icacls.exe',
        args: [path.join(dir, `secret.${process.pid}.tmp`), '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:F'],
        contents: '',
      },
    ])
    expect(devices.verify(cookie, { https: false })).toEqual({ id: 1, name: 'Pixel 8' })
    expect(fs.readdirSync(dir)).toEqual(['secret'])
  })

  it('removes the temporary copies a crashed write left, but not one another running Binder is writing', () => {
    const dir = path.join(tempDir('binder-lan-'), 'lan')
    fs.mkdirSync(dir)
    const leftovers = [`secret.${process.pid}.tmp`, 'forgotten.999999999.tmp']
    const kept = [`secret.${process.ppid}.tmp`, 'secret', 'notes.tmp']
    for (const file of [...leftovers, ...kept]) fs.writeFileSync(path.join(dir, file), 'a secret')
    createDeviceStore({ db: createTestDb(), dir })
    expect(fs.readdirSync(dir).sort()).toEqual([...kept].sort())
  })
})
