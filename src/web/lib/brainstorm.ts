import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { ApiErrorBody, ChatEvent, ChatItem, ThreadDetail, ThreadSummary } from '../../shared/types.ts'
import { apiGet, apiSend, ApiRequestError } from './api.ts'
import { apiSignal, reportApiError } from './client.ts'
import { invalidateCollection } from './collection.ts'
import { useToast } from './toast.tsx'

export function useThreads() {
  return useQuery({ queryKey: ['threads'], queryFn: ({ signal }) => apiGet<ThreadSummary[]>('/api/ai/threads', signal) })
}

/** One conversation. `answering`: this window is streaming an answer in it, so there is nothing to check back for. */
export function useThread(id: number | null, { answering = false }: { answering?: boolean } = {}) {
  return useQuery({
    queryKey: ['thread', id],
    queryFn: ({ signal }) => apiGet<ThreadDetail>(`/api/ai/threads/${id}`, signal),
    enabled: id !== null,
    // Claude answering in another window: check back until it's done.
    refetchInterval: (query) => (!answering && query.state.data?.busy ? 2000 : false),
  })
}

/** Starts a conversation, about a deck when given one. */
export function useCreateThread() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (deckId: number | null) => apiSend<ThreadSummary>('POST', '/api/ai/threads', { deckId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['threads'] }),
    onError: (err) => toast.error(`Couldn't start a conversation: ${err.message}`),
  })
}

export function useRenameThread(id: number) {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (title: string) => apiSend<ThreadSummary>('PATCH', `/api/ai/threads/${id}`, { title }),
    onSuccess: (renamed) => {
      // Only the title changes: fetching the conversation again could land partway through an answer.
      queryClient.setQueryData<ThreadDetail>(['thread', id], (thread) => thread && { ...thread, title: renamed.title })
      return queryClient.invalidateQueries({ queryKey: ['threads'] })
    },
    onError: (err) => toast.error(`Couldn't rename the conversation: ${err.message}`),
  })
}

/** Deletes a conversation. `leave` takes the page away from it, as soon as the delete succeeds. */
export function useDeleteThread(id: number, leave: () => void) {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: () => apiSend<void>('DELETE', `/api/ai/threads/${id}`),
    onSuccess: () => leaveDeletedThread(queryClient, id, leave),
    onError: (err) => toast.error(`Couldn't delete the conversation: ${err.message}`),
  })
}

/**
 * After a conversation is deleted: leave it at once, start fetching the list again (without waiting for it), and forget
 * the conversation once nothing shows it. Forgetting it while its view is still up would make that view fetch it again
 * (a 404) and show Loading… if it renders before the page changes, which React may do: the page changes in a
 * transition, and the delete's own update can render first.
 */
export function leaveDeletedThread(queryClient: QueryClient, id: number, leave: () => void) {
  leave()
  void queryClient.invalidateQueries({ queryKey: ['threads'] })
  const cache = queryClient.getQueryCache()
  const query = cache.find({ queryKey: ['thread', id], exact: true })
  if (!query) return
  if (query.getObserversCount() === 0) return cache.remove(query)
  const stop = cache.subscribe((event) => {
    if (event.type === 'observerRemoved' && event.query === query && query.getObserversCount() === 0) {
      stop()
      cache.remove(query)
    }
  })
}

/** Splits server-sent-event text into each finished event's data, keeping an unfinished event for the next chunk. */
export function splitEvents(buffer: string): { data: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n')
  const rest = parts.pop() ?? ''
  const data = parts.flatMap((part) => {
    const lines = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
    return lines.length > 0 ? [lines.join('\n')] : []
  })
  return { data, rest }
}

/** A conversation's items with one more answer event applied (spec §5.5). */
export function applyChatEvent(items: readonly ChatItem[], event: ChatEvent): ChatItem[] {
  switch (event.type) {
    case 'item':
      return [...items, event.item]
    case 'delta': {
      const last = items.at(-1)
      if (!last || (last.kind !== 'text' && last.kind !== 'note')) return [...items]
      return [...items.slice(0, -1), { ...last, text: last.text + event.text }]
    }
    case 'tool_done':
      return items.map((item) =>
        item.kind === 'tool' && item.id === event.id ? { ...item, state: event.state, error: event.error, deck: event.deck } : item,
      )
    case 'error':
      return [...items, { kind: 'notice', tone: 'error', text: event.message }]
    case 'title':
    case 'working':
    case 'done':
      return [...items]
  }
}

/**
 * This window's answer in one conversation. `live` is the answer so far (null when none is running), shown after
 * `before`, the conversation's items when it began. `lastError` is why the last answer failed: the server doesn't keep
 * a failure, so it stays here until the next answer starts. `ended`: the server has said the answer is over, and its
 * items stay on screen until the conversation is fetched again. `writing`: Claude is writing a tool call, whose line
 * appears only once it's written.
 */
export interface AnswerState {
  live: ChatItem[] | null
  before: readonly ChatItem[]
  lastError: string | null
  ended: boolean
  writing: boolean
}

export const NO_ANSWER: AnswerState = { live: null, before: [], lastError: null, ended: false, writing: false }

export type AnswerAction = { type: 'start'; stored: readonly ChatItem[] } | { type: 'event'; event: ChatEvent } | { type: 'end' }

export function answerReducer(state: AnswerState, action: AnswerAction): AnswerState {
  switch (action.type) {
    case 'start':
      return { live: [], before: action.stored, lastError: null, ended: false, writing: false }
    case 'event': {
      const { event } = action
      if (state.live === null) return state
      return {
        ...state,
        live: applyChatEvent(state.live, event),
        lastError: event.type === 'error' ? event.message : state.lastError,
        ended: state.ended || event.type === 'done',
        // Until the next thing to show: the call's line, or whatever ends the answer.
        writing: event.type === 'working' || (state.writing && event.type !== 'item' && event.type !== 'error' && event.type !== 'done'),
      }
    }
    case 'end':
      return { ...state, live: null, before: [], ended: false, writing: false }
  }
}

/**
 * What a conversation shows: its stored items, or while an answer runs here, the items stored when it began followed
 * by the answer so far. Stored items fetched again meanwhile may already hold part of the answer; it isn't shown twice.
 */
export function shownItems(stored: readonly ChatItem[], answer: Pick<AnswerState, 'live' | 'before'>): readonly ChatItem[] {
  return answer.live === null ? stored : [...answer.before, ...answer.live]
}

/**
 * Whether Claude is working with nothing to show for it: before its first word, while it writes a tool call, after
 * each round of tools, and after a notice or a fallback line partway through (a garbled message asked again, another
 * model carrying on). A notice that closes an answer (Stopped., an error) comes just before the server's `done`, so an
 * ended answer never waits.
 */
export function awaitingClaude({ live, ended, writing = false }: Pick<AnswerState, 'live' | 'ended'> & { writing?: boolean }): boolean {
  if (live === null || ended) return false
  if (writing) return true
  const last = live.at(-1)
  if (last === undefined || last.kind === 'user' || last.kind === 'notice' || last.kind === 'fallback') return true
  if (last.kind !== 'tool') return false
  // A round's tool lines come together; Claude goes on once every one of them has finished.
  for (let i = live.length - 1; i >= 0; i--) {
    const item = live[i]!
    if (item.kind !== 'tool') break
    if (item.state === 'running') return false
  }
  return true
}

/** The text with a full stop, unless it ends with one already (the server's messages don't). */
export const asSentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`)

/** POSTs to an answer route and passes each server-sent event on. An error before the stream opens throws. */
async function streamAnswer(path: string, body: unknown, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    let code = 'http_error'
    let message = `Request failed (${res.status})`
    try {
      const error = ((await res.json()) as ApiErrorBody).error
      code = error.code
      message = error.message
    } catch {
      // Not a JSON error; keep the generic message.
    }
    throw new ApiRequestError(res.status, code, message)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const split = splitEvents(buffer + value)
    buffer = split.rest
    for (const data of split.data) onEvent(JSON.parse(data) as ChatEvent)
  }
}

/**
 * Asking Claude in one conversation (see AnswerState): `live` holds the answer as it streams, shown after the items
 * stored when it began. When the answer ends, the conversation is refetched and `live` cleared.
 */
export function useAnswer(threadId: number) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [answer, dispatch] = useReducer(answerReducer, NO_ANSWER)
  const controller = useRef<AbortController | null>(null)

  // Leaving the page (or the conversation) stops the answer; the server keeps what was said.
  useEffect(() => () => controller.current?.abort(), [threadId])

  const run = useCallback(
    async (path: string, body?: unknown) => {
      // One answer at a time from this window: a second Enter or Continue while one runs does nothing.
      if (controller.current) return
      const ctrl = new AbortController()
      controller.current = ctrl
      dispatch({ type: 'start', stored: queryClient.getQueryData<ThreadDetail>(['thread', threadId])?.items ?? [] })
      let madeDeck = false
      // A phone that sleeps, or switches to another app, cuts the stream. That's no error to report: the server keeps
      // what was said, and the conversation offers Continue when it shows again.
      let hidden = document.hidden
      const onVisibility = () => {
        if (document.hidden) hidden = true
      }
      document.addEventListener('visibilitychange', onVisibility)
      try {
        await streamAnswer(
          path,
          body,
          (event) => {
            if (event.type === 'tool_done' && event.deck) madeDeck = true
            if (event.type === 'title') {
              // Name the conversation now, not when the answer ends; its items stay as they are until then.
              queryClient.setQueryData<ThreadDetail>(['thread', threadId], (thread) => thread && { ...thread, title: event.title })
              void queryClient.invalidateQueries({ queryKey: ['threads'] })
            }
            dispatch({ type: 'event', event })
          },
          ctrl.signal,
        )
      } catch (err) {
        // A phone the PC forgot goes back to the pairing page, as from any other request (React Query's own go there).
        if (apiSignal(err) === 'unpaired') return reportApiError(err)
        const cutWhileHidden = hidden && !(err instanceof ApiRequestError)
        if (!ctrl.signal.aborted && !cutWhileHidden) toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        document.removeEventListener('visibilitychange', onVisibility)
        if (madeDeck) invalidateCollection(queryClient, { keepScryfallSearches: true })
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['thread', threadId] }),
          queryClient.invalidateQueries({ queryKey: ['threads'] }),
        ])
        if (controller.current === ctrl) {
          controller.current = null
          dispatch({ type: 'end' })
        }
      }
    },
    [queryClient, threadId, toast],
  )

  return {
    ...answer,
    running: answer.live !== null,
    send: (text: string) => run(`/api/ai/threads/${threadId}/messages`, { text }),
    resume: () => run(`/api/ai/threads/${threadId}/continue`),
    // A Stop that reaches the server before the answer has begun there finds nothing to stop; leaving the stream stops
    // it instead, as it does when the request fails.
    stop: () =>
      void apiSend<{ stopped: boolean }>('POST', `/api/ai/threads/${threadId}/stop`)
        .then(({ stopped }) => {
          if (!stopped) controller.current?.abort()
        })
        .catch(() => controller.current?.abort()),
  }
}
