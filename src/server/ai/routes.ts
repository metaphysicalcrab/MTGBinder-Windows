import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { ChatEvent, ThreadDetail } from '../../shared/types.ts'
import type { DB } from '../db/index.ts'
import { getDeckRow } from '../decks/repo.ts'
import { ApiError, parseWith, pathId, readJson, type AppEnv } from '../http.ts'
import type { DeviceStore } from '../lan/devices.ts'
import type { Brainstorm } from './chat.ts'
import { canContinue, chatItems, estimateCost, outgrown } from './history.ts'
import { deleteThread, getMessages, getThread, listThreads, renameThread, startThread } from './threads.ts'
import type { BrainstormTools } from './tools.ts'

const CreateBody = z.object({ deckId: z.number().int().min(1).nullable().default(null) }).strict()
const RenameBody = z.object({ title: z.string().trim().min(1).max(100) }).strict()
const MessageBody = z.object({ text: z.string().trim().min(1).max(20_000) }).strict()
const threadId = (param: string) => pathId(param, 'Conversation not found')

/**
 * /api/ai (spec §5.5): brainstorm conversations, and Claude's answers streamed as server-sent events. A phone that's
 * forgotten (`devices`) has its answers in progress stopped, as Stop does.
 */
export function aiRoutes(deps: {
  db: DB
  brainstorm: Brainstorm
  tools: BrainstormTools
  devices?: Pick<DeviceStore, 'onForget'>
}): Hono<AppEnv> {
  const { db, brainstorm, tools } = deps
  const routes = new Hono<AppEnv>()
  /** Answers being streamed to phones, and to which phone. */
  const phoneAnswers = new Map<AbortController, number>()
  deps.devices?.onForget((id) => {
    for (const [controller, device] of phoneAnswers) if (id === null || device === id) controller.abort()
  })

  function detail(id: number): ThreadDetail {
    const thread = getThread(db, id)
    if (!thread) throw new ApiError(404, 'not_found', 'Conversation not found')
    const messages = getMessages(db, id)
    return {
      ...thread,
      items: chatItems(messages, tools.describe),
      costUsd: estimateCost(messages),
      canContinue: canContinue(messages),
      tooLong: outgrown(messages),
      busy: brainstorm.busy(id),
    }
  }

  /** Streams one answer. Problems found before it starts are ordinary JSON errors. */
  function answer(c: Context<AppEnv>, id: number, text: string | null) {
    brainstorm.check(id, text)
    const client = c.get('client')
    return streamSSE(c, async (stream) => {
      const controller = new AbortController()
      // Closing the page stops the answer, as Stop does.
      stream.onAbort(() => controller.abort())
      if (client?.kind === 'device') phoneAnswers.set(controller, client.id)
      let writes = Promise.resolve()
      const emit = (event: ChatEvent) => {
        writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(event) }))
      }
      try {
        await brainstorm.answer(id, text, emit, controller.signal)
      } finally {
        phoneAnswers.delete(controller)
        // What was emitted still reaches the page, even if answering failed unexpectedly.
        await writes
      }
    })
  }

  routes.get('/threads', (c) => c.json(listThreads(db)))
  routes.post('/threads', async (c) => {
    const { deckId } = parseWith(CreateBody, await readJson(c.req))
    if (deckId !== null && !getDeckRow(db, deckId)) throw new ApiError(404, 'not_found', 'Deck not found')
    const { id, reused } = startThread(db, deckId)
    return c.json(getThread(db, id), reused ? 200 : 201)
  })
  routes.get('/threads/:id', (c) => c.json(detail(threadId(c.req.param('id')))))
  routes.patch('/threads/:id', async (c) => {
    const id = threadId(c.req.param('id'))
    const { title } = parseWith(RenameBody, await readJson(c.req))
    if (!renameThread(db, id, title)) throw new ApiError(404, 'not_found', 'Conversation not found')
    return c.json(getThread(db, id))
  })
  routes.delete('/threads/:id', (c) => {
    const id = threadId(c.req.param('id'))
    if (brainstorm.busy(id)) throw new ApiError(409, 'busy', 'Stop Claude before deleting this conversation')
    if (!deleteThread(db, id)) throw new ApiError(404, 'not_found', 'Conversation not found')
    return c.body(null, 204)
  })
  routes.post('/threads/:id/messages', async (c) => {
    const id = threadId(c.req.param('id'))
    const { text } = parseWith(MessageBody, await readJson(c.req))
    return answer(c, id, text)
  })
  routes.post('/threads/:id/continue', (c) => answer(c, threadId(c.req.param('id')), null))
  routes.post('/threads/:id/stop', (c) => {
    const id = threadId(c.req.param('id'))
    if (!getThread(db, id)) throw new ApiError(404, 'not_found', 'Conversation not found')
    return c.json({ stopped: brainstorm.stop(id) })
  })
  return routes
}
