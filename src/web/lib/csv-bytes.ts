/**
 * A CSV file's text from its bytes (spec §5.3). A byte order mark names the encoding: UTF-8 (Excel's "CSV UTF-8", and
 * Binder's own export for Excel), or UTF-16 (Excel's "Unicode Text"). Without one the file is read as UTF-8 if it is
 * valid UTF-8 (every other app's export), else as Windows-1252, what Excel on Windows saves a plain "CSV (Comma
 * delimited)" in: read as UTF-8, its accented names (Lim-Dûl, Ifh-Bíff) would come out as replacement characters.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  const [a, b, c] = bytes
  if (a === 0xef && b === 0xbb && c === 0xbf) return new TextDecoder('utf-8').decode(bytes)
  if (a === 0xff && b === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (a === 0xfe && b === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}
