import { encode } from 'uqr'

/** The light margin a QR code needs around it, in modules: four, as the standard asks, so a camera finds it. */
export const QUIET_ZONE = 4

/**
 * A QR code's dark modules as one SVG path, with the quiet zone around them: a rectangle for each run of dark modules
 * in a row, in a square `size` modules wide (the viewBox), to draw black on white.
 */
export function qrPath(matrix: readonly (readonly boolean[])[], quiet = QUIET_ZONE): { path: string; size: number } {
  const parts: string[] = []
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue
      const start = x
      while (row[x + 1]) x++
      const run = x - start + 1
      parts.push(`M${start + quiet} ${y + quiet}h${run}v1h-${run}z`)
    }
  })
  return { path: parts.join(''), size: matrix.length + 2 * quiet }
}

/**
 * The QR code for a text (an address), with medium error correction, so a phone still reads it off a screen with some
 * glare on it.
 */
export function qrCode(text: string): { path: string; size: number } {
  return qrPath(encode(text, { ecc: 'M', border: 0 }).data)
}
