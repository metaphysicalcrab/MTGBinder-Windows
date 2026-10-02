/** Settings' sections: a bordered panel each. */
export const section = 'rounded-xl border border-stone-800 bg-stone-900/40 p-4 sm:p-6'
/** A section's title and description, with its button beside them, or under them on a phone. */
export const sectionHead = 'flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4'
export const checkbox = 'accent-amber-500 shrink-0 pointer-coarse:size-5'
/** A secondary button, as Settings' Compact and Test are. */
export const plainButton =
  'rounded-md border border-stone-700 px-3 py-1.5 text-sm text-stone-200 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:py-2.5'
/** A button that forgets or removes something, as Settings' Remove (the API key) is. */
export const dangerButton =
  'rounded-md border border-rose-900 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-950 disabled:opacity-50 pointer-coarse:py-2.5'
/** The box that asks before something is forgotten or replaced, with its two buttons. */
export const confirmBox = 'flex flex-wrap items-center gap-2 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200'
export const confirmYes =
  'rounded-md bg-rose-700 px-2 py-1 text-rose-50 hover:bg-rose-600 disabled:opacity-50 pointer-coarse:px-3 pointer-coarse:py-2'
export const confirmNo =
  'rounded-md border border-stone-700 px-2 py-1 text-stone-300 hover:bg-stone-800 pointer-coarse:px-3 pointer-coarse:py-2'
