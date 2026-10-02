import 'reflect-metadata' // @peculiar/x509 needs the polyfill, loaded before it
import * as x509 from '@peculiar/x509'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { removeWithRetry, renameWithRetryAsync } from '../fs-retry.ts'

/**
 * Phone access over HTTPS: Binder's own certificate authority, which the owner installs on the phone once, and the
 * server certificate it signs for the PC's addresses. The authority can vouch only for private addresses (10/8,
 * 172.16/12, 192.168/16 and loopback) and local names: its key lives on the PC, and an authority without those name
 * constraints, trusted by the phone, would let anyone holding that key intercept the phone's traffic to any site.
 *
 * The files are kept in `<library>/lan/`, outside binder.db, so backups and move-library never carry the key, each
 * private to its owner.
 */

x509.cryptoProvider.set(crypto.webcrypto as Crypto) // Node's own WebCrypto makes the keys and signs

const CA_CERT = 'ca.pem'
const CA_KEY = 'ca-key.pem'
const LEAF_CERT = 'leaf.pem'
const LEAF_KEY = 'leaf-key.pem'

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
const DAY_MS = 86_400_000
/** How long the authority lasts: phones install it again only after this, or a rotation. */
const AUTHORITY_YEARS = 10
/** How long a server certificate lasts: 397 days, the most browsers accept from a public authority. */
const LEAF_DAYS = 397
/** A certificate with fewer days than this left is replaced. */
const RENEW_DAYS = 30

/** The name constraints extension (RFC 5280 §4.2.1.10). */
const NAME_CONSTRAINTS = '2.5.29.30'

/** The addresses an authority may vouch for: the private IPv4 ranges, and loopback (the PC itself). */
const PRIVATE_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
]

export interface CertificateOptions {
  /** The folder the files are kept in: `<library>/lan/`. */
  dir: string
  /** The PC's IPv4 addresses that phones open Binder at. */
  addresses: readonly string[]
  /** The PC's names: its hostname, and `<hostname>.local`. */
  hostnames: readonly string[]
  /** When it is, for issuing and for checking what expires (tests pass their own). Default: now. */
  now?: Date
  /** The PC's name in a new authority's name (default: this computer's hostname). */
  computerName?: string
  /** Whose rules make the files private: Windows' access lists, or mode 600 everywhere else. Default: this platform. */
  platform?: NodeJS.Platform
  /** Makes a file private to the current user on Windows (default: icacls). Tests pass a stand-in. */
  ownerOnly?: (file: string) => void | Promise<void>
}

/** The certificate authority, as the phone installs it and the setup page shows it. */
export interface AuthorityInfo {
  caPem: string
  /** What `/binder-ca.crt` serves. */
  caDer: Uint8Array
  /** SHA-256 of the authority, as Android shows it: "AB:CD:…" (32 bytes, upper case). */
  caFingerprint: string
  /** Its name, which Android lists it by: "Binder on DESKTOP-ABC (2026-10-02)". */
  caName: string
}

export interface LanCertificates extends AuthorityInfo {
  /** The server certificate's private key (PEM). */
  key: string
  /** The chain the HTTPS listener serves: the server certificate, then the authority (PEM). */
  cert: string
  leafFingerprint: string
  /**
   * The addresses and names the server certificate covers: those asked for that the authority can vouch for, and
   * 127.0.0.1. One the authority can't (a public address, a name it wasn't made for) is left out, since a single
   * name outside its constraints would make phones refuse the whole certificate.
   */
  addresses: string[]
  hostnames: string[]
  expiresAt: Date
  /** Whether the server certificate was issued by this call: the HTTPS listener needs it (setSecureContext). */
  reissued: boolean
  /**
   * The authority: 'kept'; 'created', there was none; or 'replaced' (rotated, or its files were missing, damaged or
   * near their end), so phones that installed the old one must install this one.
   */
  authority: 'kept' | 'created' | 'replaced'
}

/**
 * The HTTPS listener's certificates: the authority, made once, and a server certificate, issued again whenever the
 * addresses or names change, fewer than 30 days remain, or the authority changed. Missing, damaged or mismatched
 * files are made again (the authority too, which phones must then install again: `authority` says so).
 */
export function ensureCertificates(options: CertificateOptions): Promise<LanCertificates> {
  return oneAtATime(options.dir, () => certificates(options, false))
}

/** Replaces the authority with a new one, and issues a server certificate from it. Phones must install it again. */
export function rotateAuthority(options: CertificateOptions): Promise<LanCertificates> {
  return oneAtATime(options.dir, () => certificates(options, true))
}

/** The authority in `dir`, for the setup page; null when there's none, or none that's usable. */
export function readAuthority(dir: string, now = new Date()): AuthorityInfo | null {
  const authority = loadAuthority(dir, now)
  return authority && authorityInfo(authority)
}

// Making and checking the certificates

interface Authority {
  cert: crypto.X509Certificate
  parsed: x509.X509Certificate
  keyPem: string
  constraints: Constraints
}

interface Leaf {
  cert: crypto.X509Certificate
  parsed: x509.X509Certificate
  keyPem: string
}

/** The names a server certificate covers. */
interface Names {
  addresses: string[]
  hostnames: string[]
}

async function certificates(options: CertificateOptions, rotate: boolean): Promise<LanCertificates> {
  const { dir, now = new Date() } = options
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  removeLeftovers(dir)
  let ca = rotate ? null : loadAuthority(dir, now)
  let authority: LanCertificates['authority'] = 'kept'
  if (!ca) {
    authority = [CA_CERT, CA_KEY].some((file) => fs.existsSync(path.join(dir, file))) ? 'replaced' : 'created'
    ca = await createAuthority(options, now)
  }
  const names = coveredNames(ca.constraints, options.addresses, options.hostnames)
  let leaf = authority === 'kept' ? loadLeaf(dir, ca, names, now) : null
  const reissued = !leaf
  leaf ??= await issueLeaf(options, ca, names, now)
  return {
    ...authorityInfo(ca),
    key: leaf.keyPem,
    cert: `${leaf.cert.toString()}${ca.cert.toString()}`,
    leafFingerprint: leaf.cert.fingerprint256,
    ...names,
    expiresAt: leaf.parsed.notAfter,
    reissued,
    authority,
  }
}

function authorityInfo(ca: Authority): AuthorityInfo {
  return {
    caPem: ca.cert.toString(),
    caDer: new Uint8Array(ca.cert.raw),
    caFingerprint: ca.cert.fingerprint256,
    caName: ca.parsed.subjectName.getField('CN')[0] ?? ca.parsed.subject,
  }
}

/** Whether a certificate is valid now, with at least RENEW_DAYS left. */
const current = (cert: x509.X509Certificate, now: Date) =>
  cert.notBefore.getTime() <= now.getTime() && cert.notAfter.getTime() - now.getTime() >= RENEW_DAYS * DAY_MS

/** The authority in `dir`, if both its files are there, match, and it's one of Binder's, current; else null. */
function loadAuthority(dir: string, now: Date): Authority | null {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(path.join(dir, CA_CERT)))
    const keyPem = fs.readFileSync(path.join(dir, CA_KEY), 'utf8')
    const parsed = new x509.X509Certificate(cert.raw)
    const basic = parsed.getExtension(x509.BasicConstraintsExtension)
    const extension = parsed.getExtension(NAME_CONSTRAINTS)
    if (!basic?.ca || !extension?.critical) return null
    const constraints = decodeConstraints(new Uint8Array(extension.value))
    // Both kinds of name must be constrained: a kind with no subtree at all would be unconstrained.
    if (constraints.ranges.length === 0 || constraints.dnsNames.length === 0) return null
    if (!cert.verify(cert.publicKey) || !cert.checkPrivateKey(crypto.createPrivateKey(keyPem))) return null
    return current(parsed, now) ? { cert, parsed, keyPem, constraints } : null
  } catch {
    return null // missing or unreadable
  }
}

/** The server certificate in `dir`, if both its files are there, match, and it's current, from `ca`, for `names`. */
function loadLeaf(dir: string, ca: Authority, names: Names, now: Date): Leaf | null {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(path.join(dir, LEAF_CERT)))
    const keyPem = fs.readFileSync(path.join(dir, LEAF_KEY), 'utf8')
    const parsed = new x509.X509Certificate(cert.raw)
    if (cert.ca || !cert.checkIssued(ca.cert) || !cert.verify(ca.cert.publicKey)) return null
    if (!cert.checkPrivateKey(crypto.createPrivateKey(keyPem)) || !current(parsed, now)) return null
    const sans = parsed.getExtension(x509.SubjectAlternativeNameExtension)?.names.items ?? []
    const has = sans.map((name) => `${name.type}:${name.value}`).sort()
    const wants = [...names.addresses.map((a) => `ip:${a}`), ...names.hostnames.map((h) => `dns:${h}`)].sort()
    return has.join() === wants.join() ? { cert, parsed, keyPem } : null
  } catch {
    return null
  }
}

async function createAuthority(options: CertificateOptions, now: Date): Promise<Authority> {
  const keys = await crypto.webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])
  const constraints: Constraints = {
    ranges: PRIVATE_RANGES.map(([address, bits]) => range(address, bits)),
    dnsNames: authorityNames(options.hostnames),
  }
  const notAfter = new Date(now)
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + AUTHORITY_YEARS)
  const computer = options.computerName ?? os.hostname()
  const parsed = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(),
    // The date tells a rotated authority from the one before it in the phone's list.
    name: [{ O: ['Binder'] }, { CN: [`Binder on ${computer} (${now.toISOString().slice(0, 10)})`] }],
    notBefore: new Date(now.getTime() - DAY_MS), // a phone whose clock is a little behind
    notAfter,
    keys: keys as CryptoKeyPair,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true), // signs server certificates, never another authority
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey as CryptoKey),
      new x509.Extension(NAME_CONSTRAINTS, true, encodeConstraints(constraints)),
    ],
  })
  const keyPem = privateKeyPem(keys.privateKey)
  await writePrivate(path.join(options.dir, CA_KEY), keyPem, options)
  await writePrivate(path.join(options.dir, CA_CERT), parsed.toString('pem'), options)
  return { cert: new crypto.X509Certificate(Buffer.from(parsed.rawData)), parsed, keyPem, constraints }
}

async function issueLeaf(options: CertificateOptions, ca: Authority, names: Names, now: Date): Promise<Leaf> {
  const keys = await crypto.webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])
  const caKey = crypto.createPrivateKey(ca.keyPem).export({ type: 'pkcs8', format: 'der' })
  const signingKey = await crypto.webcrypto.subtle.importKey('pkcs8', caKey, ALGORITHM, false, ['sign'])
  const authorityKeyId = ca.parsed.getExtension(x509.SubjectKeyIdentifierExtension)?.keyId
  const parsed = await x509.X509CertificateGenerator.create({
    serialNumber: serialNumber(),
    subject: [{ CN: [`Binder on ${options.computerName ?? os.hostname()}`] }],
    issuer: ca.parsed.subjectName,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(Math.min(now.getTime() + LEAF_DAYS * DAY_MS, ca.parsed.notAfter.getTime())),
    publicKey: keys.publicKey as CryptoKey,
    signingKey: signingKey as CryptoKey,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      // A URL with an address in it sends no name to choose a certificate by, so one covers every address.
      new x509.SubjectAlternativeNameExtension([
        ...names.addresses.map((value) => ({ type: 'ip' as const, value })),
        ...names.hostnames.map((value) => ({ type: 'dns' as const, value })),
      ]),
      ...(authorityKeyId ? [new x509.AuthorityKeyIdentifierExtension(authorityKeyId)] : []),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey as CryptoKey),
    ],
  })
  const keyPem = privateKeyPem(keys.privateKey)
  await writePrivate(path.join(options.dir, LEAF_KEY), keyPem, options)
  await writePrivate(path.join(options.dir, LEAF_CERT), parsed.toString('pem'), options)
  return { cert: new crypto.X509Certificate(Buffer.from(parsed.rawData)), parsed, keyPem }
}

const privateKeyPem = (key: crypto.webcrypto.CryptoKey) =>
  crypto.KeyObject.from(key).export({ type: 'pkcs8', format: 'pem' }).toString()

/** A random 16-byte serial number, positive and without a leading zero byte (DER's rules for an integer). */
function serialNumber(): string {
  const bytes = crypto.randomBytes(16)
  bytes[0] = (bytes[0]! & 0x7f) | 0x40
  return bytes.toString('hex')
}

// Which names an authority may vouch for

/** Name constraints' permitted subtrees: IPv4 ranges (an address and its mask), and DNS names. */
interface Constraints {
  ranges: Array<{ address: Uint8Array; mask: Uint8Array }>
  /** Each permits itself and every name under it (`local` permits `desktop-abc.local`), as RFC 5280 has it. */
  dnsNames: string[]
}

function range(address: string, bits: number): Constraints['ranges'][number] {
  const mask = [0, 1, 2, 3].map((i) => (0xff << (8 - Math.max(0, Math.min(8, bits - 8 * i)))) & 0xff)
  return { address: Uint8Array.from(address.split('.').map(Number)), mask: Uint8Array.from(mask) }
}

/** A hostname in lower case without a trailing dot, if it's one a certificate can name; else null. */
function asHostname(name: string): string | null {
  const host = name.trim().toLowerCase().replace(/\.$/, '')
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  return host.length <= 253 && host.split('.').every((part) => label.test(part)) ? host : null
}

/**
 * The DNS names a new authority may vouch for: `local`, mDNS's domain, which names only devices on this network
 * (`<hostname>.local` among them), and the PC's other names. A single-label name that could be a top-level domain on
 * the internet (letters only, or an internationalized `xn--` one) is left out: a PC named `gaming` would otherwise let
 * the authority vouch for every site under .gaming. Windows' own names (DESKTOP-1A2B3C) have a hyphen or a digit, which
 * no other top-level domain has.
 */
function authorityNames(hostnames: readonly string[]): string[] {
  const names = new Set(['local'])
  for (const name of hostnames.map(asHostname)) {
    if (!name || name === 'local' || name.endsWith('.local')) continue
    if (!name.includes('.') && (/^[a-z]+$/.test(name) || name.startsWith('xn--'))) continue
    names.add(name)
  }
  return [...names]
}

function permitsAddress(constraints: Constraints, address: string): boolean {
  if (!net.isIPv4(address)) return false
  const bytes = address.split('.').map(Number)
  return constraints.ranges.some((r) => bytes.every((byte, i) => (byte & r.mask[i]!) === r.address[i]))
}

const permitsName = (constraints: Constraints, name: string) =>
  constraints.dnsNames.some((permitted) => name === permitted || name.endsWith(`.${permitted}`))

/** The addresses and names a server certificate from this authority covers: 127.0.0.1, and those it may vouch for. */
function coveredNames(constraints: Constraints, addresses: readonly string[], hostnames: readonly string[]): Names {
  const ips = [...addresses.map((a) => a.trim()), '127.0.0.1'].filter((a) => permitsAddress(constraints, a))
  const names = hostnames.map(asHostname).filter((n): n is string => n !== null && permitsName(constraints, n))
  return { addresses: [...new Set(ips)], hostnames: [...new Set(names)] }
}

// The name constraints extension, in DER. @peculiar/x509 has no builder for it, and its ASN.1 package isn't one of
// Binder's own dependencies, so the few bytes are written and read here:
//   NameConstraints ::= SEQUENCE { permittedSubtrees [0] GeneralSubtrees }
//   GeneralSubtrees ::= SEQUENCE OF GeneralSubtree, GeneralSubtree ::= SEQUENCE { base GeneralName }
//   GeneralName: iPAddress [7] (address and mask), dNSName [2] (IA5String)

const SEQUENCE = 0x30
const PERMITTED = 0xa0
const IP_ADDRESS = 0x87
const DNS_NAME = 0x82

function der(tag: number, ...contents: Uint8Array[]): Buffer<ArrayBuffer> {
  const body = Buffer.concat(contents)
  const n = body.length
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]
  return Buffer.concat([Uint8Array.from([tag, ...length]), body])
}

function encodeConstraints({ ranges, dnsNames }: Constraints): Buffer<ArrayBuffer> {
  const subtrees = [
    ...ranges.map((r) => der(SEQUENCE, der(IP_ADDRESS, r.address, r.mask))),
    ...dnsNames.map((name) => der(SEQUENCE, der(DNS_NAME, Buffer.from(name, 'ascii')))),
  ]
  return der(SEQUENCE, der(PERMITTED, ...subtrees))
}

/** The elements in a run of DER, each its tag and contents (lengths up to 64 KB, all Binder writes). */
function elements(bytes: Uint8Array): Array<{ tag: number; contents: Uint8Array }> {
  const found: Array<{ tag: number; contents: Uint8Array }> = []
  let at = 0
  const next = () => {
    if (at >= bytes.length) throw new Error('Damaged name constraints')
    return bytes[at++]!
  }
  while (at < bytes.length) {
    const tag = next()
    let length = next()
    if (length === 0x81) length = next()
    else if (length === 0x82) length = next() * 256 + next()
    else if (length >= 0x80) throw new Error('Damaged name constraints')
    if (at + length > bytes.length) throw new Error('Damaged name constraints')
    found.push({ tag, contents: bytes.subarray(at, at + length) })
    at += length
  }
  return found
}

/** Reads constraints written by encodeConstraints. Throws on anything else, such as excluded subtrees. */
function decodeConstraints(value: Uint8Array): Constraints {
  const [outer, ...rest] = elements(value)
  if (outer?.tag !== SEQUENCE || rest.length > 0) throw new Error('Not name constraints')
  const constraints: Constraints = { ranges: [], dnsNames: [] }
  for (const part of elements(outer.contents)) {
    if (part.tag !== PERMITTED) throw new Error('Name constraints Binder never writes')
    for (const subtree of elements(part.contents)) {
      const [base, ...bounds] = subtree.tag === SEQUENCE ? elements(subtree.contents) : []
      if (!base || bounds.length > 0) throw new Error('Name constraints Binder never writes')
      if (base.tag === IP_ADDRESS && base.contents.length === 8) {
        constraints.ranges.push({ address: base.contents.subarray(0, 4), mask: base.contents.subarray(4) })
      } else if (base.tag === DNS_NAME) {
        constraints.dnsNames.push(Buffer.from(base.contents).toString('ascii'))
      } else {
        throw new Error('Name constraints Binder never writes')
      }
    }
  }
  return constraints
}

// Writing the files

/** Each folder's calls, one after another, so two never write its files at once. */
const queues = new Map<string, Promise<unknown>>()

function oneAtATime<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir)
  const result = (queues.get(key) ?? Promise.resolve()).then(task, task)
  queues.set(key, result.catch(() => undefined))
  return result
}

const execFileAsync = promisify(execFile)

/** Windows' own tools, by full path, so a program of the same name elsewhere on the PATH is never run instead. */
const windowsTool = (name: string) =>
  path.win32.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', name)

let userSid: string | undefined

/**
 * On Windows, makes `file` readable and writable by the current user alone, as the API key's file is
 * (ai/key-store.ts): its inherited entries are removed, and the user, by their security identifier, given full control.
 */
async function ownerOnlyOnWindows(file: string): Promise<void> {
  if (!userSid) {
    // `whoami /user /fo csv /nh` prints `"pc\name","S-1-5-21-…"`.
    const { stdout } = await execFileAsync(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
    userSid = /"(S-1-[\d-]+)"\s*$/.exec(stdout.trim())?.[1]
    if (!userSid) throw new Error("whoami didn't say who the current user is")
  }
  await execFileAsync(windowsTool('icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${userSid}:F`], {
    windowsHide: true,
  })
}

/**
 * Writes a file only its owner can read, through a temporary copy renamed over it, so a crash never leaves half a
 * key or certificate: mode 600, and on Windows, where mode bits don't exist, an access list with the current user
 * alone, set while the copy is still empty (best effort: when it can't be, the reason is logged).
 */
async function writePrivate(file: string, contents: string, options: CertificateOptions): Promise<void> {
  const { platform = process.platform, ownerOnly = ownerOnlyOnWindows } = options
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    if (platform === 'win32') {
      await fs.promises.writeFile(temp, '', { flag: 'wx' })
      try {
        await ownerOnly(temp)
      } catch (err) {
        console.error(`[phone] Couldn't make ${temp} private to this user: ${err instanceof Error ? err.message : String(err)}`)
      }
      await fs.promises.writeFile(temp, contents)
      if (fs.existsSync(file)) await fs.promises.chmod(file, 0o666) // Windows won't rename over a read-only file
    } else {
      await fs.promises.writeFile(temp, contents, { flag: 'wx', mode: 0o600 })
      await fs.promises.chmod(temp, 0o600) // exactly 600, whatever the umask took away
    }
    await renameWithRetryAsync(temp, file, { platform })
  } catch (err) {
    try {
      removeWithRetry(temp, { platform }) // it may hold a key
    } catch {
      // The next call removes it (removeLeftovers); the write's own failure is the one to report.
    }
    throw err
  }
}

/** Whether `pid` is another process that is still running: a signal 0 reaches it, or it exists but isn't ours. */
function otherProcessRunning(pid: number): boolean {
  if (pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes the temporary copies writes leave when a crash stops them between writing and renaming
 * (`<file>.<pid>.<random>.tmp`), which can hold a key; one another running Binder is still writing is left to it.
 * Calls in this process don't overlap, so none of its own is in progress. Best effort.
 */
function removeLeftovers(dir: string): void {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const pid = /^(?:ca|ca-key|leaf|leaf-key)\.pem\.(\d+)\.[0-9a-f]+\.tmp$/.exec(entry)?.[1]
      if (pid !== undefined && !otherProcessRunning(Number(pid))) fs.rmSync(path.join(dir, entry), { force: true })
    }
  } catch {
    // The folder can't be read: the write that follows says why.
  }
}
