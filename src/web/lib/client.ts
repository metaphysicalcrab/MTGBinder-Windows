import { createContext, useContext } from 'react'
import type { LanClient } from '../../shared/types.ts'
import { ApiRequestError } from './api.ts'

/**
 * Who this page is to Binder (spec §5.10), as GET /api/lan/me says before the app shows: the PC running Binder, a
 * paired phone, or a phone that isn't paired yet. A paired phone gets the app without the PC's own parts (the API key,
 * backups, the library file, phone access); an unpaired one gets only the pairing page.
 */
export type ClientView = { kind: 'pc' } | { kind: 'device'; id: number; name: string } | { kind: 'unpaired'; https: boolean }

/** The view for GET /api/lan/me's answer. */
export function clientFromAnswer(answer: LanClient): ClientView {
  switch (answer.client) {
    case 'device':
      return { kind: 'device', id: answer.id, name: answer.name }
    case 'unpaired':
      return { kind: 'unpaired', https: answer.https }
    default:
      return { kind: 'pc' }
  }
}

/**
 * The view when GET /api/lan/me failed: the app as it was before phones, whatever the failure (no answer, a Binder from
 * before phone access, which has no such route), so the PC is never locked out. A phone shown the app by mistake gets
 * 401 `unpaired` from its first request, which brings the pairing page (apiSignal).
 */
export function clientOnFailure(err: unknown): ClientView {
  return apiSignal(err) === 'unpaired' ? { kind: 'unpaired', https: false } : { kind: 'pc' }
}

/**
 * What an API error says about this page itself, rather than about what it asked: 401 `unpaired` (the PC forgot this
 * phone, or forgot every phone), or 403 `pc_only` (something only the PC may change).
 */
export function apiSignal(err: unknown): 'unpaired' | 'pc_only' | null {
  if (!(err instanceof ApiRequestError)) return null
  if (err.status === 401 && err.code === 'unpaired') return 'unpaired'
  if (err.status === 403 && err.code === 'pc_only') return 'pc_only'
  return null
}

/** What the gate is told: the PC forgot this phone, only the PC may change something, or this phone forgot itself. */
type Watcher = (signal: 'unpaired' | 'pc_only' | 'forgotten', message: string) => void
const watchers = new Set<Watcher>()

/**
 * Passes an API error that says something about this page (apiSignal) to the gate, which shows the pairing page or
 * says to change it on the PC. React Query's caches report every query's and change's error here (main.tsx), and
 * Brainstorm's stream its own.
 */
export function reportApiError(err: unknown): void {
  const signal = apiSignal(err)
  if (!signal) return
  for (const watcher of watchers) watcher(signal, (err as Error).message)
}

/** This phone forgot itself (Settings → This phone): the gate shows the pairing page. */
export function reportForgotten(): void {
  for (const watcher of watchers) watcher('forgotten', '')
}

/** Tells `watcher` of each error reportApiError passes on, until the returned function is called. */
export function watchApiSignals(watcher: Watcher): () => void {
  watchers.add(watcher)
  return () => watchers.delete(watcher)
}

/** The view the gate decided on. Outside the gate (the tests' rendering), the PC's. */
export const ClientContext = createContext<ClientView>({ kind: 'pc' })

export function useClient(): ClientView {
  return useContext(ClientContext)
}

/** Whether this page is a paired phone's, which hides the PC's own parts and never asks for them. */
export function useOnPhone(): boolean {
  return useClient().kind === 'device'
}

/**
 * The key a pairing QR code's link carries after `#k=` (`/pair#k=…`), or null. It's in the fragment so the request
 * for the page doesn't send it (no log or Referer holds it); the pairing page posts it.
 */
export function pairingKeyIn(hash: string): string | null {
  const key = /^#?(?:.*&)?k=([A-Za-z0-9_-]{8,64})(?:&|$)/.exec(hash)?.[1]
  return key ?? null
}

let startingKey: string | null = null
if (typeof window !== 'undefined') {
  startingKey = pairingKeyIn(window.location.hash)
  // Off the address at once, before anything else reads it: out of the history, and out of what's shown or shared.
  if (startingKey !== null) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
}

/** Whether the page was opened from a pairing QR code and hasn't paired with its key yet. */
export function hasPairingKey(): boolean {
  return startingKey !== null
}

/** The QR code's key, once: the pairing page posts it as it opens. */
export function takePairingKey(): string | null {
  const key = startingKey
  startingKey = null
  return key
}
