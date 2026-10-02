import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type Tone = 'success' | 'error'

interface Toast {
  id: number
  tone: Tone
  message: string
}

interface ToastApi {
  success: (message: string) => void
  error: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/** How long a toast stays up; errors stay longer so there's time to read them. */
const DURATION_MS: Record<Tone, number> = { success: 4000, error: 8000 }
/** Toasts shown at once; older ones make way. */
const MAX_TOASTS = 4

/**
 * Brief messages about changes (spec §6: toasts for mutations), stacked in the bottom-right corner; below lg, above the
 * bottom tab bar, and across the width of a phone.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), [])
  const show = useCallback(
    (tone: Tone, message: string) => {
      const id = ++nextId.current
      setToasts((list) => [...list.slice(-(MAX_TOASTS - 1)), { id, tone, message }])
      setTimeout(() => dismiss(id), DURATION_MS[tone])
    },
    [dismiss],
  )
  const api = useMemo<ToastApi>(
    () => ({ success: (message) => show('success', message), error: (message) => show('error', message) }),
    [show],
  )
  return (
    <ToastContext value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-[calc(var(--nav-height)+env(safe-area-inset-bottom)+0.75rem)] z-50 flex flex-col gap-2 sm:left-auto sm:w-80 sm:max-w-[calc(100vw-2rem)] lg:bottom-4"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-xl shadow-black/50 ${
              toast.tone === 'error' ? 'border-rose-900 bg-rose-950 text-rose-100' : 'border-emerald-900 bg-stone-900 text-stone-100'
            }`}
          >
            <span className="flex-1">{toast.message}</span>
            <button
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className="-mr-1 rounded px-1 text-stone-400 hover:bg-stone-800 hover:text-stone-100 pointer-coarse:-my-2.5 pointer-coarse:-mr-2.5 pointer-coarse:size-10 pointer-coarse:px-0"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
