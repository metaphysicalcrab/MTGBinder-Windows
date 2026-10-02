import { describe, expect, it } from 'vitest'
import { decodeCsvBytes } from '../../src/web/lib/csv-bytes.ts'

const CSV = 'Count,Name\r\n1,Lim-Dûl the Necromancer\r\n2,Ifh-Bíff Efreet\r\n'

const utf8 = (text: string) => new TextEncoder().encode(text)
const utf16 = (text: string, littleEndian: boolean) => {
  const bytes = new Uint8Array(2 + text.length * 2)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0xfeff, littleEndian)
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian)
  return bytes
}
/** The text in Windows-1252, as Excel on Windows saves a plain CSV (these characters are one byte each, as in Latin-1). */
const windows1252 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))

describe('decodeCsvBytes', () => {
  it('reads UTF-8, with or without a byte order mark (which it drops)', () => {
    expect(decodeCsvBytes(utf8(CSV))).toBe(CSV)
    expect(decodeCsvBytes(Uint8Array.of(0xef, 0xbb, 0xbf, ...utf8(CSV)))).toBe(CSV)
  })

  it('reads UTF-16 by its byte order mark, either way round', () => {
    expect(decodeCsvBytes(utf16(CSV, true))).toBe(CSV)
    expect(decodeCsvBytes(utf16(CSV, false))).toBe(CSV)
  })

  it("reads a file that isn't UTF-8 as Windows-1252, as Excel on Windows saves it", () => {
    expect(decodeCsvBytes(windows1252(CSV))).toBe(CSV)
  })

  // Browsers decode these as Windows-1252 has them; Node 22's TextDecoder reads that encoding as Latin-1.
  it.skipIf(new TextDecoder('windows-1252').decode(Uint8Array.of(0x93)) !== '“')(
    "reads Windows-1252's own characters, in 0x80-0x9F: curly quotes, the dash",
    () => {
      expect(decodeCsvBytes(Uint8Array.of(0x93, 0x41, 0x94, 0x2c, 0x96))).toBe('“A”,–')
    },
  )

  it('reads an empty file as empty', () => {
    expect(decodeCsvBytes(new Uint8Array())).toBe('')
  })
})
