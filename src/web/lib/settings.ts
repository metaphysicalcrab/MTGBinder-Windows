import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { AiKeyStatus, BackupStatus, LibrarySize, Settings } from '../../shared/types.ts'
import { apiGet, apiSend } from './api.ts'
import { invalidateCollection } from './collection.ts'
import { formatBytes, megabyte } from './format.ts'
import { IS_WINDOWS } from './platform.ts'
import { useToast } from './toast.tsx'

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: ({ signal }) => apiGet<Settings>('/api/settings', signal) })
}

export function useUpdateSettings() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => apiSend<Settings>('PATCH', '/api/settings', patch),
    onSuccess: (settings) => {
      queryClient.setQueryData(['settings'], settings)
      invalidateCollection(queryClient)
    },
    onError: (err) => toast.error(`Couldn't save the setting: ${err.message}`),
  })
}

/** Whether an Anthropic API key is saved (spec §5.6). The key itself never comes back from the server. */
export function useAiKey() {
  return useQuery({ queryKey: ['ai-key'], queryFn: ({ signal }) => apiGet<AiKeyStatus>('/api/settings/ai', signal) })
}

/**
 * Saves a key, or removes it with null. The key is the mutation's variables, so it isn't kept in memory: the mutation
 * resets itself once it has worked, and leaves the cache as soon as nothing uses it (`gcTime: 0`).
 */
export function useSaveAiKey() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const save = useMutation({
    mutationFn: (apiKey: string | null) => apiSend<AiKeyStatus>('PUT', '/api/settings/ai', { apiKey }),
    gcTime: 0,
    onSuccess: (status) => {
      queryClient.setQueryData(['ai-key'], status)
      toast.success(status.configured ? 'Saved the API key.' : 'Removed the API key.')
    },
    onError: (err) => toast.error(`Couldn't save the API key: ${err.message}`),
  })
  const { isSuccess, reset } = save
  useEffect(() => {
    if (isSuccess) reset()
  }, [isSuccess, reset])
  return save
}

/** Checks a key (or, with none given, the saved one) against Anthropic's API. A typed key leaves the cache with it. */
export function useTestAiKey() {
  return useMutation({
    mutationFn: (apiKey?: string) => apiSend<{ ok: true }>('POST', '/api/settings/ai/test', apiKey ? { apiKey } : {}),
    gcTime: 0,
  })
}

/** When the last backup was made, and the folder backups are kept in (spec §5.6). */
export function useBackups() {
  return useQuery({ queryKey: ['backups'], queryFn: ({ signal }) => apiGet<BackupStatus>('/api/settings/backups', signal) })
}

/** Backs up the library now, saying which file it saved. */
export function useBackUpNow() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: () => apiSend<BackupStatus & { file: string }>('POST', '/api/settings/backups'),
    onSuccess: ({ file, ...status }) => {
      queryClient.setQueryData(['backups'], status)
      toast.success(`Saved ${file}.`)
    },
    onError: (err) => toast.error(err.message),
  })
}

/** The library file's size, its log's, and how much of the file is unused space (Settings → Library file). */
export function useLibrarySize() {
  return useQuery({ queryKey: ['library-size'], queryFn: ({ signal }) => apiGet<LibrarySize>('/api/settings/library', signal) })
}

/** Less unused space than this isn't worth compacting for. */
const WORTH_COMPACTING = 10_000_000

/**
 * What Settings → Library file says: the size (the file and its log, split out once the log holds 1 MB or more, so
 * the two figures aren't read as used and free) and the unused space inside the file, which compacting gives back.
 * Sizes are counted as the computer's file manager counts them (formatBytes).
 */
export function librarySizeText(size: LibrarySize, windows = IS_WINDOWS): { size: string; unused: string; worthIt: boolean } {
  const bytes = (n: number) => formatBytes(n, windows)
  const total = bytes(size.bytes + size.logBytes)
  const worthIt = size.freeBytes >= WORTH_COMPACTING
  return {
    size: size.logBytes >= megabyte(windows) ? `${total} (${bytes(size.bytes)} library + ${bytes(size.logBytes)} log)` : total,
    unused: worthIt ? `${bytes(size.freeBytes)} (Compact gives it back)` : 'Hardly any: nothing to compact',
    worthIt,
  }
}

/** What compacting the library answers: its size before and after, and the backup saved first. */
interface Compacted {
  before: LibrarySize
  after: LibrarySize
  backup: string
}

/** The toast after compacting, with the sizes Settings shows: the file and its log together. */
export function compactedToast({ before, after, backup }: Compacted, windows = IS_WINDOWS): string {
  const size = (s: LibrarySize) => formatBytes(s.bytes + s.logBytes, windows)
  return `Compacted the library from ${size(before)} to ${size(after)}, after saving ${backup}.`
}

/** Compacts the library, after a backup, and says what it gave back. */
export function useCompactLibrary() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: () => apiSend<Compacted>('POST', '/api/settings/library/compact'),
    onSuccess: (compacted) => {
      queryClient.setQueryData(['library-size'], compacted.after)
      void queryClient.invalidateQueries({ queryKey: ['backups'] })
      toast.success(compactedToast(compacted))
    },
    onError: (err) => toast.error(err.message),
  })
}
