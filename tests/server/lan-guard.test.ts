import fs from 'node:fs'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createAiClient } from '../../src/server/ai/client.ts'
import { createApp } from '../../src/server/app.ts'
import type { BulkImporter } from '../../src/server/bulk/import.ts'
import { lanPolicy } from '../../src/server/lan/guard.ts'
import type { ScanWorker } from '../../src/server/scanner/worker.ts'
import type { AiKeyStatus, ApiErrorBody, LanClient } from '../../src/shared/types.ts'
import { body, IDLE, json, makeLanApp, stubBulk, stubScryfall } from '../helpers/app.ts'
import { createTestDb } from '../helpers/db.ts'
import { tempDir } from '../helpers/tmp.ts'

const error = async (res: Response) => [res.status, (await body<ApiErrorBody>(res)).error.code]

/** An app with every part (scanning, the API key, backups, phone access), so every route is there. */
function everything() {
  const dir = tempDir('binder-everything-')
  const ai = createAiClient({ read: () => 'sk-ant-api03-test-key-abcd', write: () => {} }, () => ({}) as Anthropic)
  const worker = { kick: () => {}, recover: () => {} } as unknown as ScanWorker
  return makeLanApp({ ai, backupDir: path.join(dir, 'backups'), scanner: { scansDir: path.join(dir, 'scans'), worker } })
}

describe('the route policy (spec §5.10)', () => {
  it('names a policy for every API route, and a route for every policy', () => {
    const { app } = everything()
    const routes = app.routes.filter((r) => r.path.startsWith('/api/') && r.method !== 'ALL')
    const unlisted = routes.filter((r) => lanPolicy(r.method, r.path) === undefined).map((r) => `${r.method} ${r.path}`)
    expect(unlisted).toEqual([])
    // Spot checks of the table itself.
    expect(lanPolicy('GET', '/api/health')).toBe('public')
    expect(lanPolicy('HEAD', '/api/health')).toBe('public')
    expect(lanPolicy('GET', '/api/decks/12')).toBe('device')
    expect(lanPolicy('PUT', '/api/settings/ai')).toBe('pc')
    expect(lanPolicy('GET', '/api/settings/ai')).toBe('device')
    expect(lanPolicy('DELETE', '/api/lan/devices/3')).toBe('pc')
    expect(lanPolicy('GET', '/api/decks/12/secret')).toBeUndefined()
    expect(lanPolicy('GET', '/api/collection/exportXcsv')).toBeUndefined()
  })

  it('refuses every route only this computer may use to a paired phone, saying where to change it', async () => {
    const app = everything()
    const cookie = await app.pair()
    const pcOnly = app.app.routes.filter((r) => r.path.startsWith('/api/') && r.method !== 'ALL' && lanPolicy(r.method, r.path) === 'pc')
    expect(pcOnly.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining(['PUT /api/settings/ai', 'POST /api/settings/library/compact', 'GET /api/settings/backups', 'POST /api/lan/forget-all']),
    )
    for (const route of pcOnly) {
      const res = await app.request(route.path.replace(/:[A-Za-z]+/g, '1'), { method: route.method }, { cookie })
      expect([route.path, res.status, await body(res)]).toEqual([
        route.path,
        403,
        { error: { code: 'pc_only', message: 'Change this on the PC running Binder' } },
      ])
    }
    // The key is still there: the phone changed nothing.
    expect(await body<AiKeyStatus>(await app.local('/api/settings/ai'))).toEqual({ configured: true, hint: 'abcd' })
  })

  it("tells a phone whether there's an API key, but not its last characters", async () => {
    const app = everything()
    const cookie = await app.pair()
    expect(await body(await app.request('/api/settings/ai', {}, { cookie }))).toEqual({ configured: true, hint: null })
    expect(await body(await app.local('/api/settings/ai'))).toEqual({ configured: true, hint: 'abcd' })
  })
})

describe("a phone's requests (spec §5.10)", () => {
  it('refuses a phone that is not paired, saying how to pair it, but answers the routes anyone may use', async () => {
    const app = makeLanApp()
    const res = await app.request('/api/collection/stats')
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({
      error: { code: 'unpaired', message: 'Pair this phone with Binder: on the PC, open Settings → Phone access → Pair a phone' },
    })
    // Refused answers carry every answer's headers.
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect((await app.request('/api/health')).status).toBe(200)
    expect(await body<LanClient>(await app.request('/api/lan/me'))).toEqual({ client: 'unpaired', https: false })
  })

  it("answers a paired phone, knows it, and notes when and where it's seen", async () => {
    const app = makeLanApp()
    const cookie = await app.pair('Pixel 8')
    expect((await app.request('/api/collection/stats', {}, { cookie })).status).toBe(200)
    expect(await body<LanClient>(await app.request('/api/lan/me', {}, { cookie }))).toEqual({ client: 'device', id: 1, name: 'Pixel 8' })
    expect(await body<LanClient>(await app.local('/api/lan/me'))).toEqual({ client: 'pc' })
    expect(app.lan.devices.list()).toEqual([expect.objectContaining({ name: 'Pixel 8', lastIp: '192.168.1.40' })])
    // A cookie that doesn't check out is no phone.
    const [name, value] = cookie.split('=') as [string, string]
    const forged = `${name}=${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`
    expect(await error(await app.request('/api/collection/stats', {}, { cookie: forged }))).toEqual([401, 'unpaired'])
    expect(await error(await app.request('/api/collection/stats', {}, { cookie: `${name}=2.${value.slice(2)}` }))).toEqual([401, 'unpaired'])
  })

  it('refuses a phone once it is forgotten, and every phone once all are', async () => {
    const app = makeLanApp()
    const pixel = await app.pair('Pixel 8')
    const tablet = await app.pair('Tablet')
    const stats = (cookie: string) => app.request('/api/collection/stats', {}, { cookie }).then((res) => res.status)
    expect((await app.local('/api/lan/devices/1', { method: 'DELETE' })).status).toBe(204)
    expect([await stats(pixel), await stats(tablet)]).toEqual([401, 200])
    expect((await app.local('/api/lan/forget-all', { method: 'POST' })).status).toBe(204)
    expect(await stats(tablet)).toBe(401)
    expect(app.lines).toContain('[phone] Forgot "Pixel 8"')
    expect(app.lines).toContain('[phone] Forgot every phone: each must pair again')
  })

  it('refuses a Host that is neither an address nor this computer, against DNS rebinding', async () => {
    const app = makeLanApp()
    const cookie = await app.pair()
    for (const host of ['evil.example', 'evil.example:4322', 'binder-pc.evil.example', '']) {
      expect(await error(await app.request('/api/collection/stats', {}, { cookie, host }))).toEqual([403, 'wrong_host'])
    }
    for (const host of ['192.168.1.5:4322', 'BINDER-PC:4322', 'binder-pc.local:4322', 'localhost:4322', '[fe80::1]:4322']) {
      expect([host, (await app.request('/api/collection/stats', {}, { cookie, host })).status]).toEqual([host, 200])
    }
    // While Binder listens for phones, the answer says where to open it.
    await app.lan.update({ enabled: true })
    const wrong = await app.request('/api/health', {}, { host: 'evil.example' })
    expect((await body<ApiErrorBody>(wrong)).error.message).toBe(`Open Binder at http://192.168.1.5:${app.lan.status().port}`)
  })

  it("serves the web app's files to any phone, but only by an address or this computer's name", async () => {
    const web = tempDir('binder-web-')
    fs.writeFileSync(path.join(web, 'index.html'), '<title>Binder</title>')
    const app = makeLanApp({ webDistDir: web })
    const page = await app.request('/pair')
    expect([page.status, await page.text()]).toEqual([200, '<title>Binder</title>'])
    expect(await error(await app.request('/pair', {}, { host: 'evil.example' }))).toEqual([403, 'wrong_host'])
    // On this computer, as before.
    expect((await app.local('/decks')).status).toBe(200)
  })

  it.each<[string, Record<string, string>, string | null | undefined]>([
    ['no Origin', {}, null],
    ['another site as its Origin', {}, 'https://evil.example'],
    ['another port as its Origin', {}, 'http://192.168.1.5:9999'],
    ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }, undefined],
    ['Sec-Fetch-Site: same-site', { 'Sec-Fetch-Site': 'same-site' }, undefined],
  ])("refuses a phone's change with %s, even with its cookie", async (_, headers, origin) => {
    const start = vi.fn<BulkImporter['start']>(() => Promise.resolve())
    const app = makeLanApp({ bulk: stubBulk({ start }) })
    const cookie = await app.pair()
    const res = await app.request('/api/bulk/refresh', { method: 'POST', headers }, { cookie, origin })
    expect(await error(res)).toEqual([403, 'cross_site'])
    expect(start).not.toHaveBeenCalled()
  })

  it("accepts a phone's change from Binder's own page, and refuses a read another site asks for", async () => {
    const app = makeLanApp()
    const cookie = await app.pair()
    const adjust = json({ cardId: 'nope', finish: 'nonfoil', delta: 1 })
    // Past the guard: the card is unknown.
    expect((await app.request('/api/collection/adjust', adjust, { cookie })).status).toBe(404)
    const own = { ...adjust, headers: { ...adjust.headers, 'Sec-Fetch-Site': 'same-origin' } }
    expect((await app.request('/api/collection/adjust', own, { cookie })).status).toBe(404)
    const read = await app.request('/api/collection/stats', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, { cookie })
    expect(await error(read)).toEqual([403, 'cross_site'])
  })

  it('limits the size of what a phone sends, before reading it', async () => {
    const app = makeLanApp()
    const cookie = await app.pair()
    const big = (size: number) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(size) })
    expect(await error(await app.request('/api/collection/adjust', big(1024 * 1024 + 1), { cookie }))).toEqual([413, 'too_large'])
    // A collection's CSV may be larger.
    expect(await error(await app.request('/api/collection/import/preview', big(5 * 1024 * 1024), { cookie }))).toEqual([400, 'bad_request'])
    expect(await error(await app.request('/api/collection/import/preview', big(12 * 1024 * 1024 + 1), { cookie }))).toEqual([413, 'too_large'])
    expect(await error(await app.request('/api/decks/1/import', big(12 * 1024 * 1024 + 1), { cookie }))).toEqual([413, 'too_large'])
    // This computer's requests are as before.
    expect(await error(await app.local('/api/collection/adjust', big(1024 * 1024 + 1)))).toEqual([400, 'bad_request'])
  })

  it('answers 429, with Retry-After, to an address that keeps trying without a cookie', async () => {
    const app = makeLanApp()
    for (let i = 0; i < 60; i++) expect((await app.request('/api/collection/stats')).status).toBe(401)
    const limited = await app.request('/api/collection/stats')
    expect(await error(limited)).toEqual([429, 'rate_limited'])
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // Another phone isn't held back, nor is a paired phone at that address.
    expect((await app.request('/api/collection/stats', {}, { peer: '192.168.1.41' })).status).toBe(401)
    const cookie = await app.pair('Pixel 8', { peer: '192.168.1.41' })
    expect((await app.request('/api/collection/stats', {}, { cookie })).status).toBe(200)
  })

  it("sends a phone's cookie again once a day, so a phone in use stays paired", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const app = makeLanApp()
      const cookie = await app.pair()
      const resent = async () => (await app.request('/api/collection/stats', {}, { cookie })).headers.get('set-cookie')
      expect(await resent()).toMatch(new RegExp(`^${cookie}; Max-Age=34560000; Path=/; HttpOnly; SameSite=Strict$`))
      expect(await resent()).toBeNull()
      vi.setSystemTime(Date.now() + 25 * 60 * 60_000)
      expect(await resent()).toMatch(new RegExp(`^${cookie};`))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('which requests are from this computer (spec §6 Requests)', () => {
  it('treats a request on the phones\' listener as a phone\'s, even from this computer with Host localhost', async () => {
    const app = makeLanApp()
    const res = await app.request('/api/settings/ai', json({ apiKey: null }, 'PUT'), { peer: '127.0.0.1', host: 'localhost:4322' })
    expect(await error(res)).toEqual([401, 'unpaired'])
  })

  it("doesn't take Host: localhost from another device for this computer", async () => {
    const app = makeLanApp()
    const res = await app.request('/api/collection/stats', {}, { listener: 'local', peer: '192.168.1.40', host: 'localhost:4321' })
    expect(await error(res)).toEqual([401, 'unpaired'])
    // From this computer (IPv4 in IPv6 too), it is.
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect((await app.request('/api/collection/stats', {}, { listener: 'local', peer, host: 'localhost:4321' })).status).toBe(200)
    }
  })

  it("takes a request the dev server's proxy forwards for another device for that device's", async () => {
    const app = makeLanApp()
    const proxied = (forwardedFor: string) =>
      app.request('/api/collection/stats', { headers: { 'X-Forwarded-For': forwardedFor } }, { listener: 'local', peer: '127.0.0.1', host: '192.168.1.5:5173' })
    expect(await error(await proxied('::ffff:192.168.1.40'))).toEqual([401, 'unpaired'])
    // Only the last address counts: the one the proxy added. One the phone made up comes before it.
    expect(await error(await proxied('127.0.0.1, 192.168.1.40'))).toEqual([401, 'unpaired'])
    const local = await app.request(
      '/api/collection/stats',
      { headers: { 'X-Forwarded-For': '::1' } },
      { listener: 'local', peer: '127.0.0.1', host: 'localhost:5173' },
    )
    expect(local.status).toBe(200)
    // A phone paired through the proxy is known by the address it really came from.
    const { code } = app.lan.pairing.open((key) => key)
    const pair = json({ code, name: 'Pixel 8' })
    const paired = await app.request(
      '/api/lan/pair',
      { ...pair, headers: { ...pair.headers, 'X-Forwarded-For': '192.168.1.40' } },
      { listener: 'local', peer: '127.0.0.1', host: '192.168.1.5:5173' },
    )
    expect(paired.status).toBe(201)
    expect(app.lan.devices.list()).toEqual([expect.objectContaining({ lastIp: '192.168.1.40' })])
    expect(app.lines).toContain('[phone] Paired "Pixel 8" from 192.168.1.40')
  })

  it("refuses a paired phone through the dev server's proxy while phone access is off", async () => {
    const proxied = (app: ReturnType<typeof makeLanApp>, cookie: string) =>
      app.request(
        '/api/collection/stats',
        { headers: { 'X-Forwarded-For': '192.168.1.40' } },
        { listener: 'local', peer: '127.0.0.1', host: '192.168.1.5:5173', cookie },
      )
    const app = makeLanApp()
    await app.lan.update({ enabled: true })
    const cookie = await app.pair()
    expect((await proxied(app, cookie)).status).toBe(200)
    await app.lan.update({ enabled: false })
    expect(await body(await proxied(app, cookie))).toEqual({
      error: { code: 'unpaired', message: 'Phone access is off: on the PC, turn it on in Settings → Phone access' },
    })
    // Nor with BINDER_LAN=0, which keeps it off.
    const lanOff = makeLanApp({}, { port: null })
    expect(await error(await proxied(lanOff, await lanOff.pair()))).toEqual([401, 'unpaired'])
  })

  it("keeps this computer's answers when there's no phone access", async () => {
    const app = createApp({ db: createTestDb(), bulk: stubBulk(), scryfall: stubScryfall() })
    const res = await app.request('/api/bulk/status', { headers: { Host: 'localhost:4321' } })
    expect(await body(res)).toEqual(IDLE)
    // And a phone gets nothing: no phone can be paired.
    const env = { listener: 'lan', incoming: { socket: { remoteAddress: '192.168.1.40' } } } as never
    expect(await error(await app.request('/api/bulk/status', { headers: { Host: '192.168.1.5:4322' } }, env))).toEqual([401, 'unpaired'])
    expect((await app.request('/api/lan/me', { headers: { Host: 'localhost:4321' } })).status).toBe(404)
  })
})
