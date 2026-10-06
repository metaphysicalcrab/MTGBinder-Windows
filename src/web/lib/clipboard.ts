/**
 * Copies text to the clipboard. `navigator.clipboard` exists only in a secure context (localhost, the desktop app, or
 * the phone over HTTPS); over plain HTTP, as a phone on the Wi-Fi opens Binder, a hidden text box is selected and
 * copied the old way, which browsers still allow right after a tap or click. Rejects when neither works.
 */
export async function copyText(text: string): Promise<void> {
  if (globalThis.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Refused (the page lost focus, say): the old way may still work.
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  // Read-only, so focusing it doesn't bring up a phone's keyboard; fixed and transparent, so nothing moves or shows.
  area.readOnly = true
  area.setAttribute('aria-hidden', 'true')
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
  // Selecting the box moves focus there; it goes back to the button pressed (for the keyboard, and its focus ring).
  const focused = document.activeElement as HTMLElement | null
  document.body.append(area)
  let copied = false
  try {
    area.select()
    area.setSelectionRange(0, text.length)
    copied = document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    area.remove()
    focused?.focus?.({ preventScroll: true })
  }
  if (!copied) throw new Error("Couldn't copy to the clipboard.")
}
