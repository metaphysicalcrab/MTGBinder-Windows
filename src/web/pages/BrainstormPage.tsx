import { Link, useNavigate, useParams } from 'react-router'
import { ChatView, type OpenWith } from '../components/brainstorm/ChatView.tsx'
import { Composer } from '../components/brainstorm/Composer.tsx'
import { ThreadList } from '../components/brainstorm/ThreadList.tsx'
import { useCreateThread } from '../lib/brainstorm.ts'
import { useAiKey } from '../lib/settings.ts'

const EXAMPLES = [
  'What could I build with the cards I already own?',
  'Suggest a Commander deck around my best green cards, and what I would need to buy.',
  'Which of my cards are worth building around?',
]

/** A new conversation: a box to ask in, and a few examples. Asking starts the conversation. */
function Start({ configured }: { configured: boolean }) {
  const create = useCreateThread()
  const navigate = useNavigate()
  const start = (ask: string) =>
    create.mutate(null, { onSuccess: (thread) => navigate(`/brainstorm/${thread.id}`, { state: { ask } satisfies OpenWith }) })
  return (
    <section aria-label="New conversation" className="space-y-5">
      <p className="text-stone-400">
        Brainstorm decks with Claude, grounded in what you own: it searches your library and Scryfall, reads your decks, and
        can save an idea to the deckbuilder as a prospective deck.
      </p>
      {configured ? (
        <>
          <Composer onSend={start} running={create.isPending} placeholder="What should I build next?" />
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                onClick={() => start(example)}
                disabled={create.isPending}
                className="rounded-full border border-stone-700 px-3 py-1 text-left text-sm text-stone-300 hover:bg-stone-800 disabled:opacity-50 pointer-coarse:py-2"
              >
                {example}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="rounded-lg border border-stone-800 bg-stone-900/60 p-4 text-stone-300">
          Brainstorming uses Claude through Anthropic's API, with your own API key.{' '}
          <Link to="/settings" className="text-amber-300 hover:underline">
            Add a key in Settings
          </Link>{' '}
          to start. Scanning never uses it.
        </p>
      )}
    </section>
  )
}

/**
 * Brainstorm with Claude (spec §5.5): the conversations on the left, the open one on the right. Below lg (a phone, a
 * portrait tablet) there's room for one: a conversation shows alone, with a link back to the list, and the start page
 * puts its box above the list.
 */
export function BrainstormPage() {
  const param = useParams().threadId
  const threadId = param === undefined ? null : Number(param)
  const { data: key } = useAiKey()
  const configured = key?.configured ?? true
  const open = threadId !== null && Number.isInteger(threadId)
  return (
    <div className="space-y-6">
      <h1 className="font-serif text-3xl font-semibold text-stone-50">Brainstorm</h1>
      <div className="grid gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div className={open ? 'hidden lg:block' : 'order-1 lg:order-none'}>
          <ThreadList />
        </div>
        {open ? (
          <div className="min-w-0 space-y-3">
            <Link to="/brainstorm" className="inline-block py-2 text-sm text-stone-400 hover:text-stone-100 lg:hidden">
              ← Conversations
            </Link>
            <ChatView key={threadId} threadId={threadId} configured={configured} />
          </div>
        ) : (
          <Start configured={configured} />
        )}
      </div>
    </div>
  )
}
