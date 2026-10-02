import tls from 'node:tls'

/** The calls trustSystemCertificates makes (node:tls's own; tests pass stand-ins). */
export interface CertificateStore {
  getCACertificates?: (type: 'default' | 'system') => string[]
  setDefaultCACertificates?: (certs: readonly string[]) => void
}

/**
 * On Windows, has Binder's own HTTPS requests (Scryfall, Anthropic) trust the certificates Windows trusts as well as
 * the ones Node ships with. Antivirus that checks HTTPS (Avast, AVG, Kaspersky, ESET, Bitdefender) and company
 * networks put their own certificate in Windows' store, which Node's list lacks, so every request would fail as if
 * Binder were offline. It needs Node 24.5's tls.setDefaultCACertificates: with an older Node, and on other
 * platforms, nothing changes. Best effort. Returns whether the store's certificates were added.
 */
export function trustSystemCertificates(platform = process.platform, store: CertificateStore = tls): boolean {
  if (platform !== 'win32' || !store.getCACertificates || !store.setDefaultCACertificates) return false
  try {
    store.setDefaultCACertificates([...store.getCACertificates('default'), ...store.getCACertificates('system')])
    return true
  } catch {
    return false // Node's own list stays in use
  }
}
