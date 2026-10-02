import { useMemo } from 'react'
import { qrCode } from '../lib/qr.ts'

/**
 * A QR code for a phone's camera (Settings → Phone access): black on white with its quiet zone, about `size` pixels
 * across (a whole number of pixels to a module, so its edges stay sharp), named for a screen reader by what it holds.
 */
export function QrCode({ text, size = 200 }: { text: string; size?: number }) {
  const qr = useMemo(() => qrCode(text), [text])
  const pixels = Math.max(1, Math.round(size / qr.size)) * qr.size
  return (
    <svg
      role="img"
      aria-label={`QR code for ${text}`}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={pixels}
      height={pixels}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-md"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#000" />
    </svg>
  )
}
