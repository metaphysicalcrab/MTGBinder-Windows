import { describe, expect, it } from 'vitest'
import { parseDecklist, toArena, toMtgo, type ExportLine } from '../../src/shared/decklist.ts'

/**
 * How long the guards against runaway regex backtracking give a parse. Backtracking gone wrong takes seconds or
 * minutes on these inputs; a sound parse takes milliseconds, though a busy or throttled PC (a Windows laptop scanning
 * every file it opens) can stretch that a long way, so the bound is generous.
 */
const QUICK_MS = 1000

const brief = (text: string) => parseDecklist(text).entries.map((e) => [e.quantity, e.name, e.board, e.setCode, e.collectorNumber])

describe('parseDecklist', () => {
  it('reads Arena exports with sections and printings', () => {
    const text = 'Commander\n1 Atraxa, Praetors\' Voice (2XM) 190\n\nDeck\n1 Sol Ring (CMR) 472\n4 Forest (M21) 272\n\nSideboard\n2 Duress (M20) 94\n'
    expect(brief(text)).toEqual([
      [1, "Atraxa, Praetors' Voice", 'commander', '2xm', '190'],
      [1, 'Sol Ring', 'main', 'cmr', '472'],
      [4, 'Forest', 'main', 'm21', '272'],
      [2, 'Duress', 'side', 'm20', '94'],
    ])
  })

  it('reads MTGO lists: SB: lines, or everything after the first blank line', () => {
    expect(brief('4 Lightning Bolt\nSB: 2 Duress')).toEqual([
      [4, 'Lightning Bolt', 'main', null, null],
      [2, 'Duress', 'side', null, null],
    ])
    expect(brief('4 Lightning Bolt\n20 Mountain\n\n2 Duress\n\n1 Pyroblast').map((e) => e[2])).toEqual(['main', 'main', 'side', 'side'])
  })

  it('reads Moxfield lines: 4x counts and *F* markers', () => {
    expect(brief('1x Sol Ring (CMR) 472 *F*\n2 Fire // Ice *F* *E*\nCounterspell')).toEqual([
      [1, 'Sol Ring', 'main', 'cmr', '472'],
      [2, 'Fire // Ice', 'main', null, null],
      [1, 'Counterspell', 'main', null, null],
    ])
  })

  it('accepts headings with colons, counts, and maybe/companion sections, and skips Arena "About" and comments', () => {
    const text = 'About\nName Burn\n\n// my deck\nDeck (2):\n2 Lightning Bolt\nCompanion\n1 Lurrus of the Dream-Den\nMaybeboard\n1 Fireball'
    expect(brief(text).map((e) => [e[1], e[2]])).toEqual([
      ['Lightning Bolt', 'main'],
      ['Lurrus of the Dream-Den', 'side'],
      ['Fireball', 'maybe'],
    ])
  })

  it('does not treat blank lines as a sideboard break once there are headings', () => {
    expect(brief('Deck\n4 Lightning Bolt\n\n20 Mountain').map((e) => e[2])).toEqual(['main', 'main'])
  })

  it('reports lines it cannot read, with their line numbers', () => {
    expect(parseDecklist('4 Lightning Bolt\n0 Sol Ring\n(CMR) 472').skipped).toEqual([
      { line: 2, text: '0 Sol Ring' },
      { line: 3, text: '(CMR) 472' },
    ])
  })

  it('reports a quantity over 999 as skipped, like any line it cannot read', () => {
    const huge = `1${'0'.repeat(200)} Forest`
    expect(parseDecklist(`1000 Forest\n999 Forest\nSB: 5000 Duress\n${huge}`)).toEqual({
      entries: [{ line: 2, quantity: 999, name: 'Forest', setCode: null, collectorNumber: null, board: 'main' }],
      skipped: [
        { line: 1, text: '1000 Forest' },
        { line: 3, text: 'SB: 5000 Duress' },
        { line: 4, text: huge },
      ],
    })
  })

  it('lists an Arena companion once, though the export repeats it in the sideboard', () => {
    const text = 'Companion\n1 Lurrus of the Dream-Den (IKO) 226\n\nDeck\n4 Lightning Bolt (M11) 149\n\nSideboard\n1 Lurrus of the Dream-Den (IKO) 226\n2 Duress (M20) 94\n'
    expect(parseDecklist(text).entries.map((e) => [e.line, e.quantity, e.name, e.board])).toEqual([
      [5, 4, 'Lightning Bolt', 'main'],
      [8, 1, 'Lurrus of the Dream-Den', 'side'],
      [9, 2, 'Duress', 'side'],
    ])
    // SB: lines count as the sideboard too, and names compare in any letter case.
    expect(brief('Companion\n1 Lurrus of the Dream-Den\n\n4 Lightning Bolt\nSB: 1 lurrus of the dream-den').map((e) => [e[1], e[2]])).toEqual([
      ['Lightning Bolt', 'main'],
      ['lurrus of the dream-den', 'side'],
    ])
  })

  it('adds a companion to the sideboard when the sideboard does not list it, keeping its line', () => {
    const text = 'Companion\n1 Lurrus of the Dream-Den\n\nDeck\n4 Lightning Bolt\n\nSideboard\n2 Duress'
    expect(parseDecklist(text).entries.map((e) => [e.line, e.name, e.board])).toEqual([
      [2, 'Lurrus of the Dream-Den', 'side'],
      [5, 'Lightning Bolt', 'main'],
      [8, 'Duress', 'side'],
    ])
  })

  it('ends a Commander section at a blank line', () => {
    expect(brief("Commander\n1 Atraxa, Praetors' Voice\n\n1 Sol Ring\n1 Arcane Signet").map((e) => [e[1], e[2]])).toEqual([
      ["Atraxa, Praetors' Voice", 'commander'],
      ['Sol Ring', 'main'],
      ['Arcane Signet', 'main'],
    ])
  })

  it('reads card-type group headings, which end a Commander section and never become cards', () => {
    const text = "Commander (1)\n1 Atraxa, Praetors' Voice\nCreatures (2)\n1 Birds of Paradise\n1 Llanowar Elves\nLands (1)\n1 Forest"
    expect(brief(text).map((e) => [e[1], e[2]])).toEqual([
      ["Atraxa, Praetors' Voice", 'commander'],
      ['Birds of Paradise', 'main'],
      ['Llanowar Elves', 'main'],
      ['Forest', 'main'],
    ])
    expect(parseDecklist(text).skipped).toEqual([])
  })

  it('keeps type groups inside a Sideboard section in the sideboard', () => {
    const text = 'Deck\n4 Lightning Bolt\nSideboard\nCreatures\n2 Grizzly Bears\nsorceries (2):\n2 Duress'
    expect(brief(text).map((e) => [e[1], e[2]])).toEqual([
      ['Lightning Bolt', 'main'],
      ['Grizzly Bears', 'side'],
      ['Duress', 'side'],
    ])
  })

  it('reads headings with a count and a colon in either order, and never reads an all-digit set code', () => {
    const text = 'Deck (99)\n1 Sol Ring\nSIDEBOARD:\n1 Duress\nDeck (99):\n1 Arcane Signet\nSideboard: 15\n1 Pyroblast\nDeck: (99)\n1 Command Tower'
    expect(brief(text).map((e) => [e[1], e[2]])).toEqual([
      ['Sol Ring', 'main'],
      ['Duress', 'side'],
      ['Arcane Signet', 'main'],
      ['Pyroblast', 'side'],
      ['Command Tower', 'main'],
    ])
    expect(parseDecklist(text).skipped).toEqual([])
    expect(brief('2 Forest (30A) 5\n1 Forest (30) 5').map((e) => e[3])).toEqual(['30a', null])
  })

  it('reads lines named like Object members as cards, never as headings', () => {
    expect(brief('Sideboard\n1 Duress\nconstructor\n__proto__\n1 Pyroblast').map((e) => [e[1], e[2]])).toEqual([
      ['Duress', 'side'],
      ['constructor', 'side'],
      ['__proto__', 'side'],
      ['Pyroblast', 'side'],
    ])
  })

  it('reports a line longer than 300 characters as skipped instead of reading it', () => {
    const long = `1 ${'Lightning Bolt '.repeat(20).trim()}`
    const longest = `1 ${'x'.repeat(298)}`
    expect([long.length, longest.length]).toEqual([301, 300])
    expect(parseDecklist(`${long}\n${longest}`)).toEqual({
      entries: [{ line: 2, quantity: 1, name: 'x'.repeat(298), setCode: null, collectorNumber: null, board: 'main' }],
      skipped: [{ line: 1, text: long }],
    })
  })

  it('skips a 10,000-character line with long runs of spaces and tabs quickly', () => {
    const line = `4 Lightning Bolt${`${' \t'.repeat(125)}x`.repeat(40)}`
    expect(line.length).toBeGreaterThan(10_000)
    const start = performance.now()
    expect(parseDecklist(line).skipped).toHaveLength(1)
    expect(performance.now() - start).toBeLessThan(QUICK_MS)
  })

  it('skips a single 200,000-character line of spaces, tabs, and markers quickly', () => {
    const line = `4 Lightning Bolt${' \t'.repeat(50_000)}${' *F*'.repeat(25_000)} x`
    expect(line.length).toBeGreaterThanOrEqual(200_000)
    const start = performance.now()
    const { entries, skipped } = parseDecklist(line)
    expect(performance.now() - start).toBeLessThan(QUICK_MS)
    expect(entries).toEqual([])
    expect(skipped).toEqual([{ line: 1, text: line }])
  })

  it('reads 180,000 characters of SB: lines separated by blank lines quickly', () => {
    const count = Math.ceil(180_000 / 'SB: 2 Duress\n\n'.length)
    const text = 'SB: 2 Duress\n\n'.repeat(count)
    expect(text.length).toBeGreaterThanOrEqual(180_000)
    const start = performance.now()
    const { entries, skipped } = parseDecklist(text)
    expect(performance.now() - start).toBeLessThan(QUICK_MS)
    expect(entries).toHaveLength(count)
    expect(entries.every((e) => e.name === 'Duress' && e.board === 'side')).toBe(true)
    expect(skipped).toEqual([])
  })

  it('reads 200,000 characters of lines holding U+2028 or U+2029 quickly', () => {
    for (const separator of [' ', ' ']) {
      const row = `4${' \t'.repeat(100)}X${' *F*'.repeat(24)}${separator}y`
      expect(row.length).toBe(300)
      const count = Math.ceil(200_000 / (row.length + 1))
      const text = `${row}\n`.repeat(count)
      expect(text.length).toBeGreaterThanOrEqual(200_000)
      const start = performance.now()
      const { entries, skipped } = parseDecklist(text)
      expect(performance.now() - start).toBeLessThan(QUICK_MS)
      expect(entries).toHaveLength(count)
      expect(skipped).toEqual([])
    }
  })

  it('reads 200,000 characters of lines padded with spaces and tabs quickly', () => {
    const block = `Deck${' \t'.repeat(15)}:\n4 Lightning Bolt${' \t'.repeat(40)}(M11) 149\n`
    const text = block.repeat(Math.ceil(200_000 / block.length))
    expect(text.length).toBeGreaterThanOrEqual(200_000)
    const start = performance.now()
    const { entries, skipped } = parseDecklist(text)
    expect(performance.now() - start).toBeLessThan(QUICK_MS)
    expect(entries).toHaveLength(Math.ceil(200_000 / block.length))
    expect(entries.every((e) => e.name === 'Lightning Bolt' && e.board === 'main' && e.setCode === 'm11')).toBe(true)
    expect(skipped).toEqual([])
  })
})

const lines: ExportLine[] = [
  { quantity: 1, name: "Atraxa, Praetors' Voice", board: 'commander', setCode: '2xm', collectorNumber: '190' },
  { quantity: 1, name: 'Sol Ring', board: 'main', setCode: 'cmr', collectorNumber: '472' },
  { quantity: 1, name: 'Fireball', board: 'maybe', setCode: null, collectorNumber: null },
  { quantity: 2, name: 'Duress', board: 'side', setCode: null, collectorNumber: null },
]

describe('export', () => {
  it('writes Arena sections, leaving out the maybe board', () => {
    expect(toArena(lines)).toBe("Commander\n1 Atraxa, Praetors' Voice (2XM) 190\n\nDeck\n1 Sol Ring (CMR) 472\n\nSideboard\n2 Duress\n")
  })

  it('writes MTGO text with commanders in the sideboard', () => {
    expect(toMtgo(lines)).toBe("1 Sol Ring\n\n1 Atraxa, Praetors' Voice\n2 Duress\n")
    expect(toMtgo(lines.filter((l) => l.board === 'commander'))).toBe("SB: 1 Atraxa, Praetors' Voice\n")
    expect(toMtgo([])).toBe('')
  })

  it('round-trips through parseDecklist', () => {
    const arena = parseDecklist(toArena(lines)).entries.map((e) => [e.quantity, e.name, e.board])
    expect(arena).toEqual([
      [1, "Atraxa, Praetors' Voice", 'commander'],
      [1, 'Sol Ring', 'main'],
      [2, 'Duress', 'side'],
    ])
    const mtgo = parseDecklist(toMtgo(lines)).entries.map((e) => [e.quantity, e.name, e.board])
    expect(mtgo).toEqual([
      [1, 'Sol Ring', 'main'],
      [1, "Atraxa, Praetors' Voice", 'side'],
      [2, 'Duress', 'side'],
    ])
  })
})
