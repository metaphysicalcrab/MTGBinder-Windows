import { Link } from 'react-router'
import { useOnOverlayEntry } from '../../lib/back-to-close.ts'
import { isBulkRunning, useBulkStatus } from '../../lib/use-bulk-status.ts'

/**
 * Says what to do while there's no card data yet (a first run): it's downloading, or Settings imports it. Nothing once
 * there is card data. Without it, nothing can be looked up, scanned, or added.
 */
export function CardDataNotice() {
  const { data: status } = useBulkStatus()
  // With Library's import panel open, the link replaces the panel's history entry (see useOnOverlayEntry).
  const fromOverlay = useOnOverlayEntry()
  if (status === undefined || status.cardCount > 0) return null
  return (
    <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 p-5 text-amber-100">
      {isBulkRunning(status) ? (
        'Downloading card data from Scryfall. This takes about a minute.'
      ) : (
        <>
          No card data yet.{' '}
          <Link to="/settings" replace={fromOverlay} className="font-medium text-amber-300 underline underline-offset-2">
            Import it from Scryfall in Settings
          </Link>{' '}
          (about a minute).
        </>
      )}
    </div>
  )
}
