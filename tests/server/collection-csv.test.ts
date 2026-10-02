import { describe, expect, it } from 'vitest'
import { CsvError, csvLine, parseCsv } from '../../src/server/collection/csv.ts'
import { QUICK_MS } from '../helpers/timing.ts'

const cells = (text: string) => parseCsv(text).map((r) => r.cells)

describe('parseCsv', () => {
  it('splits rows and cells', () => {
    expect(cells('Count,Name\n2,Lightning Bolt\n1,Sol Ring')).toEqual([
      ['Count', 'Name'],
      ['2', 'Lightning Bolt'],
      ['1', 'Sol Ring'],
    ])
  })

  it('reads quoted cells with commas, doubled quotes, and line breaks', () => {
    expect(cells('"Atraxa, Praetors\' Voice","say ""hi""","two\nlines"\nnext')).toEqual([
      ["Atraxa, Praetors' Voice", 'say "hi"', 'two\nlines'],
      ['next'],
    ])
  })

  it('reports the line each record starts on, counting line breaks inside quotes', () => {
    expect(parseCsv('a\n"b\nc"\nd').map((r) => r.line)).toEqual([1, 2, 4])
    // Old Mac files end lines with CR alone, inside quoted cells too; CRLF counts once.
    expect(parseCsv('a\r"b\rc"\rd').map((r) => r.line)).toEqual([1, 2, 4])
    expect(parseCsv('a\r\n"b\r\nc"\r\nd').map((r) => r.line)).toEqual([1, 2, 4])
  })

  it('accepts CRLF endings, a trailing line break, a byte-order mark, and empty cells', () => {
    expect(cells('﻿a,b\r\n1,\r\n,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['', '2'],
    ])
  })

  it('uses tabs or semicolons when the header line has no commas', () => {
    expect(cells('Count\tName\n1\tSol Ring')).toEqual([['Count', 'Name'], ['1', 'Sol Ring']])
    expect(cells('Count;Name\n1;Sol Ring')).toEqual([['Count', 'Name'], ['1', 'Sol Ring']])
  })

  it('takes the delimiter from a leading Excel "sep=" line and skips it, keeping file line numbers', () => {
    expect(parseCsv('sep=,\nCount,Name\n1,Sol Ring')).toEqual([
      { line: 2, cells: ['Count', 'Name'] },
      { line: 3, cells: ['1', 'Sol Ring'] },
    ])
    // The header has a comma, but the sep= line says semicolons.
    expect(parseCsv('\ufeff"sep=;"\r\nName;Note, if any\r\nSol Ring;signed, mint')).toEqual([
      { line: 2, cells: ['Name', 'Note, if any'] },
      { line: 3, cells: ['Sol Ring', 'signed, mint'] },
    ])
    // Saved again by a spreadsheet: padded with spaces or empty cells.
    for (const sep of ['sep=, ', '"sep=,",,,', 'sep=;;;']) {
      expect([sep, cells(`${sep}\nCount${sep.includes(';') ? ';' : ','}Name`)]).toEqual([sep, [['Count', 'Name']]])
    }
  })

  it('reads a quoted cell with spaces before its opening quote', () => {
    expect(cells('1, "Atraxa, Praetors\' Voice",x')).toEqual([['1', "Atraxa, Praetors' Voice", 'x']])
    // So a stray quote after spaces opens a quoted value too: one that never closes is an error naming its line.
    expect(() => parseCsv('Count,Name\na, "b')).toThrow(CsvError)
    expect(() => parseCsv('Count,Name\na, "b')).toThrow(/^A quoted value starting on line 2 never ends/)
  })

  it('keeps a quote inside an unquoted cell as text', () => {
    expect(cells('5" ruler,x')).toEqual([['5" ruler', 'x']])
  })

  it('reads a long cell full of stray quotes in linear time', () => {
    const cell = 'a"'.repeat(200_000)
    const start = performance.now()
    expect(cells(cell)).toEqual([[cell]])
    expect(performance.now() - start).toBeLessThan(QUICK_MS)
  })

  it('returns nothing for empty text', () => {
    expect(parseCsv('')).toEqual([])
  })

  it('rejects a quoted cell that never closes, naming its line', () => {
    expect(() => parseCsv('a\n"oops,b\nc')).toThrow(CsvError)
    expect(() => parseCsv('a\n"oops,b\nc')).toThrow(/line 2/)
  })
})

describe('csvLine', () => {
  it('quotes only cells that need it', () => {
    expect(csvLine([2, 'Lightning Bolt', "Atraxa, Praetors' Voice", 'say "hi"', ' edge'])).toBe(
      '2,Lightning Bolt,"Atraxa, Praetors\' Voice","say ""hi"""," edge"',
    )
  })

  it('quotes text starting like a formula, keeping it one cell that spreadsheets honoring quotes read as text', () => {
    expect(csvLine([1, '+2 Mace', '=cmd', '-x', '@y', 'a+b'])).toBe('1,"+2 Mace","=cmd","-x","@y",a+b')
    expect(csvLine([-3])).toBe('-3')
  })

  it('round-trips through parseCsv', () => {
    const row = ['a,b', 'c"d', 'e\nf', '', 'plain']
    expect(cells(csvLine(row))).toEqual([row])
  })
})
