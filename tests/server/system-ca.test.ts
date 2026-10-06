import { describe, expect, it } from 'vitest'
import { trustSystemCertificates, type CertificateStore } from '../../src/server/system-ca.ts'

/** A stand-in for node:tls: Node's own list, Windows' store, and what was made the default. */
function store(overrides: Partial<CertificateStore> = {}) {
  const set: string[][] = []
  const tls: CertificateStore = {
    getCACertificates: (type) => (type === 'system' ? ['antivirus root'] : ['node root']),
    setDefaultCACertificates: (certs) => void set.push([...certs]),
    ...overrides,
  }
  return { tls, set }
}

describe("trusting Windows' certificates (system-ca)", () => {
  it("adds Windows' store to Node's own list, on Windows", () => {
    const { tls, set } = store()
    expect(trustSystemCertificates('win32', tls)).toBe(true)
    expect(set).toEqual([['node root', 'antivirus root']])
  })

  it('changes nothing on the Mac or Linux, or with a Node too old to set the list', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { tls, set } = store()
      expect(trustSystemCertificates(platform, tls)).toBe(false)
      expect(set).toEqual([])
    }
    expect(trustSystemCertificates('win32', store({ setDefaultCACertificates: undefined }).tls)).toBe(false)
  })

  it("keeps Node's own list when the store can't be read", () => {
    const { tls, set } = store({
      getCACertificates: () => {
        throw new Error('the store is unavailable')
      },
    })
    expect(trustSystemCertificates('win32', tls)).toBe(false)
    expect(set).toEqual([])
  })
})
