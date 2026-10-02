import type os from 'node:os'
import { describe, expect, it } from 'vitest'
import { ADDRESS_POLL_MS, createAddressBook, isLoopback, isPrivateIPv4, lanAddresses, plainAddress } from '../../src/server/lan/addresses.ts'
import { createRateLimiter } from '../../src/server/lan/rate-limit.ts'
import { ipv4 } from '../helpers/app.ts'

const ipv6 = (address: string): os.NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: `${address}/64`,
  scopeid: 0,
})

describe("this PC's addresses for phones (spec §5.10)", () => {
  it('lists private IPv4 addresses, Wi-Fi first, then Ethernet, then the rest, with virtual adapters last', () => {
    // A Windows PC with Hyper-V, WSL, VirtualBox, a VPN, Bluetooth, and the Mobile hotspot on.
    const windows = {
      'vEthernet (Default Switch)': [ipv4('172.25.32.1', 20)],
      Ethernet: [ipv4('192.168.1.20', 24), ipv6('fe80::1')],
      'VirtualBox Host-Only Network': [ipv4('192.168.56.1', 24)],
      'Local Area Connection* 10': [ipv4('192.168.137.1', 24)],
      'Wi-Fi': [ipv4('192.168.1.21', 24), ipv6('fe80::2')],
      'vEthernet (WSL)': [ipv4('172.20.0.1', 20)],
      'Bluetooth Network Connection': [ipv4('169.254.10.10', 16)],
      'ProtonVPN TUN': [ipv4('10.2.0.2', 32)],
      'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', 8, true)],
    }
    expect(lanAddresses(windows)).toEqual([
      { address: '192.168.1.21', interface: 'Wi-Fi', recommended: true },
      { address: '192.168.1.20', interface: 'Ethernet', recommended: false },
      { address: '192.168.137.1', interface: 'Local Area Connection* 10', recommended: false },
      { address: '172.25.32.1', interface: 'vEthernet (Default Switch)', recommended: false },
      { address: '192.168.56.1', interface: 'VirtualBox Host-Only Network', recommended: false },
      { address: '172.20.0.1', interface: 'vEthernet (WSL)', recommended: false },
      { address: '10.2.0.2', interface: 'ProtonVPN TUN', recommended: false },
    ])
    // A Mac on the Wi-Fi (en0) with a VPN and Internet Sharing; a Linux PC with Docker.
    const mac = { lo0: [ipv4('127.0.0.1', 8, true)], utun4: [ipv4('10.8.0.2', 24)], en0: [ipv4('10.0.0.12', 24)], bridge100: [ipv4('192.168.2.1', 24)] }
    expect(lanAddresses(mac).map((a) => [a.interface, a.recommended])).toEqual([['en0', true], ['bridge100', false], ['utun4', false]])
    const linux = { docker0: [ipv4('172.17.0.1', 16)], 'br-1a2b': [ipv4('172.18.0.1', 16)], enp3s0: [ipv4('192.168.0.9', 24)], wlp2s0: [ipv4('192.168.0.10', 24)] }
    expect(lanAddresses(linux).map((a) => a.interface)).toEqual(['wlp2s0', 'enp3s0', 'docker0', 'br-1a2b'])
  })

  it('leaves out public, link-local and IPv6 addresses, and recommends none when only virtual adapters are left', () => {
    const odd = { eth0: [ipv4('203.0.113.7', 24), ipv4('169.254.1.2', 16), ipv6('2001:db8::1')], 'vEthernet (WSL)': [ipv4('172.20.0.1', 20)] }
    expect(lanAddresses(odd)).toEqual([{ address: '172.20.0.1', interface: 'vEthernet (WSL)', recommended: false }])
    expect(lanAddresses({})).toEqual([])
  })

  it('knows private networks and this computer', () => {
    expect(['10.0.0.1', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.1', '192.168.255.255'].every(isPrivateIPv4)).toBe(true)
    expect(['9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '192.169.0.1', '8.8.8.8', 'fd00::1', 'nope'].some(isPrivateIPv4)).toBe(false)
    expect(['127.0.0.1', '127.4.5.6', '::1', '::ffff:127.0.0.1'].every(isLoopback)).toBe(true)
    expect(['192.168.1.5', '::ffff:192.168.1.5', '::2', '128.0.0.1'].some(isLoopback)).toBe(false)
    expect([plainAddress('::ffff:192.168.1.40'), plainAddress('::FFFF:10.0.0.1'), plainAddress('fe80::1')]).toEqual(['192.168.1.40', '10.0.0.1', 'fe80::1'])
  })
})

describe('who may connect to the phones\' listener', () => {
  it('allows this computer and devices on its networks, not the internet, nor IPv6', () => {
    const book = createAddressBook({ interfaces: () => ({ 'Wi-Fi': [ipv4('192.168.1.5', 24)], vpn: [ipv4('10.8.0.2', 32)] }) })
    const allowed = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.40', '::ffff:192.168.1.254', '10.8.0.2']
    expect(allowed.filter((a) => !book.allows(a))).toEqual([])
    const refused = ['192.168.2.40', '10.8.0.3', '8.8.8.8', 'fe80::1', '2001:db8::1', undefined]
    expect(refused.filter((a) => book.allows(a))).toEqual([])
  })

  it('reads the networks again when a stranger may be on one just joined, at most every 2 s', () => {
    let at = 0
    let networks: ReturnType<typeof os.networkInterfaces> = { 'Wi-Fi': [ipv4('192.168.1.5', 24)] }
    let reads = 0
    let changes = 0
    const book = createAddressBook({ interfaces: () => (reads++, networks), now: () => at, onChange: () => changes++ })
    networks = { 'Wi-Fi': [ipv4('10.0.0.7', 24)] }
    expect(book.allows('10.0.0.8')).toBe(false) // read just now
    at = 2_000
    expect(book.allows('10.0.0.8')).toBe(true)
    expect([reads, changes]).toEqual([2, 1])
    expect(book.list()).toEqual([{ address: '10.0.0.7', interface: 'Wi-Fi', recommended: true }])
    at = 3_000
    expect(book.allows('8.8.8.8')).toBe(false)
    expect(reads).toBe(2)
  })

  it('reads the addresses again when 30 s old, or when a request names one it does not know', () => {
    let at = 0
    let networks: ReturnType<typeof os.networkInterfaces> = { 'Wi-Fi': [ipv4('192.168.1.5', 24)] }
    let changes = 0
    const book = createAddressBook({ interfaces: () => networks, now: () => at, onChange: () => changes++ })
    networks = { 'Wi-Fi': [ipv4('192.168.1.7', 24)] }
    at = ADDRESS_POLL_MS - 1
    expect(book.list().map((a) => a.address)).toEqual(['192.168.1.5'])
    at = ADDRESS_POLL_MS
    expect(book.list().map((a) => a.address)).toEqual(['192.168.1.7'])
    networks = { 'Wi-Fi': [ipv4('192.168.1.9', 24)] }
    at += 2_000
    book.noticeHost('192.168.1.7') // known: nothing read
    expect(book.list().map((a) => a.address)).toEqual(['192.168.1.7'])
    book.noticeHost('192.168.1.9')
    expect(book.list().map((a) => a.address)).toEqual(['192.168.1.9'])
    expect(changes).toBe(2)
  })
})

describe('rate limits', () => {
  it('lets each key take its tokens, given back evenly over the window, and says how long to wait', () => {
    let at = 0
    const limiter = createRateLimiter({ limit: 3, perMs: 3_000, now: () => at })
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([null, null, null])
    expect(limiter.take('a')).toBe(1)
    expect(limiter.take('b')).toBeNull()
    at = 999
    expect(limiter.take('a')).toBe(1)
    at = 1_000
    expect(limiter.take('a')).toBeNull()
    expect(limiter.take('a')).toBe(1)
    at = 60_000
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([null, null, null, 1])
  })
})
