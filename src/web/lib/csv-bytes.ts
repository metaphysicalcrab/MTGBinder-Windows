/**
 * A CSV file's text from its bytes (spec §5.3). A byte order mark names the encoding: UTF-8 (Excel's "CSV UTF-8", and
 * Binder's own Export for Excel), or UTF-16 (Excel's "Unicode Text"). Without one the file is read as UTF-8 (every
 * other app's export) unless it mostly isn't: then as Windows-1252, what Excel on Windows saves a plain "CSV (Comma
 * delimited)" in. Read as UTF-8, that file's accented names (Lim-Dûl, Ifh-Bíff) would come out as replacement
 * characters. A UTF-8 file with a stray byte that isn't (a line pasted in from another app, a file cut off mid-letter)
 * stays UTF-8, with a replacement character for that byte, rather than every accented name in it garbled.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  const [a, b, c] = bytes
  if (a === 0xef && b === 0xbb && c === 0xbf) return new TextDecoder('utf-8').decode(bytes)
  if (a === 0xff && b === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (a === 0xfe && b === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  const text = new TextDecoder('utf-8').decode(bytes)
  // A Windows-1252 file's accented letters are bytes UTF-8 can't read (each a replacement character); a UTF-8 file's
  // are letters beyond ASCII.
  let letters = 0
  let invalid = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0xfffd) invalid++
    else if (code > 0x7f) letters++
  }
  return letters >= invalid ? text : new TextDecoder('windows-1252').decode(bytes)
}
