import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useBackToClose } from '../../lib/back-to-close.ts'
import type { Rect } from '../../lib/capture.ts'
import {
  gestureGuide,
  largestGuideHeight,
  MIN_GUIDE_SHARE,
  moveGuide,
  openPhoto,
  PhotoError,
  photoToCapture,
  type Point,
  type RelativeGuide,
  relativeGuide,
  resizeGuide,
  startingGuide,
} from '../../lib/photo-capture.ts'
import { IS_ANDROID, PLATFORM, type Platform, useCoarsePointer } from '../../lib/platform.ts'
import { CAPTURE_BUTTON, CaptureBar } from './CaptureBar.tsx'

/** Where a photo came from: the camera app, or the photos already on the device. Retake opens the same again. */
type Source = 'camera' | 'library'

interface Photo {
  /** Each photo's own, so its review starts afresh. */
  id: number
  bitmap: ImageBitmap
  /** Too large to open whole, so opened at half its width (openPhoto). */
  halved: boolean
  source: Source
}

/** How to take a photo that reads well, said before the first one. */
export function photoTip(handheld: boolean): string {
  return handheld
    ? 'Hold the phone upright over one card, so the card fills most of the picture, and avoid glare.'
    : 'Photograph one card at a time, filling most of the picture, without glare.'
}

/**
 * Why there's no live camera, when the page could have one, or null. The browser allows the live camera only on a
 * secure page (HTTPS, or Binder opened on the computer itself); `secure`: this page is one.
 */
export function liveCameraNote(platform: Platform, secure: boolean): string | null {
  if (secure) return null
  return platform === 'android'
    ? 'For a live camera view instead of photos, turn on HTTPS in Settings → Phone access on the PC.'
    : 'The live camera needs HTTPS, or Binder opened on the computer it runs on; photos work here.'
}

/** What a photo that couldn't be opened or made into a capture says. */
const photoProblem = (err: unknown) =>
  err instanceof PhotoError ? err.message : `Couldn't use the photo: ${err instanceof Error ? err.message : String(err)}`

/**
 * A button that takes a photo with the camera app (`source` camera) or chooses one already on the device: a label
 * around a file input, which a tap opens. The input is emptied after each photo, so the same photo chosen again (or a
 * camera app that names every photo alike) still counts as a new one.
 */
function PhotoButton({
  source,
  inputRef,
  onPhoto,
  disabled = false,
  className,
  children,
}: {
  source: Source
  inputRef?: RefObject<HTMLInputElement | null>
  onPhoto: (file: File, source: Source) => void
  disabled?: boolean
  className: string
  children: ReactNode
}) {
  return (
    <label
      className={`cursor-pointer focus-within:ring-2 focus-within:ring-amber-500/40 has-disabled:cursor-default has-disabled:opacity-50 ${className}`}
    >
      {children}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={source === 'camera' ? 'environment' : undefined}
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) onPhoto(file, source)
        }}
        className="sr-only"
      />
    </label>
  )
}

/**
 * Photos to scan (M13): a photo from a PhotoButton opens upright for review, where the owner fits the guide to the
 * card, and Use photo sends its capture (photoToCapture). The guide's place is kept for the next photo, so a stack
 * photographed the same way needs no fitting after the first.
 */
function usePhotos(onCapture: (jpeg: Blob) => void) {
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  const last = useRef<RelativeGuide | null>(null)
  const photoIds = useRef(0)
  const cameraRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  // A photo is let go of once it's done with (sent, retaken, or the review closed), and when the page closes.
  useEffect(() => {
    if (!photo) return
    return () => photo.bitmap.close()
  }, [photo])

  const pick = (file: File, source: Source) => {
    setError(null)
    setOpening(true)
    openPhoto(file)
      .then(
        (opened) => (alive.current ? setPhoto({ ...opened, id: ++photoIds.current, source }) : opened.bitmap.close()),
        (err: unknown) => alive.current && setError(photoProblem(err)),
      )
      .finally(() => alive.current && setOpening(false))
  }

  const use = async (guide: Rect) => {
    if (!photo) return
    setMaking(true)
    try {
      const jpeg = await photoToCapture(photo.bitmap, guide)
      last.current = relativeGuide(guide, photo.bitmap.width, photo.bitmap.height)
      onCapture(jpeg)
      // A short buzz says it went, where the phone can (vibrate needs a tap on the page first, which Use photo is).
      navigator.vibrate?.(40)
      setPhoto(null)
    } catch (err) {
      setError(photoProblem(err))
    } finally {
      setMaking(false)
    }
  }

  const retake = () => {
    const input = (photo?.source === 'library' ? libraryRef : cameraRef).current
    setPhoto(null)
    setError(null)
    // In the same tap, which a file input needs to open.
    input?.click()
  }

  const review = photo && (
    <PhotoReview
      key={photo.id}
      photo={photo}
      initial={startingGuide(photo.bitmap.width, photo.bitmap.height, last.current)}
      making={making}
      error={error}
      onUse={(guide) => void use(guide)}
      onRetake={retake}
      onCancel={() => {
        setPhoto(null)
        setError(null)
      }}
    />
  )
  return { pick, opening, error: photo ? null : error, review, cameraRef, libraryRef }
}

/**
 * The photo, with the card guide to fit over the card (M13): drag it, pinch or use the slider to size it (it stays card
 * shaped), then Use photo. A full-window dialog that Back, Escape, or Cancel closes.
 */
function PhotoReview({
  photo,
  initial,
  making,
  error,
  onUse,
  onRetake,
  onCancel,
}: {
  photo: Photo
  initial: Rect
  making: boolean
  error: string | null
  onUse: (guide: Rect) => void
  onRetake: () => void
  onCancel: () => void
}) {
  const { bitmap } = photo
  const { width: w, height: h } = bitmap
  const touch = useCoarsePointer()
  const [guide, setGuide] = useState(initial)
  const guideRef = useRef(guide)
  guideRef.current = guide
  const areaRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const [area, setArea] = useState<{ width: number; height: number } | null>(null)
  // What had focus before, read on the first render (as in ShortcutsDialog).
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  useBackToClose(true, onCancel)

  useEffect(() => {
    primaryRef.current?.focus()
    return () => opener?.focus()
  }, [opener])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // The photo is shown as large as the room below the title and above the buttons allows.
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setArea({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const scale = area ? Math.min(area.width / w, area.height / h) : 0

  // Drawn at the size it's shown, in the screen's own pixels: a 12-megapixel canvas would cost a phone dearly.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || scale <= 0) return
    const ratio = Math.min(window.devicePixelRatio || 1, 3)
    canvas.width = Math.max(1, Math.round(w * scale * ratio))
    canvas.height = Math.max(1, Math.round(h * scale * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  }, [bitmap, scale, w, h])

  // The fingers (or the mouse) on the photo, and the guide and fingers when the gesture began or changed hands.
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<{ guide: Rect; points: Point[] } | null>(null)
  const begin = () => {
    gesture.current = { guide: guideRef.current, points: [...pointers.current.values()].slice(0, 2) }
  }
  const lift = (id: number) => {
    pointers.current.delete(id)
    begin()
  }

  const largest = largestGuideHeight(w, h)
  const resize = (height: number) => setGuide((g) => resizeGuide(g, height, w, h))
  const step = Math.max(w, h) / 100

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="photo-review-heading"
      className="fixed inset-0 z-50 flex flex-col bg-stone-950 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <h2 id="photo-review-heading" className="font-serif text-lg text-stone-50">
          Fit the guide to the card
        </h2>
        <button
          onClick={onCancel}
          className="rounded px-2 py-1 text-sm text-stone-400 hover:bg-stone-800 hover:text-stone-100 pointer-coarse:-my-1.5 pointer-coarse:px-3 pointer-coarse:py-2.5"
        >
          Cancel
        </button>
      </div>
      <div
        ref={areaRef}
        tabIndex={0}
        aria-label="The photo, with the card guide: arrow keys move the guide, + and − size it"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          begin()
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          const start = gesture.current
          if (!start || scale <= 0) return
          setGuide(gestureGuide(start.guide, start.points, [...pointers.current.values()].slice(0, 2), scale, w, h))
        }}
        onPointerUp={(e) => lift(e.pointerId)}
        onPointerCancel={(e) => lift(e.pointerId)}
        onWheel={(e) => resize(guide.height * (e.deltaY < 0 ? 1.05 : 1 / 1.05))}
        onKeyDown={(e) => {
          const by = e.shiftKey ? step * 5 : step
          const moves: Record<string, [number, number]> = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] }
          const move = moves[e.key]
          if (move) setGuide((g) => moveGuide(g, move[0], move[1], w, h))
          else if (e.key === '+' || e.key === '=') resize(guide.height * 1.05)
          else if (e.key === '-' || e.key === '−') resize(guide.height / 1.05)
          else return
          e.preventDefault()
        }}
        className="relative min-h-0 flex-1 cursor-move touch-none overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
      >
        {area && scale > 0 && (
          <div
            className="absolute overflow-hidden"
            style={{ left: (area.width - w * scale) / 2, top: (area.height - h * scale) / 2, width: w * scale, height: h * scale }}
          >
            <canvas ref={canvasRef} className="block h-full w-full" />
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-[5%] border-2 border-amber-400/80 shadow-[0_0_0_9999px_rgba(12,10,9,0.5)]"
              style={{
                left: `${(guide.x / w) * 100}%`,
                top: `${(guide.y / h) * 100}%`,
                width: `${(guide.width / w) * 100}%`,
                height: `${(guide.height / h) * 100}%`,
              }}
            />
          </div>
        )}
      </div>
      <div className="mx-auto w-full max-w-xl space-y-3 px-4 py-3">
        <p className="text-sm text-stone-400">
          {touch
            ? 'Drag the guide onto the card, and pinch or use the slider to fit it to the card’s edges.'
            : 'Drag the guide onto the card, and size it with the slider or the scroll wheel to fit the card’s edges.'}
        </p>
        {photo.halved && (
          <p className="text-sm text-amber-200">This photo was too large to open whole here, so it was opened at half size.</p>
        )}
        {error && (
          <p role="alert" className="rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
            {error}
          </p>
        )}
        <label className="flex items-center gap-3 text-sm text-stone-400">
          Size
          <input
            type="range"
            min={MIN_GUIDE_SHARE}
            max={1}
            step={0.01}
            value={guide.height / largest}
            onChange={(e) => resize(Number(e.target.value) * largest)}
            className="min-h-10 flex-1 accent-amber-500"
          />
        </label>
        <div className="flex gap-3">
          <button
            onClick={onRetake}
            disabled={making}
            className="rounded-lg border border-stone-700 px-4 py-3 text-base text-stone-200 hover:bg-stone-800 disabled:opacity-50"
          >
            {photo.source === 'camera' ? 'Retake' : 'Choose another'}
          </button>
          <button
            ref={primaryRef}
            onClick={() => onUse(guide)}
            disabled={making}
            className="flex-1 rounded-lg bg-amber-500 px-4 py-3 text-base font-medium text-stone-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {making ? 'Sending…' : 'Use photo'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Take a photo, beside the live camera on a phone (M13): the camera app's own picture (sharper than a video frame, with
 * its flash and focus) for a card the live view struggles with. Its review opens over the page.
 */
export function TakePhotoButton({ onCapture, className }: { onCapture: (jpeg: Blob) => void; className: string }) {
  const photos = usePhotos(onCapture)
  return (
    <>
      <PhotoButton source="camera" inputRef={photos.cameraRef} onPhoto={photos.pick} disabled={photos.opening} className={className}>
        {photos.opening ? 'Opening the photo…' : 'Take a photo'}
      </PhotoButton>
      {photos.error && (
        <p role="alert" className="basis-full rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
          {photos.error}
        </p>
      )}
      {photos.review}
    </>
  )
}

/**
 * The camera side of the Scan page without a live camera (M13): a phone on plain HTTP, where the browser allows no
 * camera stream. Take a photo opens the camera app, Choose a photo the device's photos; each photo is fitted to the
 * card guide and sent as a capture like the live camera's, by hand (auto mode needs a live picture).
 */
export function PhotoPanel({ onCapture, summary }: { onCapture: (jpeg: Blob) => void; summary?: ReactNode }) {
  const coarse = useCoarsePointer()
  const photos = usePhotos(onCapture)
  const note = liveCameraNote(PLATFORM, typeof window !== 'undefined' && window.isSecureContext)
  return (
    <section aria-label="Camera" className="space-y-3">
      <div className="flex items-start gap-4 rounded-xl border border-stone-800 bg-stone-900/40 p-4">
        <div aria-hidden className="mt-0.5 aspect-[63/88] w-10 shrink-0 rounded-[5%] border-2 border-amber-400/80" />
        <div className="min-w-0 space-y-3">
          <p className="text-sm text-stone-300">{photoTip(IS_ANDROID || coarse)}</p>
          <PhotoButton
            source="library"
            inputRef={photos.libraryRef}
            onPhoto={photos.pick}
            disabled={photos.opening}
            className="inline-flex min-h-10 items-center rounded-md border border-stone-700 px-3 text-sm text-stone-200 hover:bg-stone-800"
          >
            Choose a photo
          </PhotoButton>
        </div>
      </div>
      {note && <p className="text-xs text-stone-500">{note}</p>}
      {photos.error && (
        <p role="alert" className="rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
          {photos.error}
        </p>
      )}
      <CaptureBar summary={summary}>
        <PhotoButton source="camera" inputRef={photos.cameraRef} onPhoto={photos.pick} disabled={photos.opening} className={CAPTURE_BUTTON}>
          {photos.opening ? 'Opening the photo…' : 'Take a photo of the card'}
        </PhotoButton>
      </CaptureBar>
      {photos.review}
    </section>
  )
}
