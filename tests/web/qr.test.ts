import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QrCode } from '../../src/web/components/QrCode.tsx'
import { qrCode, qrPath, QUIET_ZONE } from '../../src/web/lib/qr.ts'

describe('qrPath', () => {
  it('draws each run of dark modules in a row as one rectangle, inside the quiet zone', () => {
    const matrix = [
      [true, true, false],
      [false, true, true],
      [true, false, true],
    ]
    expect(qrPath(matrix, 4)).toEqual({
      path: 'M4 4h2v1h-2zM5 5h2v1h-2zM4 6h1v1h-1zM6 6h1v1h-1z',
      size: 11,
    })
    expect(qrPath([[false]], 1)).toEqual({ path: '', size: 3 })
  })
})

describe('qrCode', () => {
  it("encodes a pairing link with the standard's four-module quiet zone, its finder patterns in three corners", () => {
    const url = 'http://192.168.1.5:4322/pair#k=Qm9vbGVhbiBrZXkgaGVyZQ'
    const { path, size } = qrCode(url)
    expect(QUIET_ZONE).toBe(4)
    // Version 4 (33 modules) for a link this long with medium error correction, and the quiet zone on each side.
    expect(size).toBe(33 + 2 * 4)
    const finderTop = (x: number) => `M${x} 4h7v1h-7z`
    expect(path).toContain(finderTop(4))
    expect(path).toContain(finderTop(size - 4 - 7))
    expect(path).toContain(`M4 ${size - 4 - 7}h7v1h-7z`)
    // Nothing is drawn in the quiet zone.
    for (const [, x, y] of path.matchAll(/M(\d+) (\d+)/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(4)
      expect(Number(y)).toBeGreaterThanOrEqual(4)
      expect(Number(y)).toBeLessThan(size - 4)
    }
  })
})

describe('QrCode', () => {
  it('is an image named by what it holds, black on white, a whole number of pixels to a module', () => {
    const html = renderToStaticMarkup(createElement(QrCode, { text: 'http://192.168.1.5:4322', size: 200 }))
    expect(html).toMatch(/^<svg role="img" aria-label="QR code for http:\/\/192\.168\.1\.5:4322"/)
    const size = qrCode('http://192.168.1.5:4322').size
    const pixels = Math.round(200 / size) * size
    expect(html).toContain(`viewBox="0 0 ${size} ${size}" width="${pixels}" height="${pixels}"`)
    expect(html).toContain('fill="#fff"')
    expect(html).toContain('fill="#000"')
  })
})
