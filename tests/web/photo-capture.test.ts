import { describe, expect, it } from 'vitest'
import { CARD_ASPECT, captureRect, guideRect, type Rect } from '../../src/web/lib/capture.ts'
import {
  gestureGuide,
  guideAt,
  largestGuideHeight,
  MAX_CARD_HEIGHT,
  MIN_GUIDE_SHARE,
  moveGuide,
  openPhoto,
  PHOTO_TOO_LARGE,
  PhotoError,
  photoCrop,
  photoToSend,
  relativeGuide,
  resizeGuide,
  startingGuide,
  UNREADABLE_PHOTO,
} from '../../src/web/lib/photo-capture.ts'

const rounded = (r: Rect) => [r.x, r.y, r.width, r.height].map(Math.round)

describe('photoCrop', () => {
  it("keeps the guide and the live camera's margin, shrunk so the card is at most 2000 px tall", () => {
    // A 12-megapixel photo taken upright.
    const guide = guideRect(3000, 4000)
    const crop = photoCrop(guide, 3000, 4000)
    expect(crop.source).toEqual(captureRect(guide, 3000, 4000))
    expect(rounded(crop.source)).toEqual([138, 98, 2724, 3805])
    // The guide is 3280 px tall: shrunk by 2000 / 3280, with the margin, to 1661 × 2320.
    expect(guide.height).toBeCloseTo(3280)
    expect([crop.width, crop.height]).toEqual([1661, 2320])
    expect(crop.height).toBeLessThanOrEqual(Math.ceil(MAX_CARD_HEIGHT * 1.16))
  })

  it('never enlarges a photo whose card is already small', () => {
    const guide = { x: 100, y: 100, width: 630, height: 880 }
    const crop = photoCrop(guide, 1920, 1440)
    expect([crop.width, crop.height]).toEqual([Math.round(crop.source.width), Math.round(crop.source.height)])
  })

  it('keeps the crop inside the photo, for a guide at its edge', () => {
    const guide = guideAt(0, 0, 4000, 3000, 4000)
    const crop = photoCrop(guide, 3000, 4000)
    expect(crop.source.x).toBe(0)
    expect(crop.source.y).toBe(0)
    expect(crop.source.x + crop.source.width).toBeLessThanOrEqual(3000)
    expect(crop.source.y + crop.source.height).toBeLessThanOrEqual(4000)
  })
})

describe('fitting the guide', () => {
  const W = 3000
  const H = 4000

  it('stays card-shaped and inside the photo, however far it is moved', () => {
    const start = guideRect(W, H)
    for (const [dx, dy] of [
      [5000, 0],
      [-5000, 0],
      [0, 5000],
      [0, -5000],
      [123, -45],
    ] as const) {
      const g = moveGuide(start, dx, dy, W, H)
      expect(g.width / g.height).toBeCloseTo(CARD_ASPECT)
      expect(g.height).toBeCloseTo(start.height)
      expect(g.x).toBeGreaterThanOrEqual(0)
      expect(g.y).toBeGreaterThanOrEqual(0)
      expect(g.x + g.width).toBeLessThanOrEqual(W + 1e-9)
      expect(g.y + g.height).toBeLessThanOrEqual(H + 1e-9)
    }
    expect(rounded(moveGuide(start, 123, -45, W, H))).toEqual(rounded({ ...start, x: start.x + 123, y: start.y - 45 }))
  })

  it('sizes about its center, between a fifth of the largest and the largest the photo holds', () => {
    const start = guideAt(1500, 2000, 2000, W, H)
    const bigger = resizeGuide(start, 3000, W, H)
    expect(bigger.x + bigger.width / 2).toBeCloseTo(1500)
    expect(bigger.y + bigger.height / 2).toBeCloseTo(2000)
    expect(bigger.height).toBe(3000)
    expect(resizeGuide(start, 99999, W, H).height).toBe(largestGuideHeight(W, H))
    expect(resizeGuide(start, 1, W, H).height).toBeCloseTo(largestGuideHeight(W, H) * MIN_GUIDE_SHARE)
    // A landscape photo's largest guide is as tall as the photo.
    expect(largestGuideHeight(4000, 3000)).toBe(3000)
    expect(largestGuideHeight(1000, 4000)).toBeCloseTo(1000 / CARD_ASPECT)
  })

  it('follows one finger, and two in a pinch, on a photo shown at a quarter of its size', () => {
    const start = guideAt(1500, 2000, 2000, W, H)
    const dragged = gestureGuide(start, [{ x: 100, y: 100 }], [{ x: 110, y: 80 }], 0.25, W, H)
    expect(dragged.x - start.x).toBeCloseTo(40)
    expect(dragged.y - start.y).toBeCloseTo(-80)
    expect(dragged.height).toBe(start.height)

    // Fingers 100 px apart moved to 150 px apart, their midpoint 20 px right: half again as tall, 80 photo px right.
    const from = [
      { x: 100, y: 200 },
      { x: 200, y: 200 },
    ]
    const to = [
      { x: 95, y: 200 },
      { x: 245, y: 200 },
    ]
    const pinched = gestureGuide(start, from, to, 0.25, W, H)
    expect(pinched.height).toBeCloseTo(3000)
    expect(pinched.x + pinched.width / 2).toBeCloseTo(1580)
    expect(pinched.y + pinched.height / 2).toBeCloseTo(2000)
    expect(gestureGuide(start, [], [], 0.25, W, H)).toBe(start)
  })

  it('starts where the last photo held the same way had it, else where the live view has it', () => {
    const fitted = guideAt(900, 1500, 1800, W, H)
    const last = relativeGuide(fitted, W, H)
    // The next photo, at another resolution but upright too.
    const next = startingGuide(1500, 2000, last)
    expect(rounded(next)).toEqual(rounded({ x: 450 - (900 * CARD_ASPECT) / 2, y: 750 - 450, width: 900 * CARD_ASPECT, height: 900 }))
    expect(startingGuide(4000, 3000, last)).toEqual(guideRect(4000, 3000))
    expect(startingGuide(W, H, null)).toEqual(guideRect(W, H))
  })
})

describe('openPhoto', () => {
  const photo = new Blob(['jpeg'], { type: 'image/jpeg' })
  const bitmap = { width: 3000, height: 4000 }

  it('opens a photo upright, applying its EXIF orientation', async () => {
    const asked: ImageBitmapOptions[] = []
    const opened = await openPhoto(photo, async (_, options) => (asked.push(options), bitmap), async () => 3000)
    expect(opened).toEqual({ bitmap, halved: false })
    expect(asked).toEqual([{ imageOrientation: 'from-image' }])
  })

  it('opens a photo too large to open whole at half its width, and says so', async () => {
    const asked: ImageBitmapOptions[] = []
    const open = async (_: Blob, options: ImageBitmapOptions) => {
      asked.push(options)
      if (options.resizeWidth === undefined) throw new DOMException('Out of memory', 'InvalidStateError')
      return bitmap
    }
    expect(await openPhoto(photo, open, async () => 6120)).toEqual({ bitmap, halved: true })
    expect(asked[1]).toEqual({ imageOrientation: 'from-image', resizeWidth: 3060, resizeQuality: 'high' })
  })

  it("says what to do with a photo the browser can't read, such as HEIC in Chrome", async () => {
    const cannot = async () => {
      throw new DOMException('The source image could not be decoded.', 'InvalidStateError')
    }
    const unreadable = openPhoto(photo, cannot, async () => {
      throw new Error("Can't read the photo")
    })
    await expect(unreadable).rejects.toThrow(PhotoError)
    await expect(unreadable).rejects.toThrow(UNREADABLE_PHOTO)
    expect(UNREADABLE_PHOTO).toBe("This photo can't be read here: turn off HEIF (high efficiency) photos in the camera's settings, or take it again.")
    await expect(openPhoto(photo, cannot, async () => 8160)).rejects.toThrow(PHOTO_TOO_LARGE)
  })
})

describe('photoToSend', () => {
  const guide = guideAt(1500, 2000, 2000, 3000, 4000)
  const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' })
  // A bitmap that's 0 × 0 once let go of, as an ImageBitmap is.
  const photo = () => {
    const bitmap = { width: 3000, height: 4000, close: () => Object.assign(bitmap, { width: 0, height: 0 }) }
    return bitmap
  }

  it('sends the capture, and where the guide was for the next photo', async () => {
    const bitmap = photo()
    const made = await photoToSend(bitmap, guide, () => false, async (b, g) => (expect([b, g]).toEqual([bitmap, guide]), jpeg))
    expect(made).toEqual({ jpeg, last: relativeGuide(guide, 3000, 4000) })
  })

  it('sends nothing when the review was closed while the capture was being made', async () => {
    // Cancel while Sending…: the review closes, and lets go of the photo, before the JPEG is ready.
    let closed = false
    const bitmap = photo()
    const make = async () => {
      closed = true
      bitmap.close()
      return jpeg
    }
    expect(await photoToSend(bitmap, guide, () => closed, make)).toBeNull()
    const failing = async () => {
      closed = true
      throw new PhotoError("Couldn't make a capture from this photo.")
    }
    expect(await photoToSend(photo(), guide, () => closed, failing)).toBeNull()
  })

  it('keeps the guide by the size the photo had, even if it was let go of meanwhile', async () => {
    const bitmap = photo()
    const made = await photoToSend(bitmap, guide, () => false, async () => (bitmap.close(), jpeg))
    expect(made?.last).toEqual(relativeGuide(guide, 3000, 4000))
    expect(startingGuide(3000, 4000, made!.last)).toEqual(guide)
  })

  it('says why a capture failed while the review is open', async () => {
    const failing = async () => {
      throw new PhotoError("Couldn't make a capture from this photo.")
    }
    await expect(photoToSend(photo(), guide, () => false, failing)).rejects.toThrow(PhotoError)
  })
})
