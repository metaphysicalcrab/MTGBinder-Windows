import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createApp } from '../../src/server/app.ts'
import type { BulkImporter } from '../../src/server/bulk/import.ts'
import type { ApiErrorBody, CardDetail, CardSummary } from '../../src/shared/types.ts'
import { body, IDLE, makeApp, stubBulk, stubScryfall } from '../helpers/app.ts'
import { createTestDb } from '../helpers/db.ts'
import { fixtureCard } from '../helpers/fixtures.ts'

describe('api', () => {
  it('answers health checks', async () => {
    const res = await makeApp().request('/api/health')
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
  })

  it('autocompletes card names', async () => {
    const res = await makeApp().request('/api/cards/autocomplete?q=bolt')
    expect(res.status).toBe(200)
    const results = await body<CardSummary[]>(res)
    expect(results[0]).toMatchObject({ name: 'Lightning Bolt', cardId: fixtureCard('Lightning Bolt', 'm11').id, manaCost: '{R}' })
  })

  it('tolerates search syntax in autocomplete', async () => {
    const res = await makeApp().request(`/api/cards/autocomplete?q=${encodeURIComponent('"')}`)
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual([])
  })

  it('validates autocomplete parameters', async () => {
    const res = await makeApp().request('/api/cards/autocomplete?q=bolt&limit=999')
    expect(res.status).toBe(400)
    expect((await body<ApiErrorBody>(res)).error.code).toBe('bad_request')
  })

  it('returns card detail with printings', async () => {
    const bolt = fixtureCard('Lightning Bolt', 'm10')
    const res = await makeApp().request(`/api/cards/${bolt.id}`)
    expect(res.status).toBe(200)
    const detail = await body<CardDetail>(res)
    expect(detail.card.name).toBe('Lightning Bolt')
    expect(detail.printings.map((p) => p.setCode)).toEqual(['sta', 'm11', 'm10'])
  })

  it('finds a card by its written name, or one face of it', async () => {
    const app = makeApp()
    const named = async (name: string) => (await app.request(`/api/cards/named?name=${encodeURIComponent(name)}`))
    expect(await body<CardSummary>(await named('lightning bolt'))).toMatchObject({ name: 'Lightning Bolt' })
    expect(await body<CardSummary>(await named('Atraxa Praetors Voice'))).toMatchObject({ name: "Atraxa, Praetors' Voice" })
    expect(await body<CardSummary>(await named('Ice'))).toMatchObject({ name: 'Fire // Ice' })
    expect(await body<CardSummary>(await named('Fire // Ice'))).toMatchObject({ name: 'Fire // Ice' })
    expect(await body<CardSummary>(await named('Brazen Borrower'))).toMatchObject({ name: 'Brazen Borrower // Petty Theft' })
    expect((await named('Not A Card')).status).toBe(404)
    expect((await named('  ')).status).toBe(400)
  })

  it('404s unknown cards', async () => {
    const res = await makeApp().request('/api/cards/does-not-exist')
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual({ error: { code: 'not_found', message: 'Card not found' } })
  })

  it('404s unknown API routes as JSON', async () => {
    const res = await makeApp().request('/api/nope')
    expect(res.status).toBe(404)
    expect((await body<ApiErrorBody>(res)).error.code).toBe('not_found')
  })

  it('reports bulk status', async () => {
    const res = await makeApp().request('/api/bulk/status')
    expect(await body(res)).toEqual(IDLE)
  })

  it('refuses a second refresh while one runs', async () => {
    const start = vi.fn<BulkImporter['start']>().mockReturnValueOnce(Promise.resolve()).mockReturnValueOnce(null)
    const app = makeApp({ bulk: stubBulk({ start }) })
    const first = await app.request('/api/bulk/refresh', { method: 'POST' })
    expect(first.status).toBe(202)
    expect(await body(first)).toEqual({ started: true })
    const second = await app.request('/api/bulk/refresh', { method: 'POST' })
    expect(second.status).toBe(409)
    expect((await body<ApiErrorBody>(second)).error.code).toBe('already_running')
  })

  it('logs a refresh that fails after answering 202', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('disk gone')
    const app = makeApp({ bulk: stubBulk({ start: () => Promise.reject(failure) }) })
    const res = await app.request('/api/bulk/refresh', { method: 'POST' })
    expect(res.status).toBe(202)
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('[card data]', failure))
    consoleError.mockRestore()
  })

  it('hides unexpected errors behind a generic 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = makeApp({ bulk: stubBulk({ status: () => { throw new Error('secret detail') } }) })
    const res = await app.request('/api/bulk/status')
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: { code: 'internal', message: 'Internal server error' } })
  })
})

describe('local-only guard', () => {
  it('refuses requests addressed to another host', async () => {
    const res = await makeApp().request('/api/health', { headers: { Host: 'evil.example' } })
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual({ error: { code: 'forbidden', message: 'Requests must come from this computer' } })
  })

  it('refuses requests with no Host header', async () => {
    const res = await createApp({ db: createTestDb(), bulk: stubBulk(), scryfall: stubScryfall() }).request('/api/health')
    expect(res.status).toBe(403)
    expect((await body<ApiErrorBody>(res)).error.code).toBe('forbidden')
  })

  it.each(['127.0.0.1:4321', 'localhost:5173', '[::1]:4321', 'LocalHost'])('accepts Host %s', async (host) => {
    const res = await makeApp().request('/api/health', { headers: { Host: host } })
    expect(res.status).toBe(200)
  })

  it.each<[string, Record<string, string>]>([
    ['a cross-site Origin', { Origin: 'https://evil.example' }],
    ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['an Origin that is not a URL', { Origin: 'null' }],
    ['an Origin on another port of this computer', { Origin: 'http://localhost:3000' }],
    ['an Origin naming this computer another way', { Origin: 'http://127.0.0.1:4321' }],
    ['Sec-Fetch-Site: same-site', { 'Sec-Fetch-Site': 'same-site' }],
  ])('refuses a POST with %s', async (_, headers) => {
    const start = vi.fn<BulkImporter['start']>(() => Promise.resolve())
    const res = await makeApp({ bulk: stubBulk({ start }) }).request('/api/bulk/refresh', { method: 'POST', headers })
    expect(res.status).toBe(403)
    expect((await body<ApiErrorBody>(res)).error.code).toBe('forbidden')
    expect(start).not.toHaveBeenCalled()
  })

  it("accepts a POST from Binder's own page, and one typed by hand with no Origin", async () => {
    const own = await makeApp().request('/api/bulk/refresh', {
      method: 'POST',
      headers: { Origin: 'http://localhost:4321', 'Sec-Fetch-Site': 'same-origin' },
    })
    expect(own.status).toBe(202)
    const typed = await makeApp().request('/api/bulk/refresh', { method: 'POST', headers: { 'Sec-Fetch-Site': 'none' } })
    expect(typed.status).toBe(202)
  })

  it('accepts a POST from the app itself through the dev server proxy', async () => {
    const res = await makeApp().request('/api/bulk/refresh', {
      method: 'POST',
      headers: { Host: 'localhost:5173', Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' },
    })
    expect(res.status).toBe(202)
  })

  it("has the dev server proxy to PORT, passing on the page's own Host so the same-origin guard accepts it, and the browser's address", async () => {
    const shell = process.env.PORT
    onTestFinished(() => {
      if (shell === undefined) delete process.env.PORT
      else process.env.PORT = shell
    })
    process.env.PORT = '4999'
    vi.resetModules() // vite.config.ts reads PORT as it loads
    const { default: config } = await import('../../vite.config.ts')
    expect(config.server?.proxy?.['/api']).toEqual({ target: 'http://127.0.0.1:4999', changeOrigin: false, xfwd: true })
  })
})
