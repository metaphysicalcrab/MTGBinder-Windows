import type { ReactNode } from 'react'

/**
 * The capture button's row, under the camera (spec §5.1.1). Below lg (a phone, a tablet) it's a bar that stays above the
 * bottom tabs while the camera is on screen, with the queue's summary (`summary`) beside the button, both in a thumb's
 * reach; from lg up, the plain row it has always been.
 */
export function CaptureBar({ summary, children }: { summary?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-[calc(var(--nav-height)+env(safe-area-inset-bottom)+0.5rem)] z-10 flex items-center gap-3 rounded-xl border border-stone-800 bg-stone-950/95 p-2 shadow-lg shadow-black/40 backdrop-blur lg:static lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-none">
      {children}
      {summary}
    </div>
  )
}

/** The big button's look in a CaptureBar: wide and tall for a thumb below lg, the desktop's amber button from lg up. */
export const CAPTURE_BUTTON =
  'flex min-h-12 flex-1 items-center justify-center rounded-lg bg-amber-500 px-3 text-center text-base leading-tight font-medium text-balance text-stone-950 hover:bg-amber-400 disabled:opacity-50 lg:min-h-0 lg:flex-none lg:rounded-md lg:px-4 lg:py-2 lg:text-sm lg:leading-5'
