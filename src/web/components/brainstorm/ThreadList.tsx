import { Link, NavLink } from 'react-router'
import { useThreads } from '../../lib/brainstorm.ts'

/** Every conversation, the most recent first, with a way to start a new one. */
export function ThreadList() {
  const { data: threads, error } = useThreads()
  return (
    <nav aria-label="Conversations" className="space-y-3">
      <Link
        to="/brainstorm"
        className="block rounded-md border border-stone-700 px-3 py-1.5 text-center text-sm text-stone-200 hover:bg-stone-800 pointer-coarse:py-2.5"
      >
        New conversation
      </Link>
      {error && <p className="text-sm text-rose-300">Couldn't load conversations: {error.message}</p>}
      <ul className="space-y-0.5">
        {threads?.map((t) => (
          <li key={t.id}>
            <NavLink
              to={`/brainstorm/${t.id}`}
              className={({ isActive }) =>
                `block rounded-md px-3 py-1.5 text-sm pointer-coarse:py-2.5 ${isActive ? 'bg-stone-800 text-stone-50' : 'text-stone-400 hover:bg-stone-900 hover:text-stone-100'}`
              }
            >
              <span className="block truncate">{t.title || 'New conversation'}</span>
              {t.deck && <span className="block truncate text-xs text-amber-300/70">{t.deck.name}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
