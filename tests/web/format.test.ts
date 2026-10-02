import { describe, expect, it } from 'vitest'
import { formatBytes, formatUsd, plural } from '../../src/web/lib/format.ts'

describe('format', () => {
  it('formats dollars with cents and thousands separators, or a dash for no price', () => {
    expect([formatUsd(0), formatUsd(3.5), formatUsd(480962.456), formatUsd(null)]).toEqual(['$0.00', '$3.50', '$480,962.46', '—'])
  })

  it('pluralizes counts', () => {
    expect([plural(1, 'row'), plural(0, 'row'), plural(2345, 'copy', 'copies')]).toEqual(['1 row', '0 rows', '2,345 copies'])
  })

  it('formats file sizes in MB or KB, as Finder counts them', () => {
    expect(formatBytes(460_660_736, false)).toBe('461 MB')
    expect(formatBytes(8_400_000, false)).toBe('8.4 MB')
    expect(formatBytes(512_000, false)).toBe('512 KB')
    expect(formatBytes(100, false)).toBe('1 KB')
    expect(formatBytes(0, false)).toBe('0 KB')
  })

  it("formats file sizes in 1,024-byte KB and MB on Windows, as File Explorer counts them", () => {
    expect(formatBytes(460_660_736, true)).toBe('439 MB')
    expect(formatBytes(8_400_000, true)).toBe('8.0 MB')
    expect(formatBytes(512_000, true)).toBe('500 KB')
    expect(formatBytes(524_288, true)).toBe('512 KB')
    expect(formatBytes(1_048_576, true)).toBe('1.0 MB')
    expect(formatBytes(100, true)).toBe('1 KB')
    expect(formatBytes(0, true)).toBe('0 KB')
  })

  it('rounds a size before choosing its unit, so it never reads 1000 KB or 10.0 MB', () => {
    expect([formatBytes(999_400, false), formatBytes(999_600, false)]).toEqual(['999 KB', '1.0 MB'])
    expect([formatBytes(9_940_000, false), formatBytes(9_960_000, false)]).toEqual(['9.9 MB', '10 MB'])
    expect([formatBytes(1_023_400, true), formatBytes(1_023_500, true)]).toEqual(['999 KB', '1.0 MB'])
    expect([formatBytes(10_433_000, true), formatBytes(10_434_000, true)]).toEqual(['9.9 MB', '10 MB'])
  })
})
