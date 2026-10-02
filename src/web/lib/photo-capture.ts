import { CARD_ASPECT, captureRect, guideRect, type Rect } from './capture.ts'

/*
 * A photo from the phone's camera app (M13), for scanning where the browser has no live camera (a phone on plain HTTP),
 * made into the same kind of capture the live camera sends (spec §5.1.1). The photo is the whole table at 12 to 50
 * megapixels, often stored on its side with an EXIF orientation; sent as it is, it would be over the size limit, read
 * sideways, and full of text that isn't the card's. So the phone opens it upright, the owner fits the card guide over
 * the card, and the capture is the guide plus captureRect's margin (the one the matcher's bands were tuned on), shrunk
 * so the card is at most MAX_CARD_HEIGHT tall, as a JPEG.
 */

/** The tallest a card is in a photo's capture: as sharp as OCR needs, and a capture of a few hundred kB. */
export const MAX_CARD_HEIGHT = 2000
/** The capture's JPEG quality. */
export const PHOTO_QUALITY = 0.9

/** What a photo's capture keeps of it (`source`), and the capture's size: never larger than the photo. */
export function photoCrop(guide: Rect, photoWidth: number, photoHeight: number): { source: Rect; width: number; height: number } {
  const source = captureRect(guide, photoWidth, photoHeight)
  const scale = Math.min(1, MAX_CARD_HEIGHT / guide.height)
  return {
    source,
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  }
}

/** The tallest guide a photo holds: as tall as the photo, or as wide (a card is taller than it is wide). */
export function largestGuideHeight(photoWidth: number, photoHeight: number): number {
  return Math.min(photoHeight, photoWidth / CARD_ASPECT)
}

/** The smallest guide, as a share of the largest: a card that small in the photo is too small to read anyway. */
export const MIN_GUIDE_SHARE = 0.2

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * The guide `guideHeight` tall, card-shaped, centered on (centerX, centerY) as near as it can be while inside the
 * photo, and no smaller than MIN_GUIDE_SHARE of the largest.
 */
export function guideAt(centerX: number, centerY: number, guideHeight: number, photoWidth: number, photoHeight: number): Rect {
  const largest = largestGuideHeight(photoWidth, photoHeight)
  const height = clamp(guideHeight, largest * MIN_GUIDE_SHARE, largest)
  const width = height * CARD_ASPECT
  return {
    x: clamp(centerX - width / 2, 0, photoWidth - width),
    y: clamp(centerY - height / 2, 0, photoHeight - height),
    width,
    height,
  }
}

const centerOf = (guide: Rect) => ({ x: guide.x + guide.width / 2, y: guide.y + guide.height / 2 })

/** The guide moved by (dx, dy), in the photo's pixels. */
export function moveGuide(guide: Rect, dx: number, dy: number, photoWidth: number, photoHeight: number): Rect {
  const center = centerOf(guide)
  return guideAt(center.x + dx, center.y + dy, guide.height, photoWidth, photoHeight)
}

/** The guide made `guideHeight` tall, about its center. */
export function resizeGuide(guide: Rect, guideHeight: number, photoWidth: number, photoHeight: number): Rect {
  const center = centerOf(guide)
  return guideAt(center.x, center.y, guideHeight, photoWidth, photoHeight)
}

export interface Point {
  x: number
  y: number
}

/**
 * The guide as fingers moved it from `start`: one finger drags it; two drag it by their midpoint and size it by how
 * far apart they moved (a pinch). `from` and `to` are the fingers on the screen, where the photo is shown `scale` times
 * its size.
 */
export function gestureGuide(
  start: Rect,
  from: readonly Point[],
  to: readonly Point[],
  scale: number,
  photoWidth: number,
  photoHeight: number,
): Rect {
  const center = centerOf(start)
  if (from.length >= 2 && to.length >= 2) {
    const [a, b] = from as [Point, Point]
    const [c, d] = to as [Point, Point]
    const apart = Math.hypot(b.x - a.x, b.y - a.y)
    const grown = apart > 0 ? Math.hypot(d.x - c.x, d.y - c.y) / apart : 1
    const dx = ((c.x + d.x) / 2 - (a.x + b.x) / 2) / scale
    const dy = ((c.y + d.y) / 2 - (a.y + b.y) / 2) / scale
    return guideAt(center.x + dx, center.y + dy, start.height * grown, photoWidth, photoHeight)
  }
  if (from.length === 0 || to.length === 0) return start
  const dx = (to[0]!.x - from[0]!.x) / scale
  const dy = (to[0]!.y - from[0]!.y) / scale
  return guideAt(center.x + dx, center.y + dy, start.height, photoWidth, photoHeight)
}

/**
 * Where the guide was on the last photo, relative to it (its center and height as shares of the photo's), so the next
 * photo of a stack, taken the same way, starts with the guide already there.
 */
export interface RelativeGuide {
  x: number
  y: number
  height: number
  landscape: boolean
}

export function relativeGuide(guide: Rect, photoWidth: number, photoHeight: number): RelativeGuide {
  const center = centerOf(guide)
  return { x: center.x / photoWidth, y: center.y / photoHeight, height: guide.height / photoHeight, landscape: photoWidth > photoHeight }
}

/** The guide a photo starts with: where it was on the last photo held the same way, else the live view's (guideRect). */
export function startingGuide(photoWidth: number, photoHeight: number, last: RelativeGuide | null): Rect {
  if (!last || last.landscape !== photoWidth > photoHeight) return guideRect(photoWidth, photoHeight)
  return guideAt(last.x * photoWidth, last.y * photoHeight, last.height * photoHeight, photoWidth, photoHeight)
}

/** A photo that can't be used, with what to do about it, said as the Scan page shows it. */
export class PhotoError extends Error {}

/** Said when the browser can't read the photo at all: an HEIC photo in Chrome, say. */
export const UNREADABLE_PHOTO = "This photo can't be read here: set the camera to JPEG (Most compatible), or take it again."
/** Said when a photo is too large to open even at half size. */
export const PHOTO_TOO_LARGE = "This photo is too large to open on this device: set the camera to a lower resolution, or take it again."

/** A photo opened upright; `halved` when it was too large to open whole, and was opened at half its width. */
export interface OpenedPhoto<Bitmap = ImageBitmap> {
  bitmap: Bitmap
  halved: boolean
}

type Open<Bitmap> = (photo: Blob, options: ImageBitmapOptions) => Promise<Bitmap>

/** A photo's width as the browser shows it (upright), from an image element, which reads it without opening it whole. */
function shownWidth(photo: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(photo)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img.naturalWidth)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Can't read the photo"))
    }
    img.src = url
  })
}

/**
 * Opens a photo upright, its EXIF orientation applied. One too large to open whole (50 megapixels, on a phone short of
 * memory) is opened at half its width; one the browser can't read (HEIC in Chrome) is a PhotoError saying what to do.
 * `open` and `measure` stand in for createImageBitmap and the image element in tests.
 */
export async function openPhoto<Bitmap = ImageBitmap>(
  photo: Blob,
  open: Open<Bitmap> = (blob, options) => createImageBitmap(blob, options) as Promise<Bitmap>,
  measure: (photo: Blob) => Promise<number> = shownWidth,
): Promise<OpenedPhoto<Bitmap>> {
  try {
    return { bitmap: await open(photo, { imageOrientation: 'from-image' }), halved: false }
  } catch {
    // A photo the browser can show has a width; one it can't read at all doesn't.
    const width = await measure(photo).catch(() => 0)
    if (!(width > 1)) throw new PhotoError(UNREADABLE_PHOTO)
    try {
      const bitmap = await open(photo, { imageOrientation: 'from-image', resizeWidth: Math.round(width / 2), resizeQuality: 'high' })
      return { bitmap, halved: true }
    } catch {
      throw new PhotoError(PHOTO_TOO_LARGE)
    }
  }
}

/**
 * A photo's capture: what `guide` (in the photo's pixels; the live view's guide when there's none) frames, with the
 * margin, as a JPEG at most MAX_CARD_HEIGHT tall for the card (photoCrop). A photo given as a file is opened with
 * openPhoto, and let go of afterwards; a bitmap given is left open.
 */
export async function photoToCapture(photo: Blob | ImageBitmap, guide?: Rect): Promise<Blob> {
  const bitmap = photo instanceof Blob ? (await openPhoto(photo)).bitmap : photo
  try {
    const { source, width, height } = photoCrop(guide ?? guideRect(bitmap.width, bitmap.height), bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new PhotoError("Couldn't make a capture from this photo: the browser has no canvas to draw it on.")
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (jpeg) => (jpeg ? resolve(jpeg) : reject(new PhotoError("Couldn't make a capture from this photo."))),
        'image/jpeg',
        PHOTO_QUALITY,
      ),
    )
  } finally {
    if (photo instanceof Blob) bitmap.close()
  }
}
