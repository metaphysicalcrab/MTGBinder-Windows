import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Brainstorm } from '../../src/server/ai/chat.ts'
import { NOTICE } from '../../src/server/ai/history.ts'
import { aiRoutes } from '../../src/server/ai/routes.ts'
import { appendMessages, createThread, getMessages, type MessageMeta } from '../../src/server/ai/threads.ts'
import { createBrainstormTools } from '../../src/server/ai/tools.ts'
import type { DB } from '../../src/server/db/index.ts'
import type { ChatEvent, ThreadDetail, ThreadSummary } from '../../src/shared/types.ts'
import { body, makeApp, stubScryfall } from '../helpers/app.ts'
import { createTestDb } from '../helpers/db.ts'
import { fakeAiClient, fakeAnthropic, type FakeReply } from '../helpers/fake-anthropic.ts'
import { deck } from '../helpers/library.ts'

let db: DB

beforeEach(() => {
  db = createTestDb()
})

const answer: FakeReply = { content: [{ type: 'text', text: 'Hello there.' }], stop_reason: 'end_turn' }

async function appWith(...replies: FakeReply[]) {
  const fake = await fakeAnthropic(...replies)
  return { fake, app: makeApp({ db, ai: fakeAiClient(fake) }) }
}

const json = (value: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
})

/** The events of a server-sent-event response. */
async function events(res: Response): Promise<ChatEvent[]> {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as ChatEvent)
}

/** Reads a streamed answer until Claude has written `text`, so the answer is in progress, and returns the reader. */
async function readUntilSaid(res: Response, text: string) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const said = () =>
    received
      .split('\n\n')
      .slice(0, -1) // the last part can be an event still arriving
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as ChatEvent)
      .flatMap((e) => (e.type === 'delta' ? [e.text] : []))
      .join('')
  while (said() !== text) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`The answer ended before Claude wrote "${text}"`)
    received += decoder.decode(value, { stream: true })
  }
  return reader
}

describe('conversations', () => {
  it('creates, lists, renames, and deletes conversations', async () => {
    const { app } = await appWith()
    const burn = deck(db, 'Burn', 'built', 'modern')
    const created = await app.request('/api/ai/threads', json({}))
    expect(created.status).toBe(201)
    const plain = await body<ThreadSummary>(created)
    expect(plain).toMatchObject({ title: '', deck: null })
    const about = await body<ThreadSummary>(await app.request('/api/ai/threads', json({ deckId: burn })))
    expect(about.deck).toEqual({ id: burn, name: 'Burn' })

    await new Promise((resolve) => setTimeout(resolve, 5)) // so the rename is the latest change, not a same-millisecond tie
    const renamed = await app.request(`/api/ai/threads/${plain.id}`, json({ title: 'Elf ideas' }, 'PATCH'))
    expect(await body<ThreadSummary>(renamed)).toMatchObject({ title: 'Elf ideas' })
    const list = await body<ThreadSummary[]>(await app.request('/api/ai/threads'))
    expect(list.map((t) => t.id)).toEqual([plain.id, about.id])

    expect((await app.request(`/api/ai/threads/${about.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await app.request(`/api/ai/threads/${about.id}`)).status).toBe(404)
  })

  it("reuses a deck's conversation that nothing has been said in, rather than starting another", async () => {
    const { app } = await appWith()
    const burn = deck(db, 'Burn', 'built', 'modern')
    const elves = deck(db, 'Elves', 'built')
    const start = async (deckId: number | null) => {
      const res = await app.request('/api/ai/threads', json({ deckId }))
      return [res.status, (await body<ThreadSummary>(res)).id]
    }
    const [created, first] = await start(burn)
    expect(created).toBe(201)
    expect(await start(burn)).toEqual([200, first])
    // Another deck's, or none, is its own; and once something is said in it, the next start is a new one.
    const [, forElves] = await start(elves)
    expect(forElves).not.toBe(first)
    const [, plain] = await start(null)
    expect(await start(null)).toEqual([200, plain])
    appendMessages(db, first!, [{ role: 'user', content: [{ type: 'text', text: 'Faster?' }] }], 'Faster?')
    const [again, second] = await start(burn)
    expect([again, second === first]).toEqual([201, false])
    expect(new Set([first, forElves, plain, second]).size).toBe(4)
  })

  it("doesn't reuse an empty conversation the owner has named", async () => {
    const { app } = await appWith()
    const burn = deck(db, 'Burn', 'built', 'modern')
    const named = await body<ThreadSummary>(await app.request('/api/ai/threads', json({ deckId: burn })))
    expect((await app.request(`/api/ai/threads/${named.id}`, json({ title: 'Sideboard ideas' }, 'PATCH'))).status).toBe(200)
    const next = await app.request('/api/ai/threads', json({ deckId: burn }))
    const fresh = await body<ThreadSummary>(next)
    expect([next.status, fresh.id === named.id, fresh.title]).toEqual([201, false, ''])
    // The new one, still unnamed, is the one reused next.
    const again = await app.request('/api/ai/threads', json({ deckId: burn }))
    expect([again.status, (await body<ThreadSummary>(again)).id]).toEqual([200, fresh.id])
  })

  it('moves a reused conversation to the top of the list', async () => {
    const { app } = await appWith()
    const burn = deck(db, 'Burn', 'built', 'modern')
    const empty = createThread(db, burn, new Date('2026-09-01T00:00:00Z'))
    const talked = createThread(db, null, new Date('2026-09-02T00:00:00Z'))
    appendMessages(db, talked, [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], 'Hi', new Date('2026-09-02T00:00:00Z'))
    const listed = async () => (await body<ThreadSummary[]>(await app.request('/api/ai/threads'))).map((t) => t.id)
    expect(await listed()).toEqual([talked, empty])
    const res = await app.request('/api/ai/threads', json({ deckId: burn }))
    expect([res.status, (await body<ThreadSummary>(res)).id]).toEqual([200, empty])
    expect(await listed()).toEqual([empty, talked])
  })

  it('refuses a missing deck, unknown fields, and a blank title', async () => {
    const { app } = await appWith()
    expect((await app.request('/api/ai/threads', json({ deckId: 99 }))).status).toBe(404)
    expect((await app.request('/api/ai/threads', json({ deck: 1 }))).status).toBe(400)
    const id = createThread(db, null)
    expect((await app.request(`/api/ai/threads/${id}`, json({ title: '  ' }, 'PATCH'))).status).toBe(400)
    expect((await app.request('/api/ai/threads/abc')).status).toBe(404)
    for (const alias of [`0x${id}`, `${id}e0`, `0${id}`, `${id}.0`]) expect([alias, (await app.request(`/api/ai/threads/${alias}`)).status]).toEqual([alias, 404])
  })

  it('answers 404 for a conversation that does not exist', async () => {
    const { app } = await appWith()
    const id = createThread(db, null)
    expect((await app.request('/api/ai/threads/99', json({ title: 'Elf ideas' }, 'PATCH'))).status).toBe(404)
    expect((await app.request('/api/ai/threads/99', { method: 'DELETE' })).status).toBe(404)
    expect((await app.request('/api/ai/threads/99/stop', { method: 'POST' })).status).toBe(404)
    // Not whole: conversation 1.5 is not conversation 1.
    expect((await app.request(`/api/ai/threads/${id}.5`)).status).toBe(404)
  })

  it('shows a conversation with its items, estimated cost, and whether it can continue', async () => {
    const { app } = await appWith()
    const id = createThread(db, null)
    appendMessages(db, id, [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], 'Hi')
    const detail = await body<ThreadDetail>(await app.request(`/api/ai/threads/${id}`))
    expect(detail).toMatchObject({ title: 'Hi', items: [{ kind: 'user', text: 'Hi', deck: null }], costUsd: 0, canContinue: true, tooLong: false, busy: false })

    const burn = deck(db, 'Burn', 'built', 'modern')
    const usage = { input_tokens: 1000, output_tokens: 100 } as MessageMeta['usage']
    appendMessages(db, id, [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_deck', input: { deck_id: burn } }], meta: { model: 'claude-opus-5-5', stopReason: 'tool_use', usage } },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"name":"Burn"}' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Burn wants more burn.' }], meta: { model: 'claude-opus-5-5', stopReason: 'end_turn', usage } },
    ])
    const answered = await body<ThreadDetail>(await app.request(`/api/ai/threads/${id}`))
    expect(answered.costUsd).toBeGreaterThan(0)
    expect(answered).toMatchObject({ canContinue: false, tooLong: false, busy: false })
    expect(answered.items).toContainEqual(expect.objectContaining({ kind: 'tool', name: 'get_deck', activity: 'Reading Burn', state: 'done' }))
  })
})

describe('answers', () => {
  it('streams an answer as server-sent events', async () => {
    const { app } = await appWith(answer)
    const id = createThread(db, null)
    const res = await app.request(`/api/ai/threads/${id}/messages`, json({ text: 'Hi' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    // The headers every answer gets don't hold the stream back, nor replace its own caching rule.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    const received = await events(res)
    expect(received[0]).toEqual({ type: 'item', item: { kind: 'user', text: 'Hi', deck: null } })
    expect(received.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('Hello there.')
    expect(received.at(-1)).toEqual({ type: 'done' })
    expect(getMessages(db, id).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('answers errors found before streaming as JSON', async () => {
    const { app } = await appWith()
    const id = createThread(db, null)
    const empty = await app.request(`/api/ai/threads/${id}/messages`, json({ text: '   ' }))
    expect(empty.status).toBe(400)
    expect((await app.request(`/api/ai/threads/${id}/messages`, json({ text: 'Hi', deckId: 1 }))).status).toBe(400)
    const nothing = await app.request(`/api/ai/threads/${id}/continue`, { method: 'POST' })
    expect(nothing.status).toBe(409)
    expect(await body(nothing)).toEqual({ error: { code: 'nothing_to_continue', message: 'Claude has already answered' } })
    expect((await app.request('/api/ai/threads/99/messages', json({ text: 'Hi' }))).status).toBe(404)
  })

  it('needs an API key', async () => {
    const fake = await fakeAnthropic()
    const app = makeApp({ db, ai: fakeAiClient(fake, null) })
    const id = createThread(db, null)
    const res = await app.request(`/api/ai/threads/${id}/messages`, json({ text: 'Hi' }))
    expect(res.status).toBe(409)
    expect(await body(res)).toMatchObject({ error: { code: 'no_key' } })
  })

  it('continues an answer that failed', async () => {
    const { app } = await appWith({ status: 500, type: 'api_error', message: 'boom' }, answer)
    const id = createThread(db, null)
    const failed = await events(await app.request(`/api/ai/threads/${id}/messages`, json({ text: 'Hi' })))
    expect(failed.at(-2)).toEqual({ type: 'error', message: 'Anthropic had a problem (500); try again shortly', canContinue: true })
    const retried = await events(await app.request(`/api/ai/threads/${id}/continue`, { method: 'POST' }))
    expect(retried.some((e) => e.type === 'error')).toBe(false)
    expect(getMessages(db, id).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('ends a conversation for good once it has grown too long for Claude, and says so after a reload', async () => {
    const { app, fake } = await appWith(
      // Too long for Claude to take at all.
      { status: 400, type: 'invalid_request_error', message: 'prompt is too long: 1000012 tokens > 1000000 maximum' },
      // Taken, but the context window ran out before Claude wrote anything.
      { content: [{ type: 'thinking', thinking: '' }], stop_reason: 'model_context_window_exceeded' },
    )
    const tooLong = { kind: 'notice', tone: 'info', text: NOTICE.tooLong }
    const refused = createThread(db, null)
    const live = await events(await app.request(`/api/ai/threads/${refused}/messages`, json({ text: 'One more thing' })))
    // Said once, as the notice it reloads with: not as an error as well.
    expect(live.at(-2)).toEqual({ type: 'item', item: tooLong })
    expect(live.some((e) => e.type === 'error')).toBe(false)
    const cutOff = createThread(db, null)
    const said = await events(await app.request(`/api/ai/threads/${cutOff}/messages`, json({ text: 'And another' })))
    expect(said.at(-2)).toEqual({ type: 'item', item: tooLong })
    for (const id of [refused, cutOff]) {
      const detail = await body<ThreadDetail>(await app.request(`/api/ai/threads/${id}`))
      expect([detail.canContinue, detail.tooLong, detail.items.at(-1)]).toEqual([false, true, tooLong])
      const again = await app.request(`/api/ai/threads/${id}/continue`, { method: 'POST' })
      expect([again.status, (await body<{ error: { code: string } }>(again)).error.code]).toEqual([409, 'nothing_to_continue'])
      // Nor does a new message send it all again: only a new conversation goes on.
      const more = await app.request(`/api/ai/threads/${id}/messages`, json({ text: 'Summarize this so I can start again' }))
      expect([more.status, await body(more)]).toEqual([409, { error: { code: 'too_long', message: NOTICE.tooLong } }])
    }
    expect(fake.requests).toHaveLength(2)
  })

  it('leaves Continue offered after a refused request that is not too long', async () => {
    const { app } = await appWith({ status: 400, type: 'invalid_request_error', message: 'max_tokens: 64000 > 32000, the maximum for this model' })
    const id = createThread(db, null)
    const received = await events(await app.request(`/api/ai/threads/${id}/messages`, json({ text: 'Hi' })))
    expect(received.at(-2)).toEqual({
      type: 'error',
      message: 'Anthropic answered with an error (400): max_tokens: 64000 > 32000, the maximum for this model',
      canContinue: true,
    })
    const detail = await body<ThreadDetail>(await app.request(`/api/ai/threads/${id}`))
    expect(detail).toMatchObject({ canContinue: true, items: [{ kind: 'user', text: 'Hi', deck: null }] })
    expect(getMessages(db, id).map((m) => m.role)).toEqual(['user'])
  })

  it('stops an answer, and says whether one was running', async () => {
    const { app } = await appWith({ content: [{ type: 'text', text: 'Thinking about your deck' }], hang: true })
    const id = createThread(db, null)
    const res = await app.request(`/api/ai/threads/${id}/messages`, json({ text: 'Go' }))
    const reader = res.body!.getReader()
    await reader.read() // the stream is open, so the answer is running
    const busy = await body<ThreadDetail>(await app.request(`/api/ai/threads/${id}`))
    expect(busy.busy).toBe(true)
    expect((await app.request(`/api/ai/threads/${id}`, { method: 'DELETE' })).status).toBe(409)
    expect(await body(await app.request(`/api/ai/threads/${id}/stop`, { method: 'POST' }))).toEqual({ stopped: true })
    while (!(await reader.read()).done) {
      // drain
    }
    expect(await body(await app.request(`/api/ai/threads/${id}/stop`, { method: 'POST' }))).toEqual({ stopped: false })
  })

  it('stops the answer when the page closes', async () => {
    const { fake, app } = await appWith({ content: [{ type: 'text', text: 'Thinking about your deck' }], hang: true })
    const id = createThread(db, null)
    const res = await app.request(`/api/ai/threads/${id}/messages`, json({ text: 'Go' }))
    const reader = await readUntilSaid(res, 'Thinking about your deck') // the answer is running
    await reader.cancel() // the page closes
    await vi.waitFor(async () => expect((await body<ThreadDetail>(await app.request(`/api/ai/threads/${id}`))).busy).toBe(false))
    await vi.waitFor(() => expect(fake.requests[0]!.hungUp).toBe(true))
    expect(getMessages(db, id).at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Thinking about your deck' }], meta: { stopReason: 'stopped' } })
  })

  it('sends every event emitted before an answer fails unexpectedly', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => logged.mockRestore())
    const id = createThread(db, null)
    // answer() never throws; if a bug made it, what it said first must still reach the page.
    const brainstorm: Brainstorm = {
      busy: () => false,
      check: () => {},
      stop: () => false,
      async answer(_threadId, text, emit) {
        emit({ type: 'item', item: { kind: 'user', text: text ?? '', deck: null } })
        emit({ type: 'delta', text: 'Hello' })
        emit({ type: 'delta', text: ' there.' })
        throw new Error('a bug in answer()')
      },
    }
    const routes = aiRoutes({ db, brainstorm, tools: createBrainstormTools({ db, scryfall: stubScryfall() }) })
    const received = await events(await routes.request(`/threads/${id}/messages`, json({ text: 'Hi' })))
    expect(received).toEqual([
      { type: 'item', item: { kind: 'user', text: 'Hi', deck: null } },
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ' there.' },
    ])
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'a bug in answer()' }))
  })

  it('has no brainstorm routes without an AI client', async () => {
    const app = makeApp({ db })
    expect((await app.request('/api/ai/threads')).status).toBe(404)
  })
})
