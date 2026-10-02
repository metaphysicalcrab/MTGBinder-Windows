import { IS_WINDOWS } from './platform.ts'

export function formatUsd(value: number | null): string {
  return value === null ? '—' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatDate(iso: string | null): string {
  if (!iso) return 'never'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** "1 row", "2,345 rows"; pass the plural when it isn't singular + "s" ("copy", "copies"). */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`
}

/**
 * A file size: "460 MB", "8.4 MB", "512 KB", as the computer's file manager counts: 1 MB is 1,000,000 bytes in Finder,
 * and 1,048,576 (1,024 KB of 1,024 bytes) in Windows' File Explorer. Rounded before the unit is chosen, so 999,600
 * bytes is "1.0 MB" in Finder's count (not "1000 KB") and 9,960,000 is "10 MB" (not "10.0 MB").
 */
export function formatBytes(bytes: number, windows = IS_WINDOWS): string {
  const k = windows ? 1024 : 1000
  const kb = Math.round(bytes / k)
  if (kb < 1000) return `${Math.max(bytes === 0 ? 0 : 1, kb)} KB`
  const mbToTenths = Math.round(bytes / ((k * k) / 10)) / 10
  if (mbToTenths < 10) return `${mbToTenths.toFixed(1)} MB`
  return `${Math.round(bytes / (k * k)).toLocaleString('en-US')} MB`
}

/** One megabyte, as formatBytes counts it. */
export function megabyte(windows = IS_WINDOWS): number {
  return windows ? 1024 * 1024 : 1_000_000
}
