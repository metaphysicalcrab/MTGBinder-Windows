import { describe, expect, it } from 'vitest'
import { compactedToast, librarySizeText } from '../../src/web/lib/settings.ts'

describe('librarySizeText', () => {
  it('splits the size into the library and its log, and says the unused space is what compacting gives back', () => {
    expect(librarySizeText({ bytes: 460_668_928, freeBytes: 217_829_376, logBytes: 250_178_792 }, false)).toEqual({
      size: '711 MB (461 MB library + 250 MB log)',
      unused: '218 MB (Compact gives it back)',
      worthIt: true,
    })
  })

  it('leaves out a log under 1 MB, and says when there is nothing to compact', () => {
    expect(librarySizeText({ bytes: 241_504_256, freeBytes: 843_776, logBytes: 999_999 }, false)).toEqual({
      size: '243 MB',
      unused: 'Hardly any: nothing to compact',
      worthIt: false,
    })
    expect(librarySizeText({ bytes: 241_504_256, freeBytes: 843_776, logBytes: 1_000_000 }, false).size).toBe(
      '243 MB (242 MB library + 1.0 MB log)',
    )
  })
})

describe('librarySizeText on Windows', () => {
  it('counts as File Explorer does, 1,024 bytes to the KB, and splits out a log of 1 MB counted so', () => {
    expect(librarySizeText({ bytes: 460_668_928, freeBytes: 217_829_376, logBytes: 250_178_792 }, true)).toEqual({
      size: '678 MB (439 MB library + 239 MB log)',
      unused: '208 MB (Compact gives it back)',
      worthIt: true,
    })
    expect(librarySizeText({ bytes: 241_504_256, freeBytes: 843_776, logBytes: 1_000_000 }, true).size).toBe('231 MB')
    expect(librarySizeText({ bytes: 241_504_256, freeBytes: 843_776, logBytes: 1_048_576 }, true).size).toBe(
      '231 MB (230 MB library + 1.0 MB log)',
    )
  })
})

describe('compactedToast', () => {
  it('says the sizes Settings shows, the file and its log together, and the backup it saved first', () => {
    const before = { bytes: 460_668_928, freeBytes: 217_829_376, logBytes: 250_178_792 }
    const after = { bytes: 241_516_544, freeBytes: 843_776, logBytes: 0 }
    expect(compactedToast({ before, after, backup: 'binder-2026-09-28-2.db' }, false)).toBe(
      'Compacted the library from 711 MB to 242 MB, after saving binder-2026-09-28-2.db.',
    )
    // A write right after the compaction starts the log again: it counts after too.
    expect(compactedToast({ before, after: { ...after, logBytes: 4_000_000 }, backup: 'binder-2026-09-28-2.db' }, false)).toBe(
      'Compacted the library from 711 MB to 246 MB, after saving binder-2026-09-28-2.db.',
    )
  })
})
