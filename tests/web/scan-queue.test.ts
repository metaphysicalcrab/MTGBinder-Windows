import { describe, expect, it } from 'vitest'
import { MAX_COMMIT_IDS } from '../../src/server/scanner/routes.ts'
import type { ScanItem, ScanTarget } from '../../src/shared/types.ts'
import { boardOnDeck, captureQuery, chosenDeck, freshTarget, parseTarget, TARGET_TTL_MS } from '../../src/web/lib/scan.ts'
import {
  addLabel,
  autoAddedToast,
  commitInChunks,
  commitToast,
  COMMIT_CHUNK_SIZE,
  emptyQueueText,
  queueCounts,
  scanPriceLabel,
  sentAllToast,
  skippedNote,
} from '../../src/web/lib/scan-queue.ts'

/** Each deck name the tests use has its own id. */
const deckIds = new Map<string, number>()
function deckIdOf(name: string): number {
  if (!deckIds.has(name)) deckIds.set(name, deckIds.size + 1)
  return deckIds.get(name)!
}

/** A ready scan: `printing` is its card's id (the same letter is the same card, "b" and "b2" are two printings of it). */
function scan(id: number, auto: boolean, printing: string | null, quantity = 1, deck: string | null = null): ScanItem {
  return {
    id,
    status: 'confident',
    method: 'ocr',
    reason: null,
    auto,
    card: printing
      ? {
          id: printing,
          oracleId: `oracle-${printing[0]}`,
          name: `Card ${printing[0]}`,
          setCode: 'syn',
          setName: 'Synthetic',
          collectorNumber: printing,
          imageSmall: null,
          finishes: ['nonfoil', 'foil', 'etched'],
          prices: { usd: 0.71, usdFoil: 2.5, usdEtched: null },
        }
      : null,
    finish: 'nonfoil',
    quantity,
    confidence: 1,
    candidates: [],
    error: null,
    createdAt: '2026-09-27T12:00:00.000Z',
    target: deck === null ? null : { deckId: deckIdOf(deck), board: 'main', deckName: deck },
    sameCardAsBefore: false,
  }
}
describe('addLabel', () => {
  it('counts the ready copies, and how many go to a deck as well', () => {
    expect(addLabel([scan(1, false, 'a', 2), scan(2, false, 'b')])).toBe('Add 3 cards to collection')
    expect(addLabel([scan(1, false, 'a')])).toBe('Add 1 card to collection')
    expect(addLabel([scan(1, false, 'a', 2, 'Elf Ball'), scan(2, false, 'b')])).toBe('Add 3 cards (2 also to Elf Ball)')
    expect(addLabel([scan(1, false, 'a', 1, 'Elf Ball'), scan(2, false, 'b', 1, 'Burn'), scan(3, false, 'c')])).toBe(
      'Add 3 cards (2 also to 2 decks)',
    )
    // Two decks whose names are the same length are still two decks.
    expect(addLabel([scan(1, false, 'a', 1, 'Burn'), scan(2, false, 'b', 1, 'Tron')])).toBe('Add 2 cards (2 also to 2 decks)')
    expect(addLabel([])).toBe('Add 0 cards to collection')
  })
})

describe('scanPriceLabel', () => {
  it("prices a scan by its printing's price in the chosen finish, per copy", () => {
    expect(scanPriceLabel(scan(1, false, 'a'))).toBe('$0.71')
    expect(scanPriceLabel({ ...scan(1, false, 'a'), finish: 'foil' })).toBe('$2.50')
    expect(scanPriceLabel(scan(1, false, 'a', 3))).toBe('$0.71 each')
    expect(scanPriceLabel({ ...scan(1, false, 'a'), finish: 'etched' })).toBe('no price')
    expect(scanPriceLabel(scan(1, false, null))).toBeNull()
  })
})

describe('captureQuery and parseTarget', () => {
  it("puts auto mode (and a lifted card) and the deck and board in a capture's query", () => {
    expect(captureQuery(false, null)).toBe('')
    expect(captureQuery(true, null)).toBe('?auto=1')
    expect(captureQuery(true, { deckId: 3, board: 'side' })).toBe('?auto=1&deck=3&board=side')
    // Auto mode saw the empty mat since its last capture: the card before was lifted.
    expect(captureQuery(true, null, true)).toBe('?auto=1&lifted=1')
    expect(captureQuery(false, null, true)).toBe('')
  })

  it('reads back a remembered target, and nothing that is not one', () => {
    const good: ScanTarget = { deckId: 3, board: 'commander' }
    expect(parseTarget(JSON.parse(JSON.stringify(good)))).toEqual(good)
    expect(parseTarget({ deckId: 3, board: 'maybe' })).toEqual({ deckId: 3, board: 'main' })
    for (const bad of [null, 'x', { deckId: '3' }, { deckId: 0 }, { deckId: 1.5, board: 'main' }]) expect(parseTarget(bad)).toBeNull()
    // The deck's creation time comes back with it, when it is one.
    const created = '2026-09-27T12:00:00.000Z'
    expect(parseTarget({ deckId: 3, board: 'side', createdAt: created })).toStrictEqual({ deckId: 3, board: 'side', createdAt: created })
    expect(parseTarget({ deckId: 3, board: 'side', createdAt: 5 })).toStrictEqual({ deckId: 3, board: 'side' })
  })
})

describe('freshTarget', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z')
  const created = '2026-09-27T12:00:00.000Z'
  const saved = (savedAt: unknown) => ({ deckId: 3, board: 'side', createdAt: created, savedAt })

  it('keeps a choice made in the last 8 hours: the same scanning session', () => {
    expect(TARGET_TTL_MS).toBe(8 * 60 * 60 * 1000)
    for (const at of [now, now - 60_000, now - TARGET_TTL_MS + 1]) {
      expect(freshTarget(saved(at), now)).toStrictEqual({ deckId: 3, board: 'side', createdAt: created })
    }
  })

  it('forgets a choice 8 hours old or more, so a later session starts with the collection only', () => {
    expect(freshTarget(saved(now - TARGET_TTL_MS), now)).toBeNull()
    expect(freshTarget(saved(now - 3 * 24 * 60 * 60 * 1000), now)).toBeNull()
  })

  it('forgets a choice saved with no time, from before a choice was dated', () => {
    expect(freshTarget({ deckId: 3, board: 'side', createdAt: created }, now)).toBeNull()
    expect(freshTarget({ deckId: 3, board: 'main' }, now)).toBeNull()
  })

  it('forgets a choice dated in the future, as after the clock was set back', () => {
    expect(freshTarget(saved(now + 1), now)).toBeNull()
    expect(freshTarget(saved(now + TARGET_TTL_MS), now)).toBeNull()
  })

  it('forgets a bad value: a time that is not a number, or a target that is not one', () => {
    for (const at of [String(now), null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(freshTarget(saved(at), now)).toBeNull()
    for (const bad of [null, 'x', 42, { savedAt: now }, { deckId: 0, board: 'main', savedAt: now }]) expect(freshTarget(bad, now)).toBeNull()
  })
})

describe('chosenDeck', () => {
  const elves = { id: 4, name: 'Elf Ball', createdAt: '2026-09-27T12:00:00.000Z' }
  const burn = { id: 5, name: 'Burn', createdAt: '2026-09-27T12:05:00.000Z' }

  it('finds the remembered deck by its id and creation time', () => {
    expect(chosenDeck({ deckId: 4, board: 'main', createdAt: elves.createdAt }, [burn, elves])).toBe(elves)
  })

  it('finds nothing when a later deck has the id of the one remembered', () => {
    // SQLite gives a new deck a deleted deck's id when that was the highest.
    const later = { id: 4, name: 'Goblins', createdAt: '2026-09-28T09:00:00.000Z' }
    expect(chosenDeck({ deckId: 4, board: 'main', createdAt: elves.createdAt }, [burn, later])).toBeNull()
    expect(chosenDeck({ deckId: 6, board: 'main', createdAt: elves.createdAt }, [burn, elves])).toBeNull()
  })

  it('goes by the id alone when the creation time is not known yet (a link, or a choice from before it was kept)', () => {
    expect(chosenDeck({ deckId: 5, board: 'side' }, [elves, burn])).toBe(burn)
    expect(chosenDeck({ deckId: 6, board: 'side' }, [elves, burn])).toBeNull()
  })

  it('finds nothing before the decks have loaded, or when nothing is chosen', () => {
    expect(chosenDeck({ deckId: 4, board: 'main', createdAt: elves.createdAt }, undefined)).toBeNull()
    expect(chosenDeck({ deckId: 4, board: 'main' }, undefined)).toBeNull()
    expect(chosenDeck(null, [elves, burn])).toBeNull()
  })
})

describe('boardOnDeck', () => {
  it('keeps the board when moving to another deck, but a commander board only where the format has one', () => {
    expect(boardOnDeck('commander', 'commander')).toBe('commander')
    expect(boardOnDeck('commander', 'casual')).toBe('commander')
    expect(boardOnDeck('commander', 'modern')).toBe('main')
    expect(boardOnDeck('commander', undefined)).toBe('main')
    expect(boardOnDeck('side', 'modern')).toBe('side')
    expect(boardOnDeck('main', 'commander')).toBe('main')
  })
})

describe('commitInChunks', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

  /** A stand-in for the commit request: each scan adds 2 copies; `fail` makes that request (1-based) fail. */
  function fakeSend(fail?: number) {
    const sent: number[][] = []
    let running = 0
    let overlapped = false
    const send = async (chunk: number[]) => {
      sent.push(chunk)
      if (running > 0) overlapped = true
      running++
      await new Promise((resolve) => setTimeout(resolve, 1))
      running--
      if (sent.length === fail) throw new Error('Request failed (500)')
      // Every request's first scan goes to deck 7 as well.
      return { items: chunk.length, copies: chunk.length * 2, decks: chunk.length > 0 ? [{ id: 7, name: 'Elf Ball', copies: 2 }] : [] }
    }
    return { send, sent, overlapped: () => overlapped }
  }

  it('sends at most as many ids per request as the server takes', () => {
    expect(COMMIT_CHUNK_SIZE).toBe(MAX_COMMIT_IDS)
  })

  it.each([
    [0, []],
    [1, [1]],
    [1000, [1000]],
    [1001, [1000, 1]],
    [2500, [1000, 1000, 500]],
  ])('commits %i ids in requests of %j, one after another, and sums what they added', async (n, sizes) => {
    const fake = fakeSend()
    const decks = sizes.length === 0 ? [] : [{ id: 7, name: 'Elf Ball', copies: 2 * sizes.length }]
    expect(await commitInChunks(ids(n), fake.send)).toEqual({ items: n, copies: 2 * n, decks, error: null })
    expect(fake.sent.map((chunk) => chunk.length)).toEqual(sizes)
    expect(fake.sent.flat()).toEqual(ids(n))
    expect(fake.overlapped()).toBe(false)
  })

  it('stops at a failing request, reporting what was added before it', async () => {
    const fake = fakeSend(2)
    const result = await commitInChunks(ids(2500), fake.send)
    expect(result).toEqual({ items: 1000, copies: 2000, decks: [{ id: 7, name: 'Elf Ball', copies: 2 }], error: new Error('Request failed (500)') })
    expect(fake.sent.map((chunk) => chunk.length)).toEqual([1000, 1000])
  })

  it('reports a failing first request with nothing added', async () => {
    const result = await commitInChunks(ids(3), fakeSend(1).send)
    expect(result).toEqual({ items: 0, copies: 0, decks: [], error: new Error('Request failed (500)') })
  })
})

describe('commitToast', () => {
  it('says how many cards were added, in one toast', () => {
    expect(commitToast({ items: 2500, copies: 2600, decks: [], error: null })).toEqual({
      tone: 'success',
      message: 'Added 2,600 cards to your collection.',
    })
  })

  it('says how many went to each deck as well', () => {
    const decks = [
      { id: 1, name: 'Elf Ball', copies: 40 },
      { id: 2, name: 'Burn', copies: 1 },
    ]
    expect(commitToast({ items: 60, copies: 60, decks, error: null }).message).toBe('Added 60 cards to your collection, with 40 for Elf Ball and 1 for Burn.')
    expect(commitToast({ items: 60, copies: 60, decks: decks.slice(0, 1), error: new Error('Request failed (500)') }).message).toBe(
      "Added 60 cards to your collection, with 40 for Elf Ball, but couldn't add the rest: Request failed (500). They're still ready in the queue.",
    )
  })

  it('says what was added before a failure, and that the rest are still ready', () => {
    expect(commitToast({ items: 1000, copies: 1000, decks: [], error: new Error('Request failed (500)') })).toEqual({
      tone: 'error',
      message: "Added 1,000 cards to your collection, but couldn't add the rest: Request failed (500). They're still ready in the queue.",
    })
    expect(commitToast({ items: 0, copies: 0, decks: [], error: new Error('Request failed (500)') })).toEqual({
      tone: 'error',
      message: "Couldn't add the scans: Request failed (500)",
    })
  })
})

describe('autoAddedToast', () => {
  it('names one card, or counts several, and says which decks they went to', () => {
    const bolt = { id: 1, name: 'Lightning Bolt', copies: 1, deckName: null }
    expect(autoAddedToast([bolt])).toBe('Added Lightning Bolt to your collection.')
    expect(autoAddedToast([{ ...bolt, deckName: 'Elf Ball' }])).toBe('Added Lightning Bolt to your collection, for Elf Ball.')
    expect(autoAddedToast([{ ...bolt, copies: 3 }])).toBe('Added 3 cards to your collection.')
    expect(
      autoAddedToast([
        { ...bolt, deckName: 'Elf Ball' },
        { ...bolt, id: 2, deckName: 'Burn' },
        { ...bolt, id: 3, deckName: 'Elf Ball' },
      ]),
    ).toBe('Added 3 cards to your collection, for Elf Ball and Burn.')
  })
})

describe('sending every scan somewhere, and skipped captures', () => {
  it('says where the scans went', () => {
    expect(sentAllToast(12, { deckName: 'Elf Ball', board: 'main' })).toBe('Sent 12 scans to Elf Ball · Main.')
    expect(sentAllToast(1, { deckName: 'Elf Ball', board: 'side' })).toBe('Sent 1 scan to Elf Ball · Sideboard.')
    expect(sentAllToast(3, null)).toBe('3 scans now go to your collection only.')
    expect(sentAllToast(1, null)).toBe('1 scan now goes to your collection only.')
  })

  it('notes auto captures skipped for having no text, only when there are some', () => {
    expect(skippedNote(0)).toBeNull()
    expect(skippedNote(1)).toBe('Skipped 1 capture with no text in the last minute: the empty mat, or a card face down.')
    expect(skippedNote(4)).toMatch(/^Skipped 4 captures with no text/)
  })
})

describe('the queue in a few words', () => {
  it('counts what is ready, what to check, and what is still being read', () => {
    const statuses: Array<ScanItem['status']> = ['confident', 'review', 'queued', 'identifying', 'confident', 'review', 'review', 'committed']
    expect(queueCounts(statuses.map((status) => ({ status })))).toEqual({ ready: 2, toCheck: 3, reading: 2 })
    expect(queueCounts([])).toEqual({ ready: 0, toCheck: 0, reading: 0 })
  })

  it('says how to capture: Space with keys, tap on a touch screen, and Take a photo without a live camera', () => {
    expect(emptyQueueText(true, false)).toBe(
      'Captured cards appear here. Place a card in the guide and press Capture or Space, or switch to Auto to capture each card as you set it down.',
    )
    expect(emptyQueueText(true, true)).toMatch(/tap Capture, or, with the phone mounted over the mat, switch to Auto/)
    expect(emptyQueueText(false, true)).toBe('Captured cards appear here. Tap Take a photo of the card, then fit the guide to it.')
    for (const text of [emptyQueueText(true, true), emptyQueueText(false, true), emptyQueueText(false, false)]) {
      expect(text).not.toMatch(/Space/)
    }
  })
})
