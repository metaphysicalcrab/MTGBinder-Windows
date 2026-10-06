import type { Ownership } from '../../../shared/types.ts'

/**
 * "Own 3 · 1 free", "Own 1 · 3 short" when built decks claim more copies than I own, and "In Burn, Elves" (decks
 * that only consider it, on their maybe board, aren't named). Renders nothing for a card I don't own and no deck uses.
 * A span (laid out as a block), so a row that's one button can hold it.
 */
export function OwnershipBadge({ ownership }: { ownership: Ownership }) {
  const { owned, free } = ownership
  const decks = ownership.decks.filter((d) => d.quantity > 0)
  if (owned === 0 && decks.length === 0) return null
  const short = Math.max(0, -free)
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] leading-tight">
      {(owned > 0 || short > 0) && (
        <span
          title={short > 0 ? `Built decks use ${owned - free} copies but you own ${owned}` : undefined}
          className={`rounded px-1.5 py-0.5 font-medium ${
            short > 0 ? 'bg-rose-900/60 text-rose-200' : free > 0 ? 'bg-emerald-900/60 text-emerald-200' : 'bg-amber-900/50 text-amber-200'
          }`}
        >
          Own {owned}
          {short > 0 ? ` · ${short} short` : free !== owned ? ` · ${free} free` : ''}
        </span>
      )}
      {decks.length > 0 && (
        <span
          title={decks.map((d) => `${d.name} (${d.status}, ${d.quantity})`).join('\n')}
          className="max-w-full truncate rounded bg-stone-800 px-1.5 py-0.5 text-stone-300"
        >
          {/* A finger has no tooltip for the names cut off: it reads how many decks (the card's details name them). */}
          {decks.length > 1 ? (
            <>
              <span className="pointer-coarse:hidden">In {decks.map((d) => d.name).join(', ')}</span>
              <span className="hidden pointer-coarse:inline">In {decks.length} decks</span>
            </>
          ) : (
            `In ${decks[0]!.name}`
          )}
        </span>
      )}
    </span>
  )
}
