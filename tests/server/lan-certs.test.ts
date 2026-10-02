import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  ensureCertificates,
  readAuthority,
  rotateAuthority,
  type CertificateOptions,
  type RunToolAsync,
} from '../../src/server/lan/certs.ts'
import type { RunTool } from '../../src/server/owner-only.ts'
import { expectOwnerOnly } from '../helpers/private.ts'
import { tempDir } from '../helpers/tmp.ts'

const DAY = 86_400_000
const NOW = new Date('2026-10-02T12:00:00Z')
const FILES = ['ca-key.pem', 'ca.pem', 'leaf-key.pem', 'leaf.pem']
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }

/** Options for a PC at 192.168.1.5 named DESKTOP-ABC1, its files in a `lan` folder not made yet. */
function options(overrides: Partial<CertificateOptions> = {}): CertificateOptions {
  return {
    dir: path.join(tempDir('binder-lan-'), 'lan'),
    addresses: ['192.168.1.5'],
    hostnames: ['DESKTOP-ABC1', 'desktop-abc1.local'],
    computerName: 'DESKTOP-ABC1',
    ...overrides,
  }
}

/** The PEM blocks in a chain, in order. */
const pemBlocks = (pem: string) => pem.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? []

/** Serves `key` and `cert` over HTTPS on 127.0.0.1 (never a network address, which would ask the firewall). */
async function serve(key: string, cert: string): Promise<number> {
  const server = https.createServer({ key, cert }, (_req, res) => res.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return (server.address() as AddressInfo).port
}

/**
 * What a client that trusts only `ca` gets from the server on `port`, checking that it's the server for `as`, as a
 * phone that opened https://<as>:<port> does.
 */
function fetchAs(port: number, ca: string, as: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      host: '127.0.0.1',
      port,
      ca,
      agent: false,
      checkServerIdentity: (_host: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(as, cert),
    }
    https
      .get(options, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve(body))
      })
      .on('error', reject)
  })
}

/** A server certificate for `names` signed with the authority's own key, as someone who took the key would make. */
async function forged(dir: string, names: x509.JsonGeneralNames): Promise<{ key: string; cert: string }> {
  const caPem = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8')
  const caKey = crypto.createPrivateKey(fs.readFileSync(path.join(dir, 'ca-key.pem'))).export({ type: 'pkcs8', format: 'der' })
  const signingKey = await crypto.webcrypto.subtle.importKey('pkcs8', caKey, ALGORITHM, false, ['sign'])
  const keys = await crypto.webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])
  const leaf = await x509.X509CertificateGenerator.create({
    subject: 'CN=forged',
    issuer: new x509.X509Certificate(caPem).subjectName,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + DAY),
    publicKey: keys.publicKey as CryptoKey,
    signingKey: signingKey as CryptoKey,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.SubjectAlternativeNameExtension(names),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
    ],
  })
  return {
    key: crypto.KeyObject.from(keys.privateKey).export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `${leaf.toString('pem')}\n${caPem}`,
  }
}

/** Whether the chain served is whole: its key is the server certificate's, which the authority signed. */
function expectWholeChain(result: { key: string; cert: string; caPem: string }) {
  const [leafPem, caPem] = pemBlocks(result.cert)
  const leaf = new crypto.X509Certificate(leafPem!)
  const ca = new crypto.X509Certificate(result.caPem)
  expect(new crypto.X509Certificate(caPem!).fingerprint256).toBe(ca.fingerprint256)
  expect(leaf.checkPrivateKey(crypto.createPrivateKey(result.key))).toBe(true)
  expect(leaf.verify(ca.publicKey)).toBe(true)
}

describe('certificates for phone access over HTTPS (lan/certs)', () => {
  it('makes an authority limited to private addresses and local names, and a server certificate from it', async () => {
    const o = options()
    const result = await ensureCertificates({ ...o, now: NOW })
    expect(result).toMatchObject({
      caName: 'Binder on DESKTOP-ABC1 (2026-10-02)',
      addresses: ['192.168.1.5', '127.0.0.1'],
      hostnames: ['desktop-abc1', 'desktop-abc1.local'],
      expiresAt: new Date(NOW.getTime() + 396 * DAY), // 397 days from the day before
      reissued: true,
      authority: 'created',
    })

    const ca = new x509.X509Certificate(fs.readFileSync(path.join(o.dir, 'ca.pem'), 'utf8'))
    expect(ca.subjectName.getField('O')).toEqual(['Binder'])
    expect(ca.subjectName.getField('CN')).toEqual(['Binder on DESKTOP-ABC1 (2026-10-02)'])
    expect(ca.issuer).toBe(ca.subject)
    expect(ca.notBefore).toEqual(new Date('2026-10-01T12:00:00Z'))
    expect(ca.notAfter).toEqual(new Date('2036-10-02T12:00:00Z'))
    const basic = ca.getExtension(x509.BasicConstraintsExtension)!
    expect([basic.critical, basic.ca, basic.pathLength]).toEqual([true, true, 0])
    const usage = ca.getExtension(x509.KeyUsagesExtension)!
    expect([usage.critical, usage.usages]).toEqual([true, x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign])
    // Server certificates alone: no certificate from it is good for mail or signing code.
    expect(ca.getExtension(x509.ExtendedKeyUsageExtension)!.usages).toEqual([x509.ExtendedKeyUsage.serverAuth])
    const keyId = ca.getExtension(x509.SubjectKeyIdentifierExtension)!.keyId
    expect(keyId).toMatch(/^[0-9a-f]{40}$/)
    const constraints = ca.getExtension('2.5.29.30')!
    expect(constraints.critical).toBe(true)
    // NameConstraints { permittedSubtrees [0] { iPAddress [7] address+mask, …, dNSName [2] name, …, rfc822Name [1]
    // and uniformResourceIdentifier [6] `invalid`, which no email address or URI is at } }
    expect(Buffer.from(constraints.value).toString('hex')).toBe(
      [
        '3061', 'a05f',
        '300a8708', '0a000000', 'ff000000', // 10.0.0.0/8
        '300a8708', 'ac100000', 'fff00000', // 172.16.0.0/12
        '300a8708', 'c0a80000', 'ffff0000', // 192.168.0.0/16
        '300a8708', '7f000000', 'ff000000', // 127.0.0.0/8
        '30078205', Buffer.from('local').toString('hex'),
        '300e820c', Buffer.from('desktop-abc1').toString('hex'),
        '30098107', Buffer.from('invalid').toString('hex'),
        '30098607', Buffer.from('invalid').toString('hex'),
      ].join(''),
    )

    const [leafPem, chainCaPem] = pemBlocks(result.cert)
    const leaf = new x509.X509Certificate(leafPem!)
    expect(leaf.issuer).toBe(ca.subject)
    expect(leaf.notBefore).toEqual(new Date('2026-10-01T12:00:00Z'))
    expect(leaf.notAfter).toEqual(new Date('2027-11-02T12:00:00Z'))
    const leafBasic = leaf.getExtension(x509.BasicConstraintsExtension)!
    expect([leafBasic.critical, leafBasic.ca]).toEqual([true, false])
    const leafUsage = leaf.getExtension(x509.KeyUsagesExtension)!
    expect([leafUsage.critical, leafUsage.usages]).toEqual([true, x509.KeyUsageFlags.digitalSignature])
    expect(leaf.getExtension(x509.ExtendedKeyUsageExtension)!.usages).toEqual([x509.ExtendedKeyUsage.serverAuth])
    expect(leaf.getExtension(x509.SubjectAlternativeNameExtension)!.names.toJSON()).toEqual([
      { type: 'ip', value: '192.168.1.5' },
      { type: 'ip', value: '127.0.0.1' },
      { type: 'dns', value: 'desktop-abc1' },
      { type: 'dns', value: 'desktop-abc1.local' },
    ])
    expect(leaf.getExtension(x509.AuthorityKeyIdentifierExtension)!.keyId).toBe(keyId)

    // What the phone installs, and how the PC shows it to compare.
    expect(chainCaPem).toBe(pemBlocks(result.caPem)[0])
    expect(Buffer.from(result.caDer)).toEqual(Buffer.from(ca.rawData))
    const digest = crypto.createHash('sha256').update(result.caDer).digest('hex').toUpperCase()
    expect(result.caFingerprint).toBe(digest.match(/../g)!.join(':'))
    expect(result.leafFingerprint).toBe(new crypto.X509Certificate(leafPem!).fingerprint256)
    expectWholeChain(result)

    expect(fs.readdirSync(o.dir).sort()).toEqual(FILES)
    for (const file of FILES) expectOwnerOnly(path.join(o.dir, file))
    // Each file ends in a newline, so the two certificates joined are the chain too.
    const read = (file: string) => fs.readFileSync(path.join(o.dir, file), 'utf8')
    expect(read('leaf.pem') + read('ca.pem')).toBe(result.cert)
  })

  it('serves HTTPS a client trusting only the authority accepts, for the addresses it names and no others', async () => {
    const result = await ensureCertificates(options())
    const port = await serve(result.key, result.cert)
    expect(await fetchAs(port, result.caPem, '127.0.0.1')).toBe('ok')
    expect(await fetchAs(port, result.caPem, '192.168.1.5')).toBe('ok')
    expect(await fetchAs(port, result.caPem, 'desktop-abc1.local')).toBe('ok')
    await expect(fetchAs(port, result.caPem, '192.168.1.9')).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    // A client with only the public authorities (a phone that hasn't installed Binder's) doesn't trust it.
    await expect(fetchAs(port, tls.rootCertificates.join('\n'), '127.0.0.1')).rejects.toMatchObject({
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    })
  })

  it("can't vouch for a public address or name, even signed with its own key", async () => {
    const o = options()
    const { caPem } = await ensureCertificates(o)
    const refused = [
      [{ type: 'dns', value: 'example.com' }],
      [{ type: 'ip', value: '8.8.8.8' }],
      [{ type: 'dns', value: 'desktop-abc1.example.com' }],
      // One name outside the constraints spoils a certificate's others.
      [{ type: 'ip', value: '192.168.1.5' }, { type: 'dns', value: 'example.com' }],
      // No email address or URI at all (a phone's mail app would trust one for signed mail).
      [{ type: 'ip', value: '192.168.1.5' }, { type: 'email', value: 'someone@example.com' }],
      [{ type: 'ip', value: '192.168.1.5' }, { type: 'url', value: 'https://example.com/' }],
    ] as const
    for (const names of refused) {
      const fake = await forged(o.dir, [...names])
      const port = await serve(fake.key, fake.cert)
      await expect(fetchAs(port, caPem, names[0].value)).rejects.toThrow(/permitted subtree violation/)
    }
    // Inside them, the same forgery is trusted: the constraints are what refused the others.
    const inside = await forged(o.dir, [{ type: 'ip', value: '10.1.2.3' }, { type: 'dns', value: 'printer.local' }])
    const port = await serve(inside.key, inside.cert)
    expect(await fetchAs(port, caPem, '10.1.2.3')).toBe('ok')
  })

  it('keeps both while nothing changes, and issues a server certificate from the same authority for a new address', async () => {
    const o = options()
    const first = await ensureCertificates(o)
    const again = await ensureCertificates(o)
    expect(again).toMatchObject({ reissued: false, authority: 'kept', key: first.key, cert: first.cert })
    expect(again.caFingerprint).toBe(first.caFingerprint)

    const moved = await ensureCertificates({ ...o, addresses: ['192.168.1.7'] })
    expect(moved).toMatchObject({ reissued: true, authority: 'kept', addresses: ['192.168.1.7', '127.0.0.1'] })
    expect(moved.caFingerprint).toBe(first.caFingerprint)
    expect(moved.leafFingerprint).not.toBe(first.leafFingerprint)
    // A phone keeps the authority it installed.
    const port = await serve(moved.key, moved.cert)
    expect(await fetchAs(port, first.caPem, '192.168.1.7')).toBe('ok')
    await expect(fetchAs(port, first.caPem, '192.168.1.5')).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    // The same addresses in another order are the same certificate.
    const both = await ensureCertificates({ ...o, addresses: ['192.168.1.7', '10.0.0.4'] })
    expect((await ensureCertificates({ ...o, addresses: ['10.0.0.4', '192.168.1.7'] })).reissued).toBe(false)
    expect(both.reissued).toBe(true)
  })

  it('issues a server certificate with fewer than 30 days left, and a new authority near the end of its 10 years', async () => {
    const o = options()
    const at = (days: number) => ({ ...o, now: new Date(NOW.getTime() + days * DAY) })
    const first = await ensureCertificates(at(0))
    expect(await ensureCertificates(at(366))).toMatchObject({ reissued: false, authority: 'kept' })
    const renewed = await ensureCertificates(at(367))
    expect(renewed).toMatchObject({ reissued: true, authority: 'kept', expiresAt: new Date(NOW.getTime() + 763 * DAY) })
    expect(renewed.caFingerprint).toBe(first.caFingerprint)

    // The authority lasts until 2036-10-02: a server certificate never outlasts it, and with 30 days left it's replaced.
    const end = new Date('2036-10-02T12:00:00Z').getTime()
    const late = await ensureCertificates({ ...o, now: new Date(end - 100 * DAY) })
    expect(late).toMatchObject({ authority: 'kept', expiresAt: new Date(end) })
    const replaced = await ensureCertificates({ ...o, now: new Date(end - 29 * DAY) })
    expect(replaced).toMatchObject({ reissued: true, authority: 'replaced' })
    expect(replaced.caFingerprint).not.toBe(first.caFingerprint)
  })

  it('rotates the authority: a new one phones must install again, and a server certificate from it', async () => {
    const o = options()
    const first = await ensureCertificates(o)
    const rotated = await rotateAuthority(o)
    expect(rotated).toMatchObject({ reissued: true, authority: 'replaced' })
    expect(rotated.caFingerprint).not.toBe(first.caFingerprint)
    expectWholeChain(rotated)
    expect(readAuthority(o.dir)?.caFingerprint).toBe(rotated.caFingerprint)
    expect(await ensureCertificates(o)).toMatchObject({
      reissued: false,
      authority: 'kept',
      caFingerprint: rotated.caFingerprint,
    })

    const port = await serve(rotated.key, rotated.cert)
    expect(await fetchAs(port, rotated.caPem, '192.168.1.5')).toBe('ok')
    await expect(fetchAs(port, first.caPem, '192.168.1.5')).rejects.toMatchObject({
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    })
    // Rotating with none there makes the first.
    expect(await rotateAuthority(options())).toMatchObject({ authority: 'created' })
  })

  it('issues a server certificate again when its files are missing, damaged or mismatched, keeping the authority', async () => {
    const o = options()
    const first = await ensureCertificates(o)
    const damages: Array<() => void> = [
      () => fs.writeFileSync(path.join(o.dir, 'leaf.pem'), 'not a certificate'),
      () => fs.rmSync(path.join(o.dir, 'leaf-key.pem')),
      () => fs.copyFileSync(path.join(o.dir, 'ca-key.pem'), path.join(o.dir, 'leaf-key.pem')),
      () => fs.writeFileSync(path.join(o.dir, 'leaf.pem'), fs.readFileSync(path.join(o.dir, 'leaf.pem')).subarray(0, 300)),
    ]
    for (const damage of damages) {
      damage()
      const result = await ensureCertificates(o)
      expect(result).toMatchObject({ reissued: true, authority: 'kept', caFingerprint: first.caFingerprint })
      expectWholeChain(result)
    }
    // A server certificate from another authority (the files of another library) isn't this one's.
    const other = options()
    await ensureCertificates(other)
    for (const file of ['leaf.pem', 'leaf-key.pem']) fs.copyFileSync(path.join(other.dir, file), path.join(o.dir, file))
    expect(await ensureCertificates(o)).toMatchObject({ reissued: true, authority: 'kept', caFingerprint: first.caFingerprint })
  })

  it('makes a new authority when its files are missing, damaged or mismatched, or it lacks one of its limits', async () => {
    const o = options()
    /** An authority like Binder's but for its extensions, which `extensions` makes from the one in place. */
    const authorityWith = (extensions: (ca: x509.X509Certificate) => x509.Extension[]) => async () => {
      const current = new x509.X509Certificate(fs.readFileSync(path.join(o.dir, 'ca.pem'), 'utf8'))
      const keys = await crypto.webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])
      const ca = await x509.X509CertificateGenerator.createSelfSigned({
        name: 'CN=Binder on DESKTOP-ABC1',
        keys: keys as CryptoKeyPair,
        signingAlgorithm: ALGORITHM,
        extensions: [new x509.BasicConstraintsExtension(true, 0, true), ...extensions(current)],
      })
      fs.writeFileSync(path.join(o.dir, 'ca.pem'), ca.toString('pem'))
      fs.writeFileSync(
        path.join(o.dir, 'ca-key.pem'),
        crypto.KeyObject.from(keys.privateKey).export({ type: 'pkcs8', format: 'pem' }),
      )
    }
    const serverOnly = new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth])
    const constraints = (value: string) => new x509.Extension('2.5.29.30', true, Buffer.from(value, 'hex'))
    const hex = (text: string) => Buffer.from(text).toString('hex')
    const damages: Array<() => void | Promise<void>> = [
      () => fs.writeFileSync(path.join(o.dir, 'ca.pem'), 'not a certificate'),
      () => fs.rmSync(path.join(o.dir, 'ca-key.pem')),
      () => fs.copyFileSync(path.join(o.dir, 'leaf-key.pem'), path.join(o.dir, 'ca-key.pem')),
      () => fs.copyFileSync(path.join(o.dir, 'leaf.pem'), path.join(o.dir, 'ca.pem')), // not an authority
      authorityWith(() => [serverOnly]), // no name constraints
      // Addresses (10/8) and names (local) constrained, but not email addresses or URIs.
      authorityWith(() => [serverOnly, constraints('3017a015300a87080a000000ff00000030078205' + hex('local'))]),
      authorityWith((current) => [current.getExtension('2.5.29.30')!]), // good for mail or signing code
    ]
    let before = (await ensureCertificates(o)).caFingerprint
    for (const damage of damages) {
      await damage()
      expect(readAuthority(o.dir)).toBeNull()
      const result = await ensureCertificates(o)
      expect(result).toMatchObject({ reissued: true, authority: 'replaced' })
      expect(result.caFingerprint).not.toBe(before)
      expectWholeChain(result)
      before = result.caFingerprint
    }
  })

  it("keeps the authority through a PC clock set back, and replaces nothing when a file can't be read", async () => {
    const o = options()
    const first = await ensureCertificates({ ...o, now: NOW })
    // A flat CMOS battery, or a clock set by hand: days or years behind, it's still the authority phones installed.
    for (const behind of [2 * DAY, 5 * 365 * DAY]) {
      const now = new Date(NOW.getTime() - behind)
      expect(await ensureCertificates({ ...o, now })).toMatchObject({ authority: 'kept', caFingerprint: first.caFingerprint })
      expect(readAuthority(o.dir, now)?.caFingerprint).toBe(first.caFingerprint)
    }
    const fixed = await ensureCertificates({ ...o, now: NOW })
    expect(fixed).toMatchObject({ authority: 'kept', caFingerprint: first.caFingerprint })

    // A file there that another program holds (antivirus, on Windows) fails the call; it isn't a missing one.
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    const read = vi.spyOn(fs, 'readFileSync')
    onTestFinished(() => read.mockRestore())
    read.mockImplementationOnce(() => {
      throw busy
    })
    await expect(ensureCertificates({ ...o, now: NOW })).rejects.toBe(busy)
    read.mockImplementationOnce(() => {
      throw busy
    })
    expect(() => readAuthority(o.dir, NOW)).toThrow(busy)
    read.mockRestore()
    expect(await ensureCertificates({ ...o, now: NOW })).toMatchObject({
      authority: 'kept',
      reissued: false,
      caFingerprint: first.caFingerprint,
      leafFingerprint: fixed.leafFingerprint,
    })
  })

  it("leaves out of the server certificate what the authority can't vouch for, and a name it wasn't made for", async () => {
    const o = options({
      addresses: ['8.8.8.8', ' 192.168.1.5 ', '100.64.0.1', '169.254.3.4', 'fe80::1', '10.0.0.2', 'nonsense', '192.168.1.5'],
      hostnames: ['gaming', 'xn--p1ai', 'localhost', 'DESKTOP-ABC1.', 'desktop_abc1', 'Desktop-ABC1.local', 'mypc.lan'],
    })
    const result = await ensureCertificates(o)
    expect(result.addresses).toEqual(['192.168.1.5', '10.0.0.2', '127.0.0.1'])
    expect(result.hostnames).toEqual(['desktop-abc1', 'desktop-abc1.local', 'mypc.lan'])
    // A single label that could be a top-level domain would let the authority vouch for that whole domain.
    const constraints = Buffer.from(new x509.X509Certificate(result.caPem).getExtension('2.5.29.30')!.value)
    for (const name of ['local', 'desktop-abc1', 'mypc.lan']) expect(constraints.includes(name)).toBe(true)
    for (const name of ['gaming', 'xn--p1ai', 'localhost']) expect(constraints.includes(name)).toBe(false)

    // Renamed, the PC keeps its authority (phones keep working at its address), and its new .local name.
    const renamed = await ensureCertificates({ ...o, hostnames: ['NEWNAME-2', 'newname-2.local'] })
    expect(renamed).toMatchObject({ authority: 'kept', reissued: true, hostnames: ['newname-2.local'] })
    expect(renamed.caFingerprint).toBe(result.caFingerprint)
  })

  it('reads the authority for the setup page: null when there is none, or none that can be used', async () => {
    const o = options()
    expect(readAuthority(o.dir)).toBeNull()
    const result = await ensureCertificates(o)
    expect(readAuthority(o.dir)).toEqual({
      caPem: result.caPem,
      caDer: result.caDer,
      caFingerprint: result.caFingerprint,
      caName: result.caName,
    })
    fs.rmSync(path.join(o.dir, 'ca-key.pem'))
    expect(readAuthority(o.dir)).toBeNull()
  })

  it('writes one call at a time, so calls made together leave a server certificate that matches its key', async () => {
    const o = options()
    const [first, second] = await Promise.all([
      ensureCertificates(o),
      ensureCertificates({ ...o, addresses: ['192.168.1.7'] }),
    ])
    expect(first.authority).toBe('created')
    expect(second).toMatchObject({ authority: 'kept', reissued: true, caFingerprint: first.caFingerprint })
    const leaf = new crypto.X509Certificate(fs.readFileSync(path.join(o.dir, 'leaf.pem')))
    expect(leaf.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(path.join(o.dir, 'leaf-key.pem'))))).toBe(true)
    expect(leaf.subjectAltName).toBe('IP Address:192.168.1.7, IP Address:127.0.0.1, DNS:desktop-abc1, DNS:desktop-abc1.local')
  })

  it('removes the temporary copies a crashed write left, but not one another running Binder is writing', async () => {
    const o = options()
    fs.mkdirSync(o.dir)
    const leftovers = [`ca-key.pem.${process.pid}.tmp`, 'leaf-key.pem.999999999.tmp']
    const kept = [`ca-key.pem.${process.ppid}.tmp`, 'notes.txt']
    for (const file of [...leftovers, ...kept]) fs.writeFileSync(path.join(o.dir, file), 'a key')
    await ensureCertificates(o)
    expect(fs.readdirSync(o.dir).sort()).toEqual([...FILES, ...kept].sort())
  })

  it("on Windows, makes each file private to its owner while it's still empty, then renames it into place", async () => {
    const o = options({ platform: 'win32' })
    const restricted: Array<{ name: string; size: number; grant: string | undefined }> = []
    // Windows' tools, as owner-only.ts runs them: whoami for the user's SID, then icacls on each file.
    const run = vi.fn<RunTool>((command, args) => {
      if (command.endsWith('whoami.exe')) return '"desktop-abc1\\me","S-1-5-21-1-2-3-1001"\r\n'
      restricted.push({ name: path.basename(args[0]!), size: fs.statSync(args[0]!).size, grant: args[3] })
      return ''
    })
    await ensureCertificates({ ...o, run })
    expect(restricted.map((r) => r.name.replace(/\.\d+\.tmp$/, ''))).toEqual(FILES)
    expect(restricted.every((r) => r.size === 0 && r.grant === '*S-1-5-21-1-2-3-1001:F')).toBe(true)
    expect(fs.readdirSync(o.dir).sort()).toEqual(FILES)

    // When Windows' tools can't, the files are still written, and the reason logged.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => error.mockRestore())
    const failing = vi.fn<RunTool>(() => {
      throw new Error('icacls failed')
    })
    const rotated = await rotateAuthority({ ...o, run: failing })
    expect(error).toHaveBeenCalledTimes(4)
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[phone\] Couldn't make .*ca-key\.pem\..* private to this user: icacls failed$/),
    )
    expectWholeChain(rotated)
    expect(fs.readdirSync(o.dir).sort()).toEqual(FILES)
  })

  it('on Windows, asks who the user is once, and waits for its tools and for files held open, as Binder goes on', async () => {
    const o = options({ platform: 'win32' })
    // Windows' tools answering later, as they do when run without blocking.
    const user = '"desktop-abc1\\me","S-1-5-21-1-2-3-1001"\r\n'
    const run = vi.fn<RunToolAsync>(async (command) => (command.endsWith('whoami.exe') ? user : ''))
    await ensureCertificates({ ...o, run })
    await ensureCertificates({ ...o, addresses: ['192.168.1.7'], run })
    const runs = (tool: string) => run.mock.calls.filter(([command]) => path.win32.basename(command) === tool).length
    expect([runs('whoami.exe'), runs('icacls.exe')]).toEqual([1, 6])

    // Antivirus scanning a file just written: it's renamed into place once let go, and Binder serves meanwhile.
    const rename = fs.promises.rename
    const order: string[] = []
    const held = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (order.length > 0) return rename(from, to)
      order.push('held')
      setTimeout(() => order.push('Binder went on'), 0)
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    })
    onTestFinished(() => held.mockRestore())
    const rotated = await rotateAuthority({ ...o, run })
    expect(order).toEqual(['held', 'Binder went on'])
    expect(held).toHaveBeenCalledTimes(5)
    expectWholeChain(rotated)
    expect(fs.readdirSync(o.dir).sort()).toEqual(FILES)
  })
})
