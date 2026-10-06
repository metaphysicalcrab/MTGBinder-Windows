import { beforeEach, describe, expect, it } from 'vitest'
import { scryfallToRow, type CardRow } from '../../src/server/cards/map.ts'
import { insertCardRows, rebuildCardNames } from '../../src/server/cards/repo.ts'
import { CsvError } from '../../src/server/collection/csv.ts'
import { previewImport, variantStages, withoutVariant } from '../../src/server/collection/import.ts'
import type { DB } from '../../src/server/db/index.ts'
import type { ImportRow } from '../../src/shared/types.ts'
import { createTestDb } from '../helpers/db.ts'
import { fixtureCard, syntheticCard } from '../helpers/fixtures.ts'
import { QUICK_MS } from '../helpers/timing.ts'

let db: DB
beforeEach(() => {
  db = createTestDb()
})

const id = (name: string, set?: string) => fixtureCard(name, set).id

function rows(csv: string): ImportRow[] {
  return previewImport(db, csv).rows
}

/** [status, card id, finish, quantity, note] for each row. */
function summary(csv: string) {
  return rows(csv).map((r) => [r.status, r.card?.id ?? null, r.finish, r.quantity, r.note])
}

describe('previewImport: columns', () => {
  it('reads a Moxfield export (Edition holds set codes)', () => {
    const csv = [
      '"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags","Last Modified","Collector Number"',
      '"2","0","Lightning Bolt","m10","Near Mint","English","","","2026-01-01","146"',
      '"1","0","Lightning Bolt","m11","Near Mint","English","foil","","2026-01-01","149"',
    ].join('\n')
    expect(summary(csv)).toEqual([
      ['resolved', id('Lightning Bolt', 'm10'), 'nonfoil', 2, null],
      ['resolved', id('Lightning Bolt', 'm11'), 'foil', 1, null],
    ])
  })

  it('reads a Deckbox export (Edition holds set names, Card Number the number)', () => {
    const csv = 'Count,Tradelist Count,Name,Edition,Card Number,Condition,Language,Foil\n3,0,Sol Ring,Commander Legends,472,Near Mint,English,'
    expect(summary(csv)).toEqual([['resolved', id('Sol Ring', 'cmr'), 'nonfoil', 3, null]])
  })

  it('reads a ManaBox export (Set code, Scryfall ID, finish words)', () => {
    const csv = [
      'Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID',
      `Lightning Bolt,sta,Strixhaven Mystical Archive,42,etched,uncommon,1,1,${id('Lightning Bolt', 'sta')}`,
    ].join('\n')
    expect(summary(csv)).toEqual([['resolved', id('Lightning Bolt', 'sta'), 'etched', 1, null]])
  })

  it('reads a Dragon Shield export (a "sep=," line before the header, Printing holds the finish)', () => {
    const csv = [
      '"sep=,"',
      'Folder Name,Quantity,Trade Quantity,Card Name,Set Code,Set Name,Card Number,Condition,Printing,Language,Price Bought,Date Bought,LOW,MID,MARKET',
      'Binder,4,0,Lightning Bolt,M10,Magic 2010,146,NearMint,Foil,English,1.00,2026-01-01,1.00,2.00,3.00',
    ].join('\r\n')
    expect(summary(csv)).toEqual([['resolved', id('Lightning Bolt', 'm10'), 'foil', 4, null]])
    expect(rows(csv)[0]?.line).toBe(3)
  })

  it('reads a TCGplayer export, whose Name can carry the variant: Simple Name first, else Name without it', () => {
    const csv = [
      'Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU',
      '1,Lightning Bolt (Borderless),Lightning Bolt,Strixhaven Mystical Archive,42,STA,Foil,Near Mint,English,Uncommon,1,2',
      '2,Sol Ring (Extended Art),,Commander Legends,472,CMR,Normal,Near Mint,English,Uncommon,3,4',
      '1,Sol Ring [Showcase],,,,,Normal,Near Mint,English,Uncommon,5,6',
    ].join('\n')
    expect(summary(csv)).toEqual([
      ['resolved', id('Lightning Bolt', 'sta'), 'foil', 1, null],
      ['resolved', id('Sol Ring', 'cmr'), 'nonfoil', 2, null],
      ['ambiguous', id('Sol Ring', 'c21'), 'nonfoil', 1, 'No set given; picked its usual printing'],
    ])
  })

  it('reads a TCGplayer Name whose variant it cannot strip through Simple Name', () => {
    const csv = [
      'Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU',
      '1,Lightning Bolt - Borderless,Lightning Bolt,Strixhaven Mystical Archive,42,STA,Normal,Near Mint,English,Uncommon,1,2',
    ].join('\n')
    expect(summary(csv)).toEqual([['resolved', id('Lightning Bolt', 'sta'), 'nonfoil', 1, null]])
  })

  it('strips every trailing variant note, in linear time', () => {
    expect(summary('Name\nSol Ring (Extended Art) [Foil]')).toEqual([
      ['ambiguous', id('Sol Ring', 'c21'), 'nonfoil', 1, 'No set given; picked its usual printing'],
    ])
    expect([withoutVariant('Bolt (a) [b] (c)'), withoutVariant('Bolt (a (b))'), withoutVariant('(a) [b]')]).toEqual(['Bolt', 'Bolt (a (b))', null])
    const start = performance.now()
    withoutVariant(`x${' '.repeat(100_000)})`)
    expect(performance.now() - start).toBeLessThan(QUICK_MS)
  })

  it('reads a misspelled name that ends in parentheses as that card, not as the card before the parentheses', () => {
    const erase = syntheticCard({ name: 'Erase', set: 'ulg', set_name: "Urza's Legacy" })
    const notUrzas = syntheticCard({ name: "Erase (Not the Urza's Legacy One)", set: 'unh', set_name: 'Unhinged' })
    insertCardRows(db, 'cards', [erase, notUrzas].map((c) => scryfallToRow(c) as CardRow))
    rebuildCardNames(db)
    expect(summary('Name\nErase (Not the Urza Legacy One)\nErase (Borderless)')).toEqual([
      ['ambiguous', notUrzas.id, 'nonfoil', 1, `Read "Erase (Not the Urza Legacy One)" as Erase (Not the Urza's Legacy One). No set given; picked its usual printing`],
      ['ambiguous', erase.id, 'nonfoil', 1, 'No set given; picked its usual printing'],
    ])
  })

  it('peels variant notes one at a time, so a card whose own name ends in parentheses keeps them', () => {
    const erase = syntheticCard({ name: 'Erase', set: 'ulg', set_name: "Urza's Legacy", collector_number: '6' })
    const notUrzas = syntheticCard({ name: "Erase (Not the Urza's Legacy One)", set: 'unh', set_name: 'Unhinged', collector_number: '7' })
    const bfm = syntheticCard({ name: 'B.F.M. (Big Furry Monster)', set: 'ugl', set_name: 'Unglued', collector_number: '28' })
    const bfmRight = syntheticCard({ name: 'B.F.M. (Big Furry Monster, Right Side)', set: 'ugl', set_name: 'Unglued', collector_number: '29' })
    insertCardRows(db, 'cards', [erase, notUrzas, bfm, bfmRight].map((c) => scryfallToRow(c) as CardRow))
    rebuildCardNames(db)
    // With its set and number: that printing, with nothing to note.
    const withNumber = [
      'Name,Set,Collector Number',
      "Erase (Not the Urza's Legacy One) [Foil],unh,7",
      'B.F.M. (Big Furry Monster) (Borderless),ugl,28',
      '"B.F.M. (Big Furry Monster, Right Side) [Foil]",ugl,29',
    ].join('\n')
    expect(summary(withNumber)).toEqual([
      ['resolved', notUrzas.id, 'nonfoil', 1, null],
      ['resolved', bfm.id, 'nonfoil', 1, null],
      ['resolved', bfmRight.id, 'nonfoil', 1, null],
    ])
    // Stacked notes and no set: that card, not the one named before its own parentheses.
    const stacked = ['Name', "Erase (Not the Urza's Legacy One) (Extended Art) [Foil Etched]", 'B.F.M. (Big Furry Monster) (Extended Art) [Foil]']
    expect(summary(stacked.join('\n'))).toEqual([
      ['ambiguous', notUrzas.id, 'nonfoil', 1, 'No set given; picked its usual printing'],
      ['ambiguous', bfm.id, 'nonfoil', 1, 'No set given; picked its usual printing'],
    ])
    // Stacked notes with its set: resolved.
    expect(summary(`Name,Set\n${stacked[1]},unh`)).toEqual([['resolved', notUrzas.id, 'nonfoil', 1, null]])
  })

  it('lists the names a written name could stand for, fullest first, never a blank one', () => {
    expect(variantStages("Erase (Not the Urza's Legacy One) (Extended Art) [Foil]")).toEqual([
      "Erase (Not the Urza's Legacy One) (Extended Art) [Foil]",
      "Erase (Not the Urza's Legacy One) (Extended Art)",
      "Erase (Not the Urza's Legacy One)",
      'Erase',
    ])
    // "()" would be the card named "_____".
    expect([variantStages('Sol Ring'), variantStages('(Borderless)'), variantStages('() [Foil]')]).toEqual([
      ['Sol Ring'],
      ['(Borderless)'],
      ['() [Foil]'],
    ])
  })

  it('looks up a name with a long run of notes in linear time', () => {
    const name = `Lightning Bolt${' (a)'.repeat(10_000)}`
    const start = performance.now()
    expect(summary(`Name,Set,Collector Number\n${name},,\n${name},m10,146`)).toEqual([
      ['ambiguous', id('Lightning Bolt', 'm11'), 'nonfoil', 1, 'No set given; picked its usual printing'],
      ['resolved', id('Lightning Bolt', 'm10'), 'nonfoil', 1, null],
    ])
    expect(performance.now() - start).toBeLessThan(QUICK_MS)
  })

  it('says when Simple Name and Name name different cards, going by Simple Name', () => {
    const csv = [
      'Quantity,Name,Simple Name,Set',
      '1,Chain Lightning,Lightning Bolt,m10',
      '1,Lightning Bolt - Borderless,Lightning Bolt,m10',
      // Starting with the Simple Name isn't enough: the variant comes after a word break.
      '1,Lightning Bolter,Lightning Bolt,m10',
    ].join('\n')
    expect(summary(csv)).toEqual([
      ['ambiguous', id('Lightning Bolt', 'm10'), 'nonfoil', 1, 'Its Name is "Chain Lightning"; went by its Simple Name'],
      ['resolved', id('Lightning Bolt', 'm10'), 'nonfoil', 1, null],
      ['ambiguous', id('Lightning Bolt', 'm10'), 'nonfoil', 1, 'Its Name is "Lightning Bolter"; went by its Simple Name'],
    ])
  })

  it('reads a file with a set name and collector number but no name', () => {
    expect(summary('Count,Set Name,Collector Number\n2,Magic 2010,146')).toEqual([['resolved', id('Lightning Bolt', 'm10'), 'nonfoil', 2, null]])
  })

  it('reads a file whose only name column is Simple Name', () => {
    expect(summary('Quantity,Simple Name,Condition\n2,Lightning Bolt,Near Mint')).toEqual([
      ['ambiguous', id('Lightning Bolt', 'm11'), 'nonfoil', 2, 'No set given; picked its usual printing'],
    ])
  })

  it("doesn't read a name that is only a variant note as the card named _____", () => {
    const blank = syntheticCard({ name: '_____', set: 'unh', set_name: 'Unhinged', collector_number: '23' })
    insertCardRows(db, 'cards', [scryfallToRow(blank) as CardRow])
    rebuildCardNames(db)
    expect(summary('Name\n_____')[0]?.slice(0, 2)).toEqual(['ambiguous', blank.id])
    expect(summary('Name\n(Borderless)\n[Showcase]')).toEqual([
      ['unresolved', null, 'nonfoil', 1, 'No card named "(Borderless)"'],
      ['unresolved', null, 'nonfoil', 1, 'No card named "[Showcase]"'],
    ])
    expect(summary('Name,Set,Number\n(Borderless),unh,23')).toEqual([
      ['unresolved', null, 'nonfoil', 1, 'Unhinged #23 is _____, not (Borderless). No card named "(Borderless)"'],
    ])
  })

  it('reads the card named _____ with a variant note after it', () => {
    const blank = syntheticCard({ name: '_____', set: 'unh', set_name: 'Unhinged', collector_number: '23' })
    insertCardRows(db, 'cards', [scryfallToRow(blank) as CardRow])
    rebuildCardNames(db)
    // Its name is only underscores, which normalize to nothing: peeling the note still leaves that card.
    expect(variantStages('_____ [Foil]')).toEqual(['_____ [Foil]', '_____'])
    expect(variantStages(`_____${' (a)'.repeat(10)}`).at(-1)).toBe('_____')
    expect(summary('Name\n_____ [Foil]')).toEqual([
      ['ambiguous', blank.id, 'nonfoil', 1, 'No set given; picked its usual printing'],
    ])
    expect(summary('Name,Set,Number\n_____ [Foil],unh,23')).toEqual([['resolved', blank.id, 'nonfoil', 1, null]])
    // TCGplayer's Simple Name for it: its Name is the same card with the variant, so there's nothing to say.
    expect(summary('Quantity,Name,Simple Name,Set\n1,_____ [Foil],_____,unh')).toEqual([
      ['resolved', blank.id, 'nonfoil', 1, null],
    ])
  })

  it('reads headings in any letter case and order, with a default count of 1', () => {
    expect(summary('card name,SET\nCounterspell,DSC')).toEqual([['resolved', id('Counterspell'), 'nonfoil', 1, null]])
  })

  it('rejects a file with no column naming the card', () => {
    expect(() => previewImport(db, 'Count,Condition\n1,NM')).toThrow(CsvError)
    expect(() => previewImport(db, 'Count,Condition\n1,NM')).toThrow(/found: Count, Condition/)
    expect(() => previewImport(db, '\n\n')).toThrow(/empty/)
  })

  it('skips blank lines and reports the line each row came from', () => {
    expect(rows('Name\n\nSol Ring\n\n"Fire // Ice"').map((r) => r.line)).toEqual([3, 5])
  })
})

describe('previewImport: resolution order', () => {
  it('trusts a Scryfall ID over the other columns', () => {
    expect(summary(`Name,Set,Scryfall ID\nSomething Else,m10,${id('Sol Ring', 'c21')}`)[0]?.slice(0, 2)).toEqual([
      'resolved',
      id('Sol Ring', 'c21'),
    ])
  })

  it('resolves set + collector number, ignoring leading zeros', () => {
    expect(summary('Set,Collector Number\nm10,0146')[0]?.slice(0, 2)).toEqual(['resolved', id('Lightning Bolt', 'm10')])
  })

  it('falls back to set + name when the number is wrong or names a different card', () => {
    expect(summary('Name,Set,Number\nLightning Bolt,m11,1')[0]).toEqual([
      'ambiguous',
      id('Lightning Bolt', 'm11'),
      'nonfoil',
      1,
      'Magic 2011 has no #1',
    ])
    const [status, cardId, , , note] = summary('Name,Set,Number\nSol Ring,dsc,114')[0] ?? []
    expect([status, cardId]).toEqual(['ambiguous', id('Sol Ring', 'c21')])
    expect(note).toMatch(/^Duskmourn: House of Horror Commander #114 is Counterspell, not Sol Ring\. Not printed in /)
  })

  it('resolves set + name when the set has one printing of the card', () => {
    expect(summary('Name,Set\nLightning Bolt,Magic 2010')[0]?.slice(0, 2)).toEqual(['resolved', id('Lightning Bolt', 'm10')])
  })

  it('picks the lowest collector number when a set has several printings, and says so', () => {
    const bolt = fixtureCard('Lightning Bolt', 'm10')
    const variant = scryfallToRow({ ...bolt, id: '00000000-0000-4000-8000-000000000300', collector_number: '300' })
    insertCardRows(db, 'cards', [variant as CardRow])
    rebuildCardNames(db)
    expect(summary('Name,Set\nLightning Bolt,m10')[0]).toEqual([
      'ambiguous',
      bolt.id,
      'nonfoil',
      1,
      '2 printings in Magic 2010; picked #146',
    ])
  })

  it('uses the default printing for a name alone, preferring one that comes in the finish', () => {
    expect(summary('Name\nLightning Bolt')[0]).toEqual([
      'ambiguous',
      id('Lightning Bolt', 'm11'),
      'nonfoil',
      1,
      'No set given; picked its usual printing',
    ])
    expect(summary('Name,Foil\nLightning Bolt,etched')[0]?.slice(0, 3)).toEqual(['ambiguous', id('Lightning Bolt', 'sta'), 'etched'])
  })

  it('explains a set it does not know or a card not printed in that set', () => {
    expect(summary('Name,Set\nSol Ring,zzz')[0]?.[4]).toBe('Unknown set "zzz". Picked its usual printing')
    expect(summary('Name,Set\nSol Ring,m10')[0]?.[4]).toBe('Not printed in Magic 2010. Picked its usual printing')
  })

  it('prefers the exact name, then a regular card, when two names match once punctuation is ignored', () => {
    const joke = scryfallToRow({ ...fixtureCard('Sol Ring', 'cmr'), id: '00000000-0000-4000-8000-00000000joke', oracle_id: '11111111-0000-4000-8000-00000000joke', name: 'Sol, Ring', set: 'unk', set_type: 'funny' }) as CardRow
    insertCardRows(db, 'cards', [joke])
    rebuildCardNames(db)
    expect(rows('Name,Set\nSol Ring,cmr\n"Sol, Ring",').map((r) => r.card?.name)).toEqual(['Sol Ring', 'Sol, Ring'])
  })

  it('matches names without regard to case, accents, punctuation, or which face is named', () => {
    const found = rows('Name\nlightning BOLT\nfire/ice\nDelver of Secrets\nInsectile Aberration\nAtraxa Praetors Voice\nLightning Bolt // Lightning Bolt')
    expect(found.map((r) => r.card?.name)).toEqual([
      'Lightning Bolt',
      'Fire // Ice',
      'Delver of Secrets // Insectile Aberration',
      'Delver of Secrets // Insectile Aberration',
      "Atraxa, Praetors' Voice",
      'Lightning Bolt', // reversible printings name both faces the same
    ])
  })
})

describe('previewImport: problems', () => {
  it('marks unknown cards and bad counts unresolved, with the reason', () => {
    expect(summary('Count,Name\n1,Not A Real Card\nx,Sol Ring\n0,Sol Ring\n10000,Sol Ring\n1,')).toEqual([
      ['unresolved', null, 'nonfoil', 1, 'No card named "Not A Real Card"'],
      ['unresolved', null, 'nonfoil', 0, 'The count "x" isn\'t a whole number of 1 or more'],
      ['unresolved', null, 'nonfoil', 0, 'The count "0" isn\'t a whole number of 1 or more'],
      ['unresolved', null, 'nonfoil', 10000, 'The count 10000 is more than 9999'],
      ['unresolved', null, 'nonfoil', 1, 'The row has no card name'],
    ])
  })

  it('adds a finish the printing has when the file asks for one it lacks', () => {
    expect(summary('Name,Set,Foil\nSol Ring,cmr,foil\nThrasios Triton Hero,c16,')).toEqual([
      ['resolved', id('Sol Ring', 'cmr'), 'nonfoil', 1, 'This printing has no foil version; adding nonfoil'],
      ['resolved', id('Thrasios, Triton Hero'), 'foil', 1, 'This printing has no nonfoil version; adding foil'],
    ])
  })

  it('reads finish words, treating other non-blank values as foil and saying so', () => {
    const finishes = rows('Name,Set,Foil\nLightning Bolt,sta,Normal\nLightning Bolt,sta,TRUE\nLightning Bolt,sta,Etched Foil\nLightning Bolt,sta,✓')
    // A word it doesn't know leaves the printing certain: Strixhaven Mystical Archive has one Lightning Bolt.
    expect(finishes.map((r) => [r.status, r.finish, r.note])).toEqual([
      ['resolved', 'nonfoil', null],
      ['resolved', 'foil', null],
      ['resolved', 'etched', null],
      ['resolved', 'foil', 'Read "✓" as foil'],
    ])
  })

  it('reads finish words that name Object members as unknown words (foil)', () => {
    const finishes = rows('Name,Set,Foil\nLightning Bolt,sta,constructor\nLightning Bolt,sta,__proto__')
    expect(finishes.map((r) => [r.finish, r.note])).toEqual([
      ['foil', 'Read "constructor" as foil'],
      ['foil', 'Read "__proto__" as foil'],
    ])
  })

  it('counts rows by status', () => {
    expect(previewImport(db, 'Name,Set\nSol Ring,cmr\nLightning Bolt,\nNope,').counts).toEqual({ resolved: 1, ambiguous: 1, unresolved: 1 })
  })
})
