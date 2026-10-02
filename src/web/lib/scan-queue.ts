import { finishPrice } from '../../shared/prices.ts'
import type { AutoAddedScan, ScanBoard, ScanCommitResult, ScanItem } from '../../shared/types.ts'
import { BOARD_LABEL } from './decks.ts'
import { formatUsd, plural } from './format.ts'

/** "a", "a and b", "a, b and c". */
function joinAnd(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/**
 * The Add button's words for the ready scans (spec §5.1.3): how many cards, and how many of them go to decks as well.
 * "Add 60 cards to collection", "Add 60 cards (60 also to Elf Ball)", "Add 60 cards (45 also to 2 decks)".
 */
export function addLabel(ready: readonly ScanItem[]): string {
  const copies = ready.reduce((sum, i) => sum + i.quantity, 0)
  const toDecks = ready.filter((i) => i.target !== null)
  if (toDecks.length === 0) return `Add ${plural(copies, 'card')} to collection`
  const deckCopies = toDecks.reduce((sum, i) => sum + i.quantity, 0).toLocaleString('en-US')
  const names = new Set(toDecks.map((i) => i.target!.deckId))
  const where = names.size === 1 ? toDecks[0]!.target!.deckName : `${names.size} decks`
  return `Add ${plural(copies, 'card')} (${deckCopies} also to ${where})`
}

/**
 * What one scanned copy costs: its printing's price in the chosen finish ("$0.71", "$0.71 each" for several copies,
 * "no price"), or null before the scan has a card.
 */
export function scanPriceLabel(item: Pick<ScanItem, 'card' | 'finish' | 'quantity'>): string | null {
  if (!item.card) return null
  const usd = finishPrice(item.card.prices, item.finish)
  if (usd === null) return 'no price'
  return item.quantity > 1 ? `${formatUsd(usd)} each` : formatUsd(usd)
}

/** The most scans one commit request can name: `POST /api/scan/commit` refuses more (MAX_COMMIT_IDS). */
export const COMMIT_CHUNK_SIZE = 1000

/**
 * What a commit added, summed over its requests (the copies for each deck too); `error` is why it stopped early, or
 * null when every request worked.
 */
export interface CommitOutcome extends ScanCommitResult {
  error: Error | null
}

/**
 * Commits the scans with these ids in requests of at most COMMIT_CHUNK_SIZE ids, one after another. Stops at the first
 * request that fails and reports what the requests before it added, with the error; the scans it didn't add stay
 * ready in the queue.
 */
export async function commitInChunks(
  ids: readonly number[],
  send: (ids: number[]) => Promise<ScanCommitResult>,
): Promise<CommitOutcome> {
  const outcome: CommitOutcome = { items: 0, copies: 0, decks: [], error: null }
  for (let start = 0; start < ids.length; start += COMMIT_CHUNK_SIZE) {
    try {
      const added = await send(ids.slice(start, start + COMMIT_CHUNK_SIZE))
      outcome.items += added.items
      outcome.copies += added.copies
      for (const deck of added.decks) {
        const seen = outcome.decks.find((d) => d.id === deck.id)
        if (seen) seen.copies += deck.copies
        else outcome.decks.push({ ...deck })
      }
    } catch (err) {
      outcome.error = err instanceof Error ? err : new Error(String(err))
      break
    }
  }
  return outcome
}

/**
 * The one toast a commit shows: what it added, and for which decks, and if it stopped early, why. "Added 60 cards to
 * your collection, with 40 for Elf Ball and 20 for Burn."
 */
export function commitToast(outcome: CommitOutcome): { tone: 'success' | 'error'; message: string } {
  const decks = outcome.decks.map((d) => `${d.copies.toLocaleString('en-US')} for ${d.name}`)
  const added = `Added ${plural(outcome.copies, 'card')} to your collection${decks.length > 0 ? `, with ${joinAnd(decks)}` : ''}`
  if (outcome.error === null) return { tone: 'success', message: `${added}.` }
  if (outcome.items === 0) return { tone: 'error', message: `Couldn't add the scans: ${outcome.error.message}` }
  return {
    tone: 'error',
    message: `${added}, but couldn't add the rest: ${outcome.error.message}. They're still ready in the queue.`,
  }
}

/** What auto-commit added since the last look, in one toast: "Added Lightning Bolt to your collection, for Elf Ball." */
export function autoAddedToast(added: readonly AutoAddedScan[]): string {
  const copies = added.reduce((sum, a) => sum + a.copies, 0)
  const decks = [...new Set(added.flatMap((a) => (a.deckName === null ? [] : [a.deckName])))]
  const what = added.length === 1 && copies === 1 ? added[0]!.name : plural(copies, 'card')
  return `Added ${what} to your collection${decks.length > 0 ? `, for ${joinAnd(decks)}` : ''}.`
}

/**
 * The toast for sending every scan in the queue somewhere: "Sent 12 scans to Elf Ball · Main." or "12 scans now go to
 * your collection only."
 */
export function sentAllToast(scans: number, to: { deckName: string; board: ScanBoard } | null): string {
  if (to === null) return `${plural(scans, 'scan')} now go${scans === 1 ? 'es' : ''} to your collection only.`
  return `Sent ${plural(scans, 'scan')} to ${to.deckName} · ${BOARD_LABEL[to.board]}.`
}

/** The queue's counts (spec §5.1.3): ready to add (the rows Add counts), to check, and still being read. */
export function queueCounts(items: ReadonlyArray<Pick<ScanItem, 'status'>>): { ready: number; toCheck: number; reading: number } {
  let ready = 0
  let toCheck = 0
  let reading = 0
  for (const item of items) {
    if (item.status === 'confident') ready++
    else if (item.status === 'review') toCheck++
    else if (item.status === 'queued' || item.status === 'identifying') reading++
  }
  return { ready, toCheck, reading }
}

/**
 * What the empty queue says to do, for how this page captures: the live camera (`live`) or photos from the camera app,
 * and by a finger (`touch`: tap) or by keys and a mouse (Space, press).
 */
export function emptyQueueText(live: boolean, touch: boolean): string {
  if (!live) return `Captured cards appear here. ${touch ? 'Tap' : 'Press'} Take a photo of the card, then fit the guide to it.`
  return touch
    ? 'Captured cards appear here. Place a card in the guide and tap Capture, or, with the phone mounted over the mat, switch to Auto to capture each card as you set it down.'
    : 'Captured cards appear here. Place a card in the guide and press Capture or Space, or switch to Auto to capture each card as you set it down.'
}

/** The queue's note on auto captures with no text skipped in the last minute, or null for none. */
export function skippedNote(skipped: number): string | null {
  if (skipped === 0) return null
  return `Skipped ${plural(skipped, 'capture')} with no text in the last minute: the empty mat, or a card face down.`
}
