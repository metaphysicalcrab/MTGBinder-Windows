// Draws Binder's icons on any computer, with nothing to install: the binder page of make-icons.swift (3 × 3 card
// pockets, the middle one lit amber, on a stone tile), drawn and encoded here. Into <out-dir> (pnpm icons:
// build/icons): icon.png (1024 px, filling the square as Windows' icons do, without the Mac's margin and shadow),
// Binder.ico (the app's icon on Windows), tray.ico (its notification-area icon), and tray.png and tray@2x.png (for
// Linux). Always also the web app's icons, into src/web/public/icons/, which are committed. On a Mac,
// make-icons.swift runs first, for Binder.icns and the menu-bar icons.
// usage: node scripts/make-icons.ts [out-dir]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

/** Red, green, blue and alpha, from 0 to 1 (not premultiplied). */
export type Color = readonly [number, number, number, number]

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const hex = (value: number, alpha = 1): Color => [
  ((value >> 16) & 0xff) / 255,
  ((value >> 8) & 0xff) / 255,
  (value & 0xff) / 255,
  alpha,
]

/** Binder's stone and amber (Tailwind's stone-800 to stone-950, stone-700, amber-400, amber-700). */
const STONE_TOP = hex(0x292524)
const STONE_BOTTOM = hex(0x0c0a09)
const PAGE = hex(0x44403c)
const LIT = hex(0xfbbf24)
/** One card lit amber (the middle); the rest in deep amber, like a sleeved collection (make-icons.swift). */
const pocketColor = (i: number): Color => (i === 4 ? LIT : hex(0xb45309, i % 2 === 0 ? 0.95 : 0.75))
/** The tray's: opaque, on a darker page, so the glyph reads on a light taskbar and its amber on a dark one. */
const TRAY_PAGE = STONE_TOP
const trayPocketColor = (i: number): Color => (i === 4 ? LIT : hex(i % 2 === 0 ? 0xd97706 : 0xb45309))

/**
 * The Mac icon's design, in its own units: an 824 tile with corners of 185; the page 480 × 640 with corners of 36;
 * pockets 22 apart, with corners of 14.
 */
const TILE = 824
const TILE_RADIUS = 185 / TILE
const PAGE_HEIGHT = 640 / TILE
/** A card's width for its height, as the page's pockets are. */
const POCKET_SHAPE = 63 / 88

/** How much of the square Windows' icons fill: no margin for a Dock shadow, as the Mac's has. */
const WINDOWS_FILL = 0.94

const mix = (a: Color, b: Color, t: number): Color => {
  const u = Math.min(1, Math.max(0, t))
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u]
}

/** A square picture, painted shape by shape: premultiplied color, in floating point until it's encoded. */
export class Canvas {
  readonly size: number
  readonly data: Float64Array

  constructor(size: number) {
    this.size = size
    this.data = new Float64Array(size * size * 4)
  }

  /**
   * Paints a rounded rectangle, anti-aliased: each pixel by how much of it the shape covers, from the distance of its
   * center to the shape's edge. Edges on whole pixels come out crisp. `paint` is a color, or one per pixel row (from
   * the row's middle, y + 0.5), for a vertical gradient.
   */
  fill(rect: Rect, radius: number, paint: Color | ((y: number) => Color)): void {
    const r = Math.min(radius, rect.w / 2, rect.h / 2)
    const [cx, cy] = [rect.x + rect.w / 2, rect.y + rect.h / 2]
    const [hx, hy] = [rect.w / 2 - r, rect.h / 2 - r]
    const x0 = Math.max(0, Math.floor(rect.x - 1))
    const x1 = Math.min(this.size, Math.ceil(rect.x + rect.w + 1))
    const y0 = Math.max(0, Math.floor(rect.y - 1))
    const y1 = Math.min(this.size, Math.ceil(rect.y + rect.h + 1))
    for (let y = y0; y < y1; y++) {
      const color = typeof paint === 'function' ? paint(y + 0.5) : paint
      for (let x = x0; x < x1; x++) {
        const qx = Math.abs(x + 0.5 - cx) - hx
        const qy = Math.abs(y + 0.5 - cy) - hy
        const [ox, oy] = [Math.max(qx, 0), Math.max(qy, 0)]
        const distance = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r
        const coverage = Math.min(1, Math.max(0, 0.5 - distance))
        if (coverage > 0) this.blend(x, y, color, coverage)
      }
    }
  }

  /** Lays `color` over the pixel, `coverage` of it. */
  private blend(x: number, y: number, color: Color, coverage: number): void {
    const i = (y * this.size + x) * 4
    const alpha = color[3] * coverage
    const keep = 1 - alpha
    for (let c = 0; c < 3; c++) this.data[i + c] = color[c]! * alpha + this.data[i + c]! * keep
    this.data[i + 3] = alpha + this.data[i + 3]! * keep
  }

  /** The picture as 8-bit RGBA, row by row from the top, not premultiplied (what PNG and ICO hold). */
  rgba(): Uint8Array {
    const out = new Uint8Array(this.size * this.size * 4)
    for (let i = 0; i < out.length; i += 4) {
      const alpha = this.data[i + 3]!
      const a = Math.round(alpha * 255)
      if (a === 0) continue
      for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.round((this.data[i + c]! / alpha) * 255))
      out[i + 3] = a
    }
    return out
  }
}

/** The page's 3 × 3 pockets inside `page`, `gap` apart and from its edges (make-icons.swift's pockets()). */
function pockets(page: Rect, gap: number): Rect[] {
  const w = (page.w - gap * 4) / 3
  const h = (page.h - gap * 4) / 3
  return Array.from({ length: 9 }, (_, i) => ({
    x: page.x + gap + (i % 3) * (w + gap),
    y: page.y + gap + Math.floor(i / 3) * (h + gap),
    w,
    h,
  }))
}

/** The page with its pockets, `height` tall and centered on (cx, cy), in the Mac icon's proportions. */
function drawPage(canvas: Canvas, cx: number, cy: number, height: number): void {
  const unit = height / 640
  const page = { x: cx - 240 * unit, y: cy - 320 * unit, w: 480 * unit, h: 640 * unit }
  canvas.fill(page, 36 * unit, PAGE)
  pockets(page, 22 * unit).forEach((pocket, i) => canvas.fill(pocket, 14 * unit, pocketColor(i)))
}

/** A vertical gradient down `rect`, the stone's: lighter at the top. */
const stone = (rect: Rect) => (y: number) => mix(STONE_TOP, STONE_BOTTOM, (y - rect.y) / rect.h)

/**
 * A page whose pockets fall on whole pixels, `gap` apart, for the smallest sizes, where anti-aliased edges would blur
 * nine pockets into a smudge: pockets `pocketHeight` tall and card-shaped, the page centered in the square.
 */
function snappedPage(size: number, pocketHeight: number, gap: number): Rect {
  const pocketWidth = Math.max(1, Math.round(pocketHeight * POCKET_SHAPE))
  const [w, h] = [pocketWidth * 3 + gap * 4, pocketHeight * 3 + gap * 4]
  return { x: Math.floor((size - w) / 2), y: Math.floor((size - h) / 2), w, h }
}

/**
 * The app's icon at `size` pixels: the stone tile filling 94% of the square, as Windows' icons do. At 24 pixels and
 * below the tile fills it all, and the pockets are drawn on whole pixels.
 */
export function appIcon(size: number): Canvas {
  const canvas = new Canvas(size)
  if (size <= 24) {
    const square = { x: 0, y: 0, w: size, h: size }
    canvas.fill(square, Math.round(size * 0.2), stone(square))
    const gap = 1
    const page = snappedPage(size, Math.round((size * PAGE_HEIGHT - gap * 4) / 3), gap)
    canvas.fill(page, 1, PAGE)
    pockets(page, gap).forEach((pocket, i) => canvas.fill(pocket, 0, pocketColor(i)))
    return canvas
  }
  const margin = Math.round((size * (1 - WINDOWS_FILL)) / 2)
  const tile = { x: margin, y: margin, w: size - margin * 2, h: size - margin * 2 }
  canvas.fill(tile, tile.w * TILE_RADIUS, stone(tile))
  drawPage(canvas, size / 2, size / 2, tile.h * PAGE_HEIGHT)
  return canvas
}

/**
 * The notification-area (tray) icon at `size` pixels: the page alone, as tall as the square allows, its pockets on
 * whole pixels. The dark page outlines it on a light taskbar; the amber pockets carry it on a dark one.
 */
export function trayIcon(size: number): Canvas {
  const canvas = new Canvas(size)
  const gap = Math.max(1, Math.floor(size / 16))
  const page = snappedPage(size, Math.floor((size - gap * 4) / 3), gap)
  canvas.fill(page, gap, TRAY_PAGE)
  pockets(page, gap).forEach((pocket, i) => canvas.fill(pocket, 0, trayPocketColor(i)))
  return canvas
}

/**
 * The web app's maskable icon: Android cuts it to its own shape (a circle, a squircle), so the stone fills the whole
 * square and the page stays inside the middle 80%, the part every shape keeps.
 */
export function maskableIcon(size: number): Canvas {
  const canvas = new Canvas(size)
  canvas.fill({ x: 0, y: 0, w: size, h: size }, 0, STONE_BOTTOM)
  // The page's corners are 0.375 of the square from its middle: inside the safe zone's 0.4.
  drawPage(canvas, size / 2, size / 2, size * 0.6)
  return canvas
}

/** The icon iOS and iPadOS put on the home screen: opaque, with the stone to every edge (they round the corners). */
export function touchIcon(size: number): Canvas {
  const canvas = new Canvas(size)
  const square = { x: 0, y: 0, w: size, h: size }
  canvas.fill(square, 0, stone(square))
  drawPage(canvas, size / 2, size / 2, size * PAGE_HEIGHT)
  return canvas
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Each row of `rgba` behind its filter byte (0, none), as PNG's image data holds it before compression. */
function scanlines(rgba: Uint8Array, width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }
  return rows
}

/** A PNG of 8-bit RGBA pixels (color type 6), rows from the top. */
export function encodePng(rgba: Uint8Array, width: number, height = width): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8) // bit depth, RGBA, deflate, adaptive filtering, not interlaced
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(scanlines(rgba, width, height), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A PNG's rows, filter bytes and all, from its image data; null for a file that isn't one encodePng could write. */
export function pngScanlines(png: Buffer): Buffer | null {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  const data: Buffer[] = []
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    if (type === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  try {
    return zlib.inflateSync(Buffer.concat(data))
  } catch {
    return null
  }
}

/**
 * A Windows icon file holding `images`, smallest first. Those up to 64 pixels are 32-bit bitmaps, which every part of
 * Windows reads, with the 1-bit mask older readers draw by; a larger one is a PNG (which Windows reads from Vista on).
 */
export function encodeIco(images: Canvas[]): Buffer {
  const entries = images.map((image) => (image.size > 64 ? encodePng(image.rgba(), image.size) : bitmap(image)))
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // an icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((image, i) => {
    const at = 6 + 16 * i
    header.writeUInt8(image.size >= 256 ? 0 : image.size, at) // 0 stands for 256
    header.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1)
    header.writeUInt8(0, at + 2) // not a palette image
    header.writeUInt8(0, at + 3)
    header.writeUInt16LE(1, at + 4) // planes
    header.writeUInt16LE(32, at + 6) // bits per pixel
    header.writeUInt32LE(entries[i]!.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += entries[i]!.length
  })
  return Buffer.concat([header, ...entries])
}

/**
 * An icon's bitmap (a DIB): its header, giving twice the height for the color rows and the mask's, then the pixels in
 * blue, green, red, alpha from the bottom row up, then the mask, a bit a pixel (set where it's see-through), each row
 * padded to 4 bytes.
 */
function bitmap(image: Canvas): Buffer {
  const { size } = image
  const rgba = image.rgba()
  const maskRow = Math.ceil(size / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12) // planes
  header.writeUInt16LE(32, 14) // bits per pixel
  header.writeUInt32LE(0, 16) // not compressed
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20)
  const pixels = Buffer.alloc(size * size * 4)
  const mask = Buffer.alloc(maskRow * size)
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = (row * size + x) * 4
      pixels[to] = rgba[from + 2]!
      pixels[to + 1] = rgba[from + 1]!
      pixels[to + 2] = rgba[from]!
      pixels[to + 3] = rgba[from + 3]!
      if (rgba[from + 3]! < 128) mask[row * maskRow + (x >> 3)]! |= 0x80 >> (x & 7)
    }
  }
  return Buffer.concat([header, pixels, mask])
}

/**
 * Writes a PNG, unless the file there already holds these pixels: another computer's zlib may pack the same pixels
 * into other bytes, and the committed icons shouldn't change for that.
 */
function writePng(file: string, image: Canvas): void {
  const png = encodePng(image.rgba(), image.size)
  const existing = fs.existsSync(file) ? fs.readFileSync(file) : null
  if (existing && (existing.equals(png) || pngScanlines(existing)?.equals(scanlines(image.rgba(), image.size, image.size)))) return
  fs.writeFileSync(file, png)
}

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The web app's icons, which the manifest and index.html name. */
export const WEB_ICONS_DIR = path.join(ROOT_DIR, 'src', 'web', 'public', 'icons')

/** Every icon this script draws for the web app, by file name. */
export function webIcons(): Record<string, Canvas> {
  return {
    'icon-192.png': appIcon(192),
    'icon-512.png': appIcon(512),
    'maskable-512.png': maskableIcon(512),
    'apple-touch-icon.png': touchIcon(180),
    'favicon-32.png': appIcon(32),
  }
}

function main(out: string): void {
  fs.mkdirSync(out, { recursive: true })
  // The Mac's own: Binder.icns and the menu-bar icons (and its icon.png, which the one below replaces).
  if (process.platform === 'darwin') execFileSync('swift', ['scripts/make-icons.swift', out], { cwd: ROOT_DIR, stdio: 'inherit' })
  writePng(path.join(out, 'icon.png'), appIcon(1024))
  fs.writeFileSync(path.join(out, 'Binder.ico'), encodeIco([16, 20, 24, 32, 40, 48, 64, 256].map(appIcon)))
  // The sizes Windows asks for at 100% to 300% display scaling.
  fs.writeFileSync(path.join(out, 'tray.ico'), encodeIco([16, 20, 24, 32, 40, 48].map(trayIcon)))
  writePng(path.join(out, 'tray.png'), trayIcon(16))
  writePng(path.join(out, 'tray@2x.png'), trayIcon(32))
  fs.mkdirSync(WEB_ICONS_DIR, { recursive: true })
  for (const [name, image] of Object.entries(webIcons())) writePng(path.join(WEB_ICONS_DIR, name), image)
  console.log(`Drew the icons in ${out}, and the web app's in ${path.relative(ROOT_DIR, WEB_ICONS_DIR)}`)
}

/** Whether node was asked to run this file (rather than a test importing it): import.meta.main from Node 24.2 on. */
const run =
  import.meta.main ??
  (process.argv[1] !== undefined &&
    path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase())
if (run) main(path.resolve(process.argv[2] ?? path.join(ROOT_DIR, 'build', 'icons')))
