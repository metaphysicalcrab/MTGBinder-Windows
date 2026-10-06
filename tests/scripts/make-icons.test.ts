import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  appIcon,
  Canvas,
  encodeIco,
  encodePng,
  maskableIcon,
  pngScanlines,
  touchIcon,
  trayIcon,
  WEB_ICONS_DIR,
  webIcons,
} from '../../scripts/make-icons.ts'

/** A PNG's chunks: type, data, and whether the CRC it carries is right. */
function chunks(png: Buffer) {
  const found: Array<{ type: string; data: Buffer; crcOk: boolean }> = []
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + length)
    const crcOk = png.readUInt32BE(at + 8 + length) === zlib.crc32(png.subarray(at + 4, at + 8 + length))
    found.push({ type, data, crcOk })
    at += 12 + length
  }
  return found
}

const encoded = new WeakMap<Canvas, Uint8Array>()
/** The pixel at (x, y), as 8-bit RGBA. */
function pixel(image: Canvas, x: number, y: number): number[] {
  if (!encoded.has(image)) encoded.set(image, image.rgba())
  const at = (y * image.size + x) * 4
  return [...encoded.get(image)!.subarray(at, at + 4)]
}

describe('the PNG encoder', () => {
  it('writes the signature, then IHDR, IDAT and IEND, each with its CRC', () => {
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => i * 10)
    const png = encodePng(rgba, 3, 2)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const found = chunks(png)
    expect(found.map((c) => [c.type, c.crcOk])).toEqual([['IHDR', true], ['IDAT', true], ['IEND', true]])
    const ihdr = found[0]!.data
    // 3 × 2, 8 bits a channel, RGBA, deflate, adaptive filtering, not interlaced.
    expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ...ihdr.subarray(8)]).toEqual([3, 2, 8, 6, 0, 0, 0])
    // Each row is its filter byte (none) and its pixels.
    const rows = zlib.inflateSync(found[1]!.data)
    expect([...rows]).toEqual([0, ...rgba.subarray(0, 12), 0, ...rgba.subarray(12)])
    expect(pngScanlines(png)).toEqual(rows)
    expect(pngScanlines(Buffer.from('not a png'))).toBeNull()
  })
})

describe('the ICO encoder', () => {
  const ico = encodeIco([16, 32, 256].map(appIcon))
  const entry = (i: number) => {
    const at = 6 + 16 * i
    return {
      width: ico.readUInt8(at),
      height: ico.readUInt8(at + 1),
      planes: ico.readUInt16LE(at + 4),
      bits: ico.readUInt16LE(at + 6),
      length: ico.readUInt32LE(at + 8),
      offset: ico.readUInt32LE(at + 12),
    }
  }

  it('lists each image in its directory, where its bytes are, in order and to the end of the file', () => {
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3])
    const entries = [0, 1, 2].map(entry)
    // 256 is written as 0.
    expect(entries.map((e) => [e.width, e.height, e.planes, e.bits])).toEqual([[16, 16, 1, 32], [32, 32, 1, 32], [0, 0, 1, 32]])
    expect(entries[0]!.offset).toBe(6 + 16 * 3)
    expect(entries[1]!.offset).toBe(entries[0]!.offset + entries[0]!.length)
    expect(entries[2]!.offset + entries[2]!.length).toBe(ico.length)
  })

  it('stores the small sizes as bitmaps, bottom row first in BGRA, with a mask; the largest as a PNG', () => {
    const { offset, length } = entry(0)
    const dib = ico.subarray(offset, offset + length)
    // The header: its size, 16 wide, 32 tall (the colors and the mask), one plane, 32 bits, not compressed.
    expect([dib.readUInt32LE(0), dib.readInt32LE(4), dib.readInt32LE(8), dib.readUInt16LE(12), dib.readUInt16LE(14), dib.readUInt32LE(16)]).toEqual([
      40, 16, 32, 1, 32, 0,
    ])
    expect(length).toBe(40 + 16 * 16 * 4 + 4 * 16) // each mask row padded to 4 bytes
    const image = appIcon(16)
    const top = 2 // a row through the tile, not the page
    const bgra = dib.subarray(40 + ((15 - top) * 16 + 8) * 4, 40 + ((15 - top) * 16 + 8) * 4 + 4)
    const [r, g, b, a] = pixel(image, 8, top)
    expect([...bgra]).toEqual([b, g, r, a])
    // The mask marks the see-through corner (its first row is the bottom one, with that corner), not the tile.
    const mask = dib.subarray(40 + 16 * 16 * 4)
    expect(mask[0]! & 0x80).toBe(0x80)
    expect(mask[(15 - top) * 4 + 1]! & 0x80).toBe(0)
    const png = ico.subarray(entry(2).offset, entry(2).offset + entry(2).length)
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
  })
})

describe('the icons', () => {
  it('draws the binder page: the middle pocket lit amber, on the stone tile, with clear corners', () => {
    const icon = appIcon(1024)
    expect(pixel(icon, 0, 0)).toEqual([0, 0, 0, 0])
    expect(pixel(icon, 512, 512)).toEqual([0xfb, 0xbf, 0x24, 255])
    // The tile fills about 94% of the square: its top edge, in the middle, is stone, just above it is clear.
    expect(pixel(icon, 512, 31)[3]).toBe(255)
    expect(pixel(icon, 512, 29)[3]).toBe(0)
    // Lighter at the top than at the bottom.
    const [top, bottom] = [pixel(icon, 512, 40), pixel(icon, 512, 990)]
    expect(top[0]!).toBeGreaterThan(bottom[0]!)
  })

  it('puts the smallest icons on whole pixels, so their pockets stay apart', () => {
    for (const size of [16, 20, 24]) {
      const icon = appIcon(size)
      const amber = icon.rgba().filter((_, i) => i % 4 === 0).filter((r) => r === 0xfb).length
      // The lit pocket only, in solid amber, at least 2 × 3 pixels; every other pixel is something else.
      expect([size, amber >= 6]).toEqual([size, true])
      expect(pixel(icon, 0, 0)[3]).toBe(0) // rounded corners
    }
  })

  it('fills the maskable icon to its edges, keeping the page in the middle 80%', () => {
    const icon = maskableIcon(512)
    expect(pixel(icon, 0, 0)).toEqual([0x0c, 0x0a, 0x09, 255])
    expect(pixel(icon, 256, 256)).toEqual([0xfb, 0xbf, 0x24, 255])
    // Nothing but the stone outside the safe circle (radius 0.4 of the square).
    for (let y = 0; y < 512; y += 4) {
      for (let x = 0; x < 512; x += 4) {
        if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 0.4 * 512) expect(pixel(icon, x, y)).toEqual([0x0c, 0x0a, 0x09, 255])
      }
    }
  })

  it('makes the touch icon opaque, and the tray icon amber on a page that outlines it', () => {
    const touch = touchIcon(180).rgba()
    expect(touch.filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(true)
    const tray = trayIcon(16)
    expect(pixel(tray, 8, 8)).toEqual([0xfb, 0xbf, 0x24, 255])
    expect(pixel(tray, 4, 0)).toEqual([0x29, 0x25, 0x24, 255])
  })

  it('draws the same pixels every time, which are the committed web app icons', () => {
    expect(encodePng(appIcon(64).rgba(), 64)).toEqual(encodePng(appIcon(64).rgba(), 64))
    for (const [name, image] of Object.entries(webIcons())) {
      const committed = pngScanlines(fs.readFileSync(path.join(WEB_ICONS_DIR, name)))
      // Out of date: run pnpm icons, and commit src/web/public/icons.
      expect([name, committed?.equals(pngScanlines(encodePng(image.rgba(), image.size))!)]).toEqual([name, true])
    }
  })
})
