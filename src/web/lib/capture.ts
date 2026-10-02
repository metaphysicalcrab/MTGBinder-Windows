/** A card is 63 × 88 mm (spec §5.1.1). */
export const CARD_ASPECT = 63 / 88

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The card-shaped guide in a video frame: centered, as tall as `fill` of the frame (narrower if the frame is). */
export function guideRect(frameWidth: number, frameHeight: number, fill = 0.82): Rect {
  let height = frameHeight * fill
  let width = height * CARD_ASPECT
  if (width > frameWidth * fill) {
    width = frameWidth * fill
    height = width / CARD_ASPECT
  }
  return { x: (frameWidth - width) / 2, y: (frameHeight - height) / 2, width, height }
}

/**
 * What a capture keeps: the guide plus a margin on every side (clamped to the frame), so a card placed a little off
 * the guide is still whole. The server finds the card's text within it.
 */
export function captureRect(guide: Rect, frameWidth: number, frameHeight: number, margin = 0.08): Rect {
  const dx = guide.width * margin
  const dy = guide.height * margin
  const x = Math.max(0, guide.x - dx)
  const y = Math.max(0, guide.y - dy)
  return {
    x,
    y,
    width: Math.min(frameWidth, guide.x + guide.width + dx) - x,
    height: Math.min(frameHeight, guide.y + guide.height + dy) - y,
  }
}

/** Mean absolute difference of the red, green, and blue values of two same-size RGBA frames, from 0 to 255. */
export function frameDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length || a.length === 0) return 255
  let total = 0
  for (let i = 0; i < a.length; i += 4) {
    total += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)
  }
  return total / ((a.length / 4) * 3)
}

/**
 * An RGBA frame shrunk by averaging each `scale` × `scale` block into one dot: `width` × `height` dots from a frame
 * `scale` times as large. Averaging (rather than picking one pixel per dot, as drawing a video small does) keeps a
 * one-pixel camera wobble over fine detail, like a card's text, from looking like movement.
 */
export function boxAverage(big: Uint8ClampedArray, width: number, height: number, scale: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  const n = scale * scale
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((y * scale + dy) * width * scale + x * scale + dx) * 4
          r += big[i]!
          g += big[i + 1]!
          b += big[i + 2]!
        }
      }
      const o = (y * width + x) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = 255
    }
  }
  return out
}

/** The mean of the red, green, and blue values of an RGBA frame. */
function brightness(frame: Uint8ClampedArray): number {
  let total = 0
  for (let i = 0; i < frame.length; i += 4) total += frame[i]! + frame[i + 1]! + frame[i + 2]!
  return total / ((frame.length / 4) * 3)
}

/**
 * How much two same-size RGBA frames differ, from 0 to 255, once an overall brightness shift is taken out: the camera
 * adjusting its exposure isn't movement. Frames of different sizes are entirely different.
 */
export function frameChange(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length || a.length === 0) return 255
  const shift = brightness(a) - brightness(b)
  let total = 0
  for (let i = 0; i < a.length; i += 4) {
    total += Math.abs(a[i]! - b[i]! - shift) + Math.abs(a[i + 1]! - b[i + 1]! - shift) + Math.abs(a[i + 2]! - b[i + 2]! - shift)
  }
  return total / ((a.length / 4) * 3)
}

/** Auto mode's sample of the guide region: this many dots, each the average of a SAMPLE_SCALE × SAMPLE_SCALE block. */
export const SAMPLE_SIZE = { width: 45, height: 63 }
export const SAMPLE_SCALE = 4
/** How often auto mode samples the frame, and how long it must hold still (spec §5.1.1). */
export const SAMPLE_MS = 150
export const STABLE_MS = 600
/**
 * The thresholds on frameChange of two samples (spec §5.1.1), from an iPhone over a mat on 2026-09-28 (the most in
 * 5 seconds: an empty mat 2.3 from sample to sample, a card lying still 6.2; a card 63 from the empty mat):
 * - at or below STILL_THRESHOLD from the sample before, the picture is holding still;
 * - further than CARD_THRESHOLD from the empty mat, a still picture is a card;
 * - further than NEW_CARD_THRESHOLD from the last capture, a still card is a new one (moved or swapped).
 */
export const STILL_THRESHOLD = 8
export const CARD_THRESHOLD = 20
export const NEW_CARD_THRESHOLD = 12

/**
 * How likely a camera is the one mounted over the scanning area, from its label, best first: an iPhone (Continuity
 * Camera), a phone's or tablet's back camera ("camera2 0, facing back" on Android, "Microsoft Camera Rear" on a
 * Surface) or a document camera; then any other camera; then the computer's own, facing the owner (a Mac's FaceTime
 * camera, a Windows laptop's "Integrated Webcam", "HD User Facing" or "HP TrueVision HD Camera", a phone's front
 * camera); then Desk View and virtual cameras (made from another camera's picture). A renamed iPhone's camera is named
 * after the phone ("Kason's Phone Camera"), so any camera that isn't the computer's own is the next best guess: a USB
 * webcam, say.
 */
export function cameraRank(label: string): number {
  if (/desk view|virtual/i.test(label)) return 3
  if (/iphone|\bback\b|\brear\b|environment|document|ipevo|czur/i.test(label)) return 0
  if (/facetime|built-in|macbook|imac|studio display|integrated|user facing|\bfront\b|truevision|wide vision|easycamera/i.test(label)) {
    return BUILT_IN_CAMERA_RANK
  }
  return 1
}
/**
 * The rank of the computer's own cameras, which face the owner (and a phone's front camera). A camera ranked this or
 * worse (this number or higher: the computer's own, Desk View, a virtual camera) isn't one mounted for scanning.
 */
export const BUILT_IN_CAMERA_RANK = 2

/** The camera to use: the one chosen before while it's there, else the best by cameraRank (the first of equals). */
export function preferredCamera<Device extends { deviceId: string; label: string }>(
  devices: readonly Device[],
  chosenId: string | null,
): Device | null {
  const chosen = devices.find((d) => d.deviceId === chosenId)
  if (chosen) return chosen
  let best: Device | null = null
  for (const d of devices) if (best === null || cameraRank(d.label) < cameraRank(best.label)) best = d
  return best
}

/**
 * The camera to use once one has stopped (`lostId`: unplugged, or the phone moved away): that camera while it's
 * listed, else none until it's back or the owner picks another. Switching by itself to the next best (a laptop's own
 * camera, facing the owner) would keep auto mode capturing the wrong picture without anyone choosing it. With no
 * camera stopped, preferredCamera's choice.
 */
export function cameraToUse<Device extends { deviceId: string; label: string }>(
  devices: readonly Device[],
  chosenId: string | null,
  lostId: string | null,
): Device | null {
  if (lostId !== null) return devices.find((d) => d.deviceId === lostId) ?? null
  return preferredCamera(devices, chosenId)
}

/** The input types Space types into; on any other input it would press or toggle the control. */
export const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'password', 'email', 'url', 'number', 'tel'])

/**
 * Whether Space, pressed with focus on `target`, captures: everywhere but a text-entry field or a modal dialog (such
 * as the card drawer, whose controls keep their own Space). On buttons, selects, and other controls it captures
 * instead of pressing them (a clicked button keeps focus in Chrome). `modalOpen`: a modal dialog is open, so the page
 * behind it doesn't capture even when focus has fallen back to `<body>`.
 */
export function spaceCaptures(
  target: { tagName: string; type?: string; isContentEditable?: boolean; closest?(selector: string): unknown } | null,
  modalOpen = false,
): boolean {
  if (modalOpen) return false
  if (!target) return true
  if (target.closest?.('[aria-modal="true"]')) return false
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return false
  if (target.tagName === 'INPUT') return !TEXT_INPUT_TYPES.has((target.type ?? '').toLowerCase())
  return true
}

/**
 * What auto mode is doing (spec §5.1.1): learning the empty mat (the first picture that holds still), ready for a card
 * (the empty mat showing), waiting for a card to hold still, or showing the card it captured.
 */
export type AutoStatus = 'learning' | 'ready' | 'settling' | 'captured'

/** One sample's outcome: whether to capture now, and whether the empty mat showed since the last capture. */
export interface AutoStep {
  capture: boolean
  lifted: boolean
  status: AutoStatus
}

/**
 * Auto mode (spec §5.1.1). Feed it each sample of the guide region. The first picture that holds still for STABLE_MS
 * is the empty mat, and every still picture close to it after that updates it (slow changes in the light). A still
 * picture that isn't the empty mat is a card: it's captured unless it's the card captured last, still lying there
 * (the empty mat not seen since, and the picture close to that capture's). A capture says whether the empty mat showed
 * since the last one: the card was lifted, so another copy of the same card is a new card.
 */
export function createAutoCapture(
  options: { still?: number; card?: number; newCard?: number; stableMs?: number } = {},
) {
  const still = options.still ?? STILL_THRESHOLD
  const cardAway = options.card ?? CARD_THRESHOLD
  const newCard = options.newCard ?? NEW_CARD_THRESHOLD
  const stableMs = options.stableMs ?? STABLE_MS
  let empty: Uint8ClampedArray | null = null
  let last: Uint8ClampedArray | null = null
  let lifted = false
  let previous: Uint8ClampedArray | null = null
  let stillSince: number | null = null
  return {
    sample(frame: Uint8ClampedArray, now: number): AutoStep {
      const moved = previous === null || frameChange(previous, frame) > still
      previous = frame
      stillSince = moved ? null : (stillSince ?? now)
      const isEmpty = empty !== null && frameChange(empty, frame) <= cardAway
      const isLast = last !== null && !lifted && frameChange(last, frame) <= newCard
      const status: AutoStatus = empty === null ? 'learning' : isEmpty ? 'ready' : isLast ? 'captured' : 'settling'
      if (stillSince === null || now - stillSince < stableMs) return { capture: false, lifted: false, status }
      if (empty === null || isEmpty) {
        empty = frame
        lifted = true
        return { capture: false, lifted: false, status: 'ready' }
      }
      if (isLast) return { capture: false, lifted: false, status: 'captured' }
      const step = { capture: true, lifted, status: 'captured' as const }
      last = frame
      lifted = false
      return step
    },
    /** A capture taken by hand: the picture showing now counts as captured, so auto mode doesn't capture it again. */
    captured() {
      if (previous === null) return
      last = previous
      lifted = false
    },
  }
}
