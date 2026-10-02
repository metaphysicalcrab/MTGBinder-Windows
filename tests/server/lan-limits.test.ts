import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createThread, getMessages } from '../../src/server/ai/threads.ts'
import type { BulkImporter } from '../../src/server/bulk/import.ts'
import { MAX_WAITING_SCANS } from '../../src/server/scanner/routes.ts'
import type { ScanWorker } from '../../src/server/scanner/worker.ts'
import type { ApiErrorBody, ChatEvent } from '../../src/shared/types.ts'
import { body, IDLE, json, makeLanApp, stubBulk } from '../helpers/app.ts'
import { createTestDb } from '../helpers/db.ts'
import { fakeAiClient, fakeAnthropic } from '../helpers/fake-anthropic.ts'
import { tempDir } from '../helpers/tmp.ts'

const error = async (res: Response) => [res.status, (await body<ApiErrorBody>(res)).error.code]

describe('what a phone may do as often as it likes, and what it may not (spec §5.10)', () => {
  it('refreshes card data from a phone at most once an hour', async () => {
    const start = vi.fn<BulkImporter['start']>(() => Promise.resolve())
    let updatedAt: string | null = new Date(Date.now() - 30 * 60_000).toISOString()
    const app = makeLanApp({ bulk: stubBulk({ start, status: () => ({ ...IDLE, updatedAt }) }) })
    const cookie = await app.pair()
    const refresh = () => app.request('/api/bulk/refresh', { method: 'POST' }, { cookie })
    const fresh = await refresh()
    expect([fresh.status, (await body<ApiErrorBody>(fresh)).error.message]).toEqual([409, 'The card data was refreshed less than an hour ago'])
    // The PC may, whenever it likes.
    expect((await app.local('/api/bulk/refresh', { method: 'POST' })).status).toBe(202)
    updatedAt = new Date(Date.now() - 61 * 60_000).toISOString()
    expect((await refresh()).status).toBe(202)
    // A refresh a phone started counts, even one that failed (the card data's date is unchanged).
    expect(await error(await refresh())).toEqual([409, 'recently_refreshed'])
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('takes at most 2 captures a second from a phone, and none while the queue is full', async () => {
    const db = createTestDb()
    const worker = { kick: () => {}, recover: () => {} } as unknown as ScanWorker
    const app = makeLanApp({ db, scanner: { scansDir: path.join(tempDir('binder-scans-'), 'scans'), worker } })
    const cookie = await app.pair()
    const jpeg = { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }
    expect([(await app.request('/api/scan', jpeg, { cookie })).status, (await app.request('/api/scan', jpeg, { cookie })).status]).toEqual([201, 201])
    const third = await app.request('/api/scan', jpeg, { cookie })
    expect(await error(third)).toEqual([429, 'rate_limited'])
    expect(third.headers.get('retry-after')).toBe('1')
    // The PC isn't held back.
    expect((await app.local('/api/scan', jpeg)).status).toBe(201)

    const insert = db.prepare("INSERT INTO scan_items (status, created_at, updated_at) VALUES ('review', 't', 't')")
    for (let i = 3; i < MAX_WAITING_SCANS; i++) insert.run()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const full = await app.request('/api/scan', jpeg, { cookie })
    expect(await body(full)).toEqual({
      error: { code: 'queue_full', message: 'The scan queue is full; review or add the scans on the PC first' },
    })
  })

  it("stops a forgotten phone's brainstorm answer, as Stop does", async () => {
    const fake = await fakeAnthropic({ content: [{ type: 'text', text: 'Thinking about your deck' }], hang: true })
    const db = createTestDb()
    const app = makeLanApp({ db, ai: fakeAiClient(fake) })
    const pixel = await app.pair('Pixel 8')
    const id = createThread(db, null)
    const res = await app.request(`/api/ai/threads/${id}/messages`, json({ text: 'Go' }), { cookie: pixel })
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1)) // Claude is answering
    // The phone is forgotten on the PC: the answer stops, keeping what was said.
    expect((await app.local('/api/lan/devices/1', { method: 'DELETE' })).status).toBe(204)
    const events = (await res.text())
      .split('\n\n')
      .filter((part) => part.startsWith('data: '))
      .map((part) => JSON.parse(part.slice(6)) as ChatEvent)
    expect(events.at(-1)).toEqual({ type: 'done' })
    await vi.waitFor(() => expect(fake.requests[0]!.hungUp).toBe(true))
    expect(getMessages(db, id).at(-1)).toMatchObject({ role: 'assistant', meta: { stopReason: 'stopped' } })
  })
})
