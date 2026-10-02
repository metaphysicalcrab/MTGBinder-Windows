import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LanClient } from '../../shared/types.ts'
import { apiGet, ApiRequestError } from '../lib/api.ts'
import { ClientContext, clientFromAnswer, clientOnFailure, hasPairingKey, watchApiSignals, type ClientView } from '../lib/client.ts'
import { useToast } from '../lib/toast.tsx'
import { PairPage } from '../pages/PairPage.tsx'

/** Asks who this page is (GET /api/lan/me), once more after a second when there's no answer at all. */
async function whoIsThis(): Promise<ClientView> {
  for (let attempt = 1; ; attempt++) {
    try {
      return clientFromAnswer(await apiGet<LanClient>('/api/lan/me', AbortSignal.timeout(5000)))
    } catch (err) {
      if (attempt === 1 && !(err instanceof ApiRequestError)) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }
      return clientOnFailure(err)
    }
  }
}

/** How long the same "change this on the PC" is said only once, however many requests are refused meanwhile. */
const PC_ONLY_QUIET_MS = 10_000

/**
 * What a page is shown (spec §5.10), decided before the app draws anything: the PC and a paired phone get the app
 * (`children`), told which they are through ClientContext; a phone that isn't paired gets only the pairing page, outside
 * the app's frame, where nothing polls the API. So does a paired phone opened from a pairing QR code, which pairs again
 * with it. A phone the PC forgets while it's open goes back to the pairing page at its next request (401 `unpaired`),
 * and everything the app had fetched is let go; a change only the PC may make says so once (403 `pc_only`).
 */
export function ClientGate({ onPaired, children }: { onPaired: () => void; children: ReactNode }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [view, setView] = useState<ClientView | null>(null)
  /** Whether this phone was paired until a moment ago, for the pairing page to say so. */
  const [lost, setLost] = useState(false)
  /** The name it had then, which it pairs again by unless it's changed. */
  const [lastName, setLastName] = useState<string | null>(null)
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  })
  /** Opened from a pairing QR code: a paired phone pairs again with it (or goes on to the app). */
  const [fromQrCode, setFromQrCode] = useState(hasPairingKey)
  const saidPcOnly = useRef(new Map<string, number>())

  useEffect(() => {
    let alive = true
    void whoIsThis().then((answer) => alive && setView(answer))
    return () => {
      alive = false
    }
  }, [])

  useEffect(
    () =>
      watchApiSignals((signal, message) => {
        if (signal !== 'pc_only') {
          const current = viewRef.current
          if (current?.kind === 'unpaired') return
          if (current?.kind === 'device') setLastName(current.name)
          setView({ kind: 'unpaired', https: window.location.protocol === 'https:' })
          setLost(signal === 'unpaired')
          return
        }
        const now = Date.now()
        if (now - (saidPcOnly.current.get(message) ?? -Infinity) < PC_ONLY_QUIET_MS) return
        saidPcOnly.current.set(message, now)
        toast.error(message)
      }),
    [toast],
  )

  // Once the app has gone, so do its queries: none is left to poll, and nothing fetched as the paired phone stays.
  const unpaired = view?.kind === 'unpaired'
  useEffect(() => {
    if (unpaired) queryClient.clear()
  }, [unpaired, queryClient])

  if (view === null) return null
  if (view.kind === 'unpaired' || (view.kind === 'device' && fromQrCode)) {
    return (
      <PairPage
        lost={lost}
        lastName={lastName}
        pairedAs={view.kind === 'device' ? view.name : null}
        onPaired={(device) => {
          setLost(false)
          setFromQrCode(false)
          setView({ kind: 'device', id: device.id, name: device.name })
          onPaired()
        }}
        onSkip={() => setFromQrCode(false)}
      />
    )
  }
  return <ClientContext value={view}>{children}</ClientContext>
}
