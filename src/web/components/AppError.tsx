import { isRouteErrorResponse, useRouteError } from 'react-router'

/**
 * What shows when a page fails to draw, or there's no page at the address: instead of React Router's page for
 * developers, what happened and two ways on. Reload matters in Binder's desktop app and an installed phone app, which
 * have no address bar; Go to Library loads Binder afresh, in case the failure was in the header.
 */
export function AppError() {
  const error = useRouteError()
  const missing = isRouteErrorResponse(error) && error.status === 404
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error)
  return (
    <main className="mx-auto min-h-dvh max-w-xl space-y-5 bg-stone-950 px-4 py-12 text-stone-200">
      <p className="font-serif text-xl font-semibold tracking-wide text-amber-400">Binder</p>
      <h1 className="font-serif text-2xl font-semibold text-stone-50">
        {missing ? "There's no page at this address." : 'Something went wrong on this page.'}
      </h1>
      {!missing && (
        <>
          <p className="text-stone-400">Your library is safe: this is only the page. Reloading usually brings it back.</p>
          <pre className="overflow-x-auto rounded-lg border border-stone-800 bg-stone-900/60 p-3 font-mono text-xs whitespace-pre-wrap text-rose-200">
            {detail}
          </pre>
        </>
      )}
      <div className="flex flex-wrap gap-3">
        {!missing && (
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-400 pointer-coarse:py-3"
          >
            Reload
          </button>
        )}
        <a
          href="/library"
          className="rounded-md border border-stone-700 px-4 py-2 text-sm text-stone-200 hover:bg-stone-800 pointer-coarse:py-3"
        >
          Go to Library
        </a>
      </div>
    </main>
  )
}
