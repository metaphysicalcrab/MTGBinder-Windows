import { describe, expect, it } from 'vitest'
import {
  cameraRank,
  cameraToUse,
  CARD_ASPECT,
  captureRect,
  boxAverage,
  createAutoCapture,
  frameChange,
  frameDifference,
  guideRect,
  BUILT_IN_CAMERA_RANK,
  preferredCamera,
  SAMPLE_MS,
  spaceCaptures,
  STABLE_MS,
} from '../../src/web/lib/capture.ts'

describe('guideRect and captureRect', () => {
  it('centers a card-shaped guide 82% of the frame tall', () => {
    const g = guideRect(1920, 1440)
    expect(g.height).toBeCloseTo(1440 * 0.82)
    expect(g.width / g.height).toBeCloseTo(CARD_ASPECT)
    expect(g.x + g.width / 2).toBeCloseTo(960)
    expect(g.y + g.height / 2).toBeCloseTo(720)
  })

  it('fits the guide in a portrait frame by width', () => {
    const g = guideRect(720, 1280)
    expect(g.width).toBeCloseTo(720 * 0.82)
    expect(g.width / g.height).toBeCloseTo(CARD_ASPECT)
  })

  it('captures the guide plus a margin, never outside the frame', () => {
    const r = captureRect({ x: 100, y: 100, width: 630, height: 880 }, 1920, 1080)
    // 8% of the guide's width and height on each side.
    expect([r.x, r.y, r.width, r.height].map(Math.round)).toEqual([50, 30, 731, 1021])
    const edge = captureRect({ x: 0, y: 0, width: 630, height: 1080 }, 630, 1080)
    expect(edge).toEqual({ x: 0, y: 0, width: 630, height: 1080 })
  })
})

describe('frameDifference', () => {
  const frame = (...rgb: number[]) => new Uint8ClampedArray(rgb.flatMap((v) => [v, v, v, 255]))
  it('is the mean absolute difference of red, green, and blue, ignoring alpha', () => {
    expect(frameDifference(frame(10, 20), frame(10, 20))).toBe(0)
    expect(frameDifference(frame(0, 0), frame(30, 10))).toBe(20)
    expect(frameDifference(new Uint8ClampedArray([0, 0, 0, 0]), new Uint8ClampedArray([0, 0, 0, 255]))).toBe(0)
  })
  it('treats frames of different sizes as entirely different', () => {
    expect(frameDifference(frame(1), frame(1, 2))).toBe(255)
  })
})

describe('spaceCaptures', () => {
  it('captures on the page and on controls Space would otherwise press or open', () => {
    expect(spaceCaptures(null)).toBe(true)
    for (const tagName of ['BODY', 'DIV', 'BUTTON', 'SELECT', 'A']) expect(spaceCaptures({ tagName })).toBe(true)
    for (const type of ['checkbox', 'radio', 'range', 'button', 'submit']) expect(spaceCaptures({ tagName: 'INPUT', type })).toBe(true)
  })
  it('leaves Space to text-entry fields, where it types a space', () => {
    expect(spaceCaptures({ tagName: 'INPUT' })).toBe(false)
    for (const type of ['text', 'search', 'password', 'email', 'url', 'number', 'tel']) {
      expect(spaceCaptures({ tagName: 'INPUT', type })).toBe(false)
    }
    expect(spaceCaptures({ tagName: 'TEXTAREA' })).toBe(false)
    expect(spaceCaptures({ tagName: 'DIV', isContentEditable: true })).toBe(false)
  })
  it('leaves Space alone inside a modal dialog, such as the card drawer over the Scan page', () => {
    const modal = (selector: string) => (selector === '[aria-modal="true"]' ? {} : null)
    for (const tagName of ['BUTTON', 'SELECT', 'DIV']) expect(spaceCaptures({ tagName, closest: modal })).toBe(false)
    expect(spaceCaptures({ tagName: 'INPUT', type: 'checkbox', closest: modal })).toBe(false)
    expect(spaceCaptures({ tagName: 'BUTTON', closest: () => null })).toBe(true)
  })
  it('leaves Space alone while a modal dialog is open, even when focus has fallen back to the page', () => {
    expect(spaceCaptures({ tagName: 'BODY' }, true)).toBe(false)
    expect(spaceCaptures(null, true)).toBe(false)
    expect(spaceCaptures({ tagName: 'BUTTON' }, true)).toBe(false)
    expect(spaceCaptures({ tagName: 'BODY' }, false)).toBe(true)
  })
})

describe('boxAverage and frameChange', () => {
  const px = (...values: number[]) => new Uint8ClampedArray(values.flatMap((v) => [v, v, v, 255]))
  it('averages blocks, so fine detail that shifts by one pixel (a camera wobble) barely registers', () => {
    const stripes = px(0, 200, 0, 200, 200, 0, 200, 0) // 4 × 2
    const shifted = px(200, 0, 200, 0, 0, 200, 0, 200)
    expect(frameDifference(stripes, shifted)).toBe(200)
    expect(boxAverage(stripes, 2, 1, 2)).toEqual(px(100, 100))
    expect(frameDifference(boxAverage(stripes, 2, 1, 2), boxAverage(shifted, 2, 1, 2))).toBe(0)
  })
  it('takes an overall brightness shift (the camera adjusting exposure) out of the difference', () => {
    expect(frameChange(px(10, 20), px(40, 50))).toBe(0)
    expect(frameChange(px(0, 0), px(30, 10))).toBe(10)
    expect(frameChange(px(1), px(1, 2))).toBe(255)
  })
})

describe('createAutoCapture (spec §5.1.1)', () => {
  const px = (...values: number[]) => new Uint8ClampedArray(values.flatMap((v) => [v, v, v, 255]))
  const mat = (noise = 0) => px(100 + noise, 100 - noise, 100 + noise, 100 - noise)
  const card = () => px(220, 30, 220, 30)
  const hand = () => px(10, 250, 10, 250)
  /** Holds a picture for `ms`, one sample every SAMPLE_MS. */
  const hold = (picture: () => Uint8ClampedArray, ms: number) => Array.from({ length: Math.ceil(ms / SAMPLE_MS) }, picture)
  /** Feeds one sample every SAMPLE_MS and returns what it captured: [time, lifted] pairs, and the last status. */
  const run = (frames: Uint8ClampedArray[], auto = createAutoCapture()) => {
    const captures: Array<[number, boolean]> = []
    let status = ''
    frames.forEach((f, i) => {
      const step = auto.sample(f, i * SAMPLE_MS)
      if (step.capture) captures.push([i * SAMPLE_MS, step.lifted])
      status = step.status
    })
    return { captures, status }
  }

  it('learns the empty mat and never captures it, however the picture flickers or changes exposure', () => {
    const flicker = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? mat(3) : mat(-3)))
    const exposure = [...hold(() => px(130, 130, 130, 130), 1000), ...hold(() => px(90, 90, 90, 90), 1000)]
    expect(run([...hold(mat, 300)]).status).toBe('learning')
    expect(run([...hold(mat, 1000), ...flicker, ...exposure, hand(), ...hold(mat, 2000)])).toEqual({ captures: [], status: 'ready' })
  })

  it(`captures a card once it has held still for ${STABLE_MS} ms, saying the mat was seen empty before it`, () => {
    const frames = [...hold(mat, 1050), ...hold(card, 3000)] // the card arrives at 1050 ms, still from 1200 ms
    expect(run(frames)).toEqual({ captures: [[1200 + STABLE_MS, true]], status: 'captured' })
  })

  it('captures a card once, not again while it lies there or after a hand passes over it', () => {
    const frames = [...hold(mat, 1050), ...hold(card, 2000), hand(), hand(), ...hold(card, 2000)]
    expect(run(frames).captures).toHaveLength(1)
  })

  it('captures the same card again after the empty mat was seen (another copy), and a moved card without it', () => {
    const moved = () => px(30, 220, 30, 220)
    const frames = [...hold(mat, 1050), ...hold(card, 2000), ...hold(mat, 1500), ...hold(card, 2000), ...hold(moved, 2000)]
    expect(run(frames).captures.map(([, lifted]) => lifted)).toEqual([true, true, false])
  })

  it('starts the wait over when the card moves before it settles', () => {
    const nudged = () => px(240, 10, 220, 30) // 10 from the card: more than holding still allows
    const frames = [...hold(mat, 1050), card(), card(), card(), nudged(), ...hold(nudged, 2000)]
    // Still from 1200 ms, nudged at 1500 ms, still again from 1650 ms: captured at 1650 + STABLE_MS.
    expect(run(frames).captures).toEqual([[1650 + STABLE_MS, true]])
  })

  it('takes a capture by hand for the card showing, so it doesn\'t capture that card again', () => {
    const auto = createAutoCapture()
    run([...hold(mat, 1050), card(), card()], auto)
    auto.captured()
    expect(run(hold(card, 2000), auto).captures).toEqual([])
  })
})

describe('choosing a camera', () => {
  const camera = (label: string) => ({ deviceId: label.toLowerCase().replaceAll(' ', '-'), label })
  const mac = camera('FaceTime HD Camera')
  const deskView = camera("Kason's iPhone Desk View Camera")
  const renamed = camera("Kason's Phone Camera")
  const iphone = camera("Kason's iPhone Camera")

  it('prefers an iPhone, then any camera that is not the Mac\'s own, then the Mac\'s, then Desk View and virtual ones', () => {
    expect(preferredCamera([mac, deskView, renamed, iphone], null)).toBe(iphone)
    expect(preferredCamera([mac, deskView, renamed], null)).toBe(renamed)
    expect(preferredCamera([deskView, mac], null)).toBe(mac)
    expect(preferredCamera([camera('OBS Virtual Camera'), deskView], null)?.label).toBe('OBS Virtual Camera')
    expect(preferredCamera([], null)).toBeNull()
    for (const label of ['MacBook Pro Camera', 'FaceTime HD Camera (Built-in)', 'Studio Display Camera']) {
      expect([label, cameraRank(label)]).toEqual([label, BUILT_IN_CAMERA_RANK])
    }
  })

  it('prefers a webcam or document camera over a Windows laptop\'s own, which faces the owner', () => {
    const laptop = camera('Integrated Webcam')
    const usb = camera('Logitech BRIO')
    const docCam = camera('IPEVO V4K')
    expect(preferredCamera([laptop, usb], null)).toBe(usb)
    expect(preferredCamera([laptop, usb, docCam], null)).toBe(docCam)
    expect(preferredCamera([camera('OBS Virtual Camera'), laptop], null)).toBe(laptop)
    for (const label of ['Integrated Camera', 'Integrated Webcam', 'HD User Facing', 'HP TrueVision HD Camera', 'Microsoft Camera Front']) {
      expect([label, cameraRank(label)]).toEqual([label, BUILT_IN_CAMERA_RANK])
    }
    // A Surface's back camera, held over the mat, is the one to scan with.
    expect(preferredCamera([camera('Microsoft Camera Front'), camera('Microsoft Camera Rear')], null)?.label).toBe('Microsoft Camera Rear')
  })

  it("prefers a phone's back camera to its front one, whichever is listed first", () => {
    const front = camera('camera2 1, facing front')
    const back = camera('camera2 0, facing back')
    expect(preferredCamera([front, back], null)).toBe(back)
    expect(preferredCamera([camera('Front Camera'), camera('Back Camera')], null)?.label).toBe('Back Camera')
    expect(cameraRank(front.label)).toBe(BUILT_IN_CAMERA_RANK)
    expect(cameraRank(back.label)).toBe(0)
  })

  it('keeps the camera chosen before while it is there', () => {
    expect(preferredCamera([mac, iphone], mac.deviceId)).toBe(mac)
    expect(preferredCamera([iphone, renamed], 'unplugged')).toBe(iphone)
  })

  it('waits for a camera that stopped instead of switching to another', () => {
    // The iPhone moved away: the Mac's camera faces the owner, not the scanning area.
    expect(cameraToUse([mac], null, iphone.deviceId)).toBeNull()
    expect(cameraToUse([mac, renamed], iphone.deviceId, iphone.deviceId)).toBeNull()
    expect(cameraToUse([], null, iphone.deviceId)).toBeNull()
  })

  it('uses a camera that stopped again once it is back', () => {
    expect(cameraToUse([mac, iphone], null, iphone.deviceId)).toBe(iphone)
    expect(cameraToUse([mac, renamed], mac.deviceId, renamed.deviceId)).toBe(renamed)
  })

  it('is the preferred camera while none has stopped', () => {
    expect(cameraToUse([mac, deskView, iphone], null, null)).toBe(iphone)
    expect(cameraToUse([mac, iphone], mac.deviceId, null)).toBe(mac)
    expect(cameraToUse([], null, null)).toBeNull()
  })
})
