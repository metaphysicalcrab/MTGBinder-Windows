import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { BulkState, BulkStatus } from '../../shared/types.ts'
import { apiGet } from './api.ts'
import { useOnPhone } from './client.ts'

const RUNNING: readonly BulkState[] = ['downloading', 'importing']

export function isBulkRunning(status: BulkStatus | undefined): boolean {
  return status !== undefined && RUNNING.includes(status.state)
}

const bulkStatus = {
  queryKey: ['bulk-status'],
  queryFn: ({ signal }: { signal: AbortSignal }) => apiGet<BulkStatus>('/api/bulk/status', signal),
} as const

/** Card-data status, for a page to show. It's kept fresh by useBulkRefresh, in Layout. */
export function useBulkStatus() {
  return useQuery(bulkStatus)
}

/**
 * What a finished card-data refresh refetches, so the new data (names, images, prices) shows up: cached lookups,
 * searches, library stats, set/type lists, the Sets pages (whose totals follow the card data), decks, and the library
 * file's size (Settings).
 */
export const CARD_DATA_QUERIES = ['autocomplete', 'card', 'search', 'collection', 'catalog', 'sets', 'decks', 'deck', 'library-size'] as const

/** What a refresh refetches on this page: on a paired phone, not the library file's size, which only the PC may ask. */
export function cardDataQueries(phone: boolean): ReadonlyArray<(typeof CARD_DATA_QUERIES)[number]> {
  return phone ? CARD_DATA_QUERIES.filter((key) => key !== 'library-size') : CARD_DATA_QUERIES
}

/**
 * Keeps the card-data status fresh, polling every second while a refresh runs, and refetches CARD_DATA_QUERIES when a
 * run finishes. Layout calls this, once for every page.
 */
export function useBulkRefresh() {
  const queryClient = useQueryClient()
  const phone = useOnPhone()
  const query = useQuery({ ...bulkStatus, refetchInterval: (q) => (isBulkRunning(q.state.data) ? 1000 : false) })
  const running = isBulkRunning(query.data)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) {
      for (const key of cardDataQueries(phone)) void queryClient.invalidateQueries({ queryKey: [key] })
    }
    wasRunning.current = running
  }, [running, queryClient, phone])
}
