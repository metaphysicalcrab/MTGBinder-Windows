import { Link } from 'react-router'
import { useOnOverlayEntry } from '../../lib/back-to-close.ts'
import { PLATFORM, type Platform } from '../../lib/platform.ts'
import { useBulkStatus } from '../../lib/use-bulk-status.ts'
import { useOpenShortcuts } from '../ShortcutsDialog.tsx'

/** How scanning goes, said for the computer or phone Binder is open on. */
export function scanStepText(platform: Platform): string {
  switch (platform) {
    case 'mac':
      return 'Hold each card under your iPhone or webcam; Binder reads it on this Mac.'
    case 'windows':
      return 'Hold each card under a webcam, or scan with your phone; Binder reads it on this PC.'
    case 'android':
      return "Photograph each card with this phone's camera; Binder reads it on your computer."
    case 'other':
      return 'Hold each card under a webcam; Binder reads it on this computer.'
  }
}

const FIRST_STEPS: ReadonlyArray<{ to: string; state?: object; title: string; text: string }> = [
  { to: '/scan', title: 'Scan your cards', text: scanStepText(PLATFORM) },
  {
    to: '/library',
    state: { importing: true },
    title: 'Import a CSV',
    text: 'Bring a collection over from Moxfield, Deckbox, ManaBox, Archidekt, TCGplayer, or Dragon Shield.',
  },
  { to: '/decks', title: 'Scan or build a deck', text: 'Scan a deck you own into Binder, or plan one and see what it costs to finish.' },
]

/**
 * Three first steps, shown on Library while the collection is empty, where its results would be (spec §5.7). Nothing
 * before there's card data: the steps need it, and Library's CardDataNotice says how to get it.
 */
export function GettingStarted() {
  const openShortcuts = useOpenShortcuts()
  const noCardData = useBulkStatus().data?.cardCount === 0
  // With the import panel open above, a step replaces the panel's history entry (see useOnOverlayEntry).
  const fromOverlay = useOnOverlayEntry()
  if (noCardData) return null
  return (
    <section aria-labelledby="getting-started">
      <h2 id="getting-started" className="text-xs tracking-[0.2em] text-stone-500 uppercase">
        Getting started
      </h2>
      <ol className="mt-3 grid gap-3 sm:grid-cols-3">
        {FIRST_STEPS.map((step, i) => (
          <li key={step.to}>
            <Link
              to={step.to}
              state={step.state}
              replace={fromOverlay}
              className="block h-full rounded-xl border border-stone-800 bg-stone-900/40 p-4 hover:border-amber-700/60 hover:bg-stone-900"
            >
              <span className="text-xs text-amber-400 tabular-nums">{i + 1}</span>
              <p className="mt-1 font-medium text-stone-100">{step.title}</p>
              <p className="mt-1 text-sm text-stone-400">{step.text}</p>
            </Link>
          </li>
        ))}
      </ol>
      {/* A button as well as "press ?", for someone who hasn't met the shortcuts yet; nothing for a finger, with no keys. */}
      <p className="mt-4 text-xs text-stone-500 pointer-coarse:hidden">
        <button onClick={openShortcuts} className="text-amber-300 hover:underline">
          Keyboard shortcuts
        </button>{' '}
        (or press ? anywhere but a text box or dropdown)
      </p>
    </section>
  )
}
