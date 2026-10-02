import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../../src/web/lib/clipboard.ts'

/** A page's document, enough for the old way of copying: `copies` is what execCommand('copy') answers. */
function page(copies: boolean | 'throws') {
  const focused = { focus: vi.fn() }
  const box = {
    value: '',
    readOnly: false,
    style: { cssText: '' },
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  }
  const copied: string[] = []
  const document = {
    activeElement: focused,
    body: { append: vi.fn() },
    createElement: vi.fn(() => box),
    execCommand: vi.fn(() => {
      if (copies === 'throws') throw new Error('execCommand is gone')
      if (copies) copied.push(box.value)
      return copies
    }),
  }
  vi.stubGlobal('document', document)
  return { document, box, focused, copied }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyText', () => {
  it('uses the clipboard in a secure context', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { document } = page(true)
    await copyText('4 Forest')
    expect(writeText).toHaveBeenCalledWith('4 Forest')
    expect(document.execCommand).not.toHaveBeenCalled()
  })

  it('copies from a hidden, read-only box over plain HTTP, where there is no clipboard, and puts focus back', async () => {
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('navigator', {})
    const { box, focused, copied } = page(true)
    await copyText('1 Sol Ring')
    expect(copied).toEqual(['1 Sol Ring'])
    expect(box.readOnly).toBe(true)
    expect(box.remove).toHaveBeenCalled()
    expect(focused.focus).toHaveBeenCalled()
  })

  it('falls back to the box when the clipboard refuses', async () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => Promise.reject(new DOMException('Document is not focused', 'NotAllowedError')) } })
    const { copied } = page(true)
    await copyText('Lightning Bolt')
    expect(copied).toEqual(['Lightning Bolt'])
  })

  it('rejects when neither way works, and leaves no box behind', async () => {
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('navigator', {})
    const refused = page(false)
    await expect(copyText('x')).rejects.toThrow("Couldn't copy to the clipboard.")
    expect(refused.box.remove).toHaveBeenCalled()
    const gone = page('throws')
    await expect(copyText('x')).rejects.toThrow("Couldn't copy to the clipboard.")
    expect(gone.box.remove).toHaveBeenCalled()
  })
})
