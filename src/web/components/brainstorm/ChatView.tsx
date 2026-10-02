import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ApiRequestError } from '../../lib/api.ts'
import {
  asSentence,
  awaitingClaude,
  shownItems,
  useAnswer,
  useCreateThread,
  useDeleteThread,
  useRenameThread,
  useThread,
} from '../../lib/brainstorm.ts'
import { formatUsd } from '../../lib/format.ts'
import { ChatItemView } from './ChatItemView.tsx'
import { Composer } from './Composer.tsx'

/** A message to send as soon as a new conversation opens (from the start page's box or an example). */
export interface OpenWith {
  ask?: string
}

/** How far below the window (px) the conversation's end may be for it to follow a growing answer. */
const FOLLOW_SLACK = 120

/** One conversation (spec §5.5): its header, the items, and the message box. */
export function ChatView({ threadId, configured }: { threadId: number; configured: boolean }) {
  const answer = useAnswer(threadId)
  const { data: thread, error } = useThread(threadId, { answering: answer.running })
  const rename = useRenameThread(threadId)
  const navigate = useNavigate()
  const remove = useDeleteThread(threadId, () => navigate('/brainstorm'))
  const create = useCreateThread()
  const location = useLocation()
  const [title, setTitle] = useState('')
  // Set by Escape: the blur it causes must not save the title typed so far (as the deck name in DeckHeader).
  const titleCancelled = useRef(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const asked = useRef(false)

  useEffect(() => setTitle(thread?.title ?? ''), [thread?.title])

  // A new conversation opened with a question sends it once, then forgets it (so going back doesn't ask again).
  const ask = (location.state as OpenWith | null)?.ask
  useEffect(() => {
    if (!ask || asked.current || !thread || !configured) return
    asked.current = true
    navigate(location.pathname, { replace: true, state: null })
    if (thread.items.length === 0) void answer.send(ask)
  }, [ask, thread, configured, answer, navigate, location.pathname])

  const items = shownItems(thread?.items ?? [], answer)
  const thinking = awaitingClaude(answer)

  // Follow the answer as it grows, down to the message box, but only while the reader is at the conversation's end
  // (not the page's: the list of conversations beside it can be longer). Someone who has scrolled up stays put.
  const following = useRef(true)
  useEffect(() => {
    const onScroll = () => {
      const end = bottom.current?.getBoundingClientRect().bottom
      if (end !== undefined) following.current = end - window.innerHeight <= FOLLOW_SLACK
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  const last = items.at(-1)
  // On opening, bring the conversation into view (the window may be scrolled down a long list of conversations); after
  // that, follow only downward: with the end already in view, scrolling to it would pull the window back up. `loaded`:
  // an empty conversation changes nothing else when it arrives.
  const shown = useRef(false)
  const loaded = thread !== undefined
  useLayoutEffect(() => {
    const end = bottom.current?.getBoundingClientRect().bottom
    if (end === undefined) return
    if (!shown.current || (following.current && end > window.innerHeight)) bottom.current!.scrollIntoView({ block: 'end' })
    shown.current = true
  }, [loaded, items.length, last && 'text' in last ? last.text.length : 0, thinking, answer.running])

  if (error) {
    return (
      <p role="alert" className="text-rose-300">
        {error instanceof ApiRequestError && error.status === 404 ? 'There is no such conversation.' : error.message}
      </p>
    )
  }
  if (!thread) return <p className="text-stone-500">Loading…</p>

  const busyElsewhere = thread.busy && !answer.running
  const offerContinue = !answer.running && thread.canContinue && configured && !busyElsewhere
  // Why the last answer failed. While it runs, the failure shows as its last item instead.
  const failure = answer.running ? null : answer.lastError
  return (
    <section aria-label="Conversation" className="flex min-h-[70vh] min-w-0 flex-col gap-4 self-start">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-stone-800 pb-3">
        <input
          aria-label="Conversation title"
          value={title}
          maxLength={100}
          placeholder="New conversation"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (titleCancelled.current) {
              titleCancelled.current = false
              return
            }
            const trimmed = title.trim()
            if (trimmed === '') setTitle(thread.title)
            else if (trimmed !== thread.title) rename.mutate(trimmed)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              titleCancelled.current = true
              setTitle(thread.title)
              e.currentTarget.blur()
            }
          }}
          enterKeyHint="done"
          className="min-w-0 flex-1 basis-full rounded-md border border-transparent bg-transparent px-1 text-xl font-semibold text-stone-50 hover:border-stone-800 focus:border-stone-700 focus:outline-none sm:basis-0"
        />
        {thread.deck && (
          <Link to={`/decks/${thread.deck.id}`} className="text-sm text-amber-300 hover:underline">
            {thread.deck.name}
          </Link>
        )}
        <span className="text-sm text-stone-500" title="Estimated from the tokens each answer used, at each model's prices">
          ≈ {formatUsd(thread.costUsd)}
          {/* What the figure is, for a finger, which has no tooltip. */}
          <span className="hidden pointer-coarse:inline"> API cost so far</span>
        </span>
        {confirmingDelete ? (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            Delete this conversation?
            <button
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="rounded-md border border-rose-900 px-2 py-0.5 text-rose-300 hover:bg-rose-950 disabled:opacity-50 pointer-coarse:px-3 pointer-coarse:py-2"
            >
              Delete
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="rounded-md border border-stone-700 px-2 py-0.5 text-stone-300 hover:bg-stone-800 pointer-coarse:px-3 pointer-coarse:py-2"
            >
              Keep
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            disabled={answer.running}
            className="text-sm text-stone-500 hover:text-rose-300 disabled:opacity-50 pointer-coarse:py-2"
          >
            Delete
          </button>
        )}
      </header>

      <div className="flex-1 space-y-4" aria-live="polite">
        {items.length === 0 && !answer.running && (
          <p className="text-stone-500">
            {thread.deck ? `Ask about ${thread.deck.name}: what to add, cut, or buy first.` : 'Ask Claude what to build, or how to improve a deck.'}
          </p>
        )}
        {items.map((item, i) => (
          <ChatItemView key={i} item={item} live={answer.running && i === items.length - 1} />
        ))}
        {thinking && <p className="animate-pulse text-sm text-stone-500">Thinking…</p>}
        {(failure !== null || offerContinue) && (
          <p className="text-sm text-stone-400 wrap-break-word">
            {failure !== null ? <span className="text-rose-300">{asSentence(failure)}</span> : "Claude hasn't finished answering."}
            {offerContinue && (
              <>
                {' '}
                <button onClick={() => void answer.resume()} className="text-amber-300 hover:underline">
                  Continue
                </button>
              </>
            )}
          </p>
        )}
        {busyElsewhere && <p className="animate-pulse text-sm text-stone-500">Claude is answering in another window…</p>}
      </div>

      {configured && thread.tooLong && !answer.running ? (
        // Grown too long for Claude: another message would only send it all again (the server refuses one).
        <p className="rounded-lg border border-stone-800 bg-stone-900/60 p-3 text-sm text-stone-400">
          Claude can't take any more of this conversation.{' '}
          <button
            onClick={() => create.mutate(thread.deck?.id ?? null, { onSuccess: (t) => navigate(`/brainstorm/${t.id}`) })}
            disabled={create.isPending}
            className="text-amber-300 hover:underline disabled:opacity-50"
          >
            Start a new conversation
          </button>
          {thread.deck ? ` about ${thread.deck.name}.` : '.'}
        </p>
      ) : configured ? (
        <Composer
          onSend={(text) => void answer.send(text)}
          onStop={answer.stop}
          running={answer.running}
          disabled={busyElsewhere}
          placeholder={thread.deck ? `Ask about ${thread.deck.name}…` : 'Ask Claude…'}
        />
      ) : (
        <p className="rounded-lg border border-stone-800 bg-stone-900/60 p-3 text-sm text-stone-400">
          Brainstorming needs an Anthropic API key.{' '}
          <Link to="/settings" className="text-amber-300 hover:underline">
            Add one in Settings
          </Link>
          .
        </p>
      )}
      <div ref={bottom} />
    </section>
  )
}
