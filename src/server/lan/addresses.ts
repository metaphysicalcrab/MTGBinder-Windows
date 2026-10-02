import net from 'node:net'
import os from 'node:os'
import type { LanAddress } from '../../shared/types.ts'

/**
 * This PC's addresses on its networks, which a phone on the same Wi-Fi opens Binder at (spec §5.10), and who may
 * connect to the phones' listener at all.
 */

/** What os.networkInterfaces() answers; tests pass their own. */
export type Interfaces = () => NodeJS.Dict<os.NetworkInterfaceInfo[]>

/** An address as Node gives a socket's peer: IPv4 inside IPv6 (`::ffff:192.168.1.23`) as plain IPv4. */
export function plainAddress(address: string): string {
  return address.toLowerCase().startsWith('::ffff:') && net.isIPv4(address.slice(7)) ? address.slice(7) : address
}

/** Whether an address is this computer itself: 127.0.0.0/8 or ::1. */
export function isLoopback(address: string): boolean {
  const plain = plainAddress(address)
  return plain === '::1' || (net.isIPv4(plain) && plain.startsWith('127.'))
}

const toNumber = (ipv4: string) => ipv4.split('.').reduce((n, part) => n * 256 + Number(part), 0)

/** Whether an IPv4 address is inside `base`/`bits`. */
function inBlock(address: string, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits)
  return Math.floor(toNumber(address) / size) === Math.floor(toNumber(base) / size)
}

const PRIVATE_BLOCKS = [
  { base: '10.0.0.0', bits: 8 },
  { base: '172.16.0.0', bits: 12 },
  { base: '192.168.0.0', bits: 16 },
]

/** The private network block an IPv4 address is in (its prefix length), or undefined. */
function privateBlockBits(address: string): number | undefined {
  if (!net.isIPv4(address)) return undefined
  return PRIVATE_BLOCKS.find((block) => inBlock(address, block.base, block.bits))?.bits
}

/** A private network's address (10/8, 172.16/12, 192.168/16): a home or office network, never the internet. */
export function isPrivateIPv4(address: string): boolean {
  return privateBlockBits(address) !== undefined
}

/**
 * Adapters a phone can't reach the PC through: virtual machines' and containers' networks (Hyper-V and WSL's
 * vEthernet, VirtualBox, VMware, Docker, Linux bridges), VPNs and overlay networks, and Bluetooth.
 */
const VIRTUAL =
  /vethernet|hyper-v|wsl|default switch|virtualbox|vboxnet|vmware|vmnet|docker|^br-|^virbr|^veth|utun|tailscale|zerotier|^zt|bluetooth|\btap\b|vpn|^tun/i
/**
 * A Hyper-V switch someone made (`vEthernet (External Switch)`), rather than one Windows makes for its own machines
 * (WSL's, the Default Switch, containers' NAT): it may be External, holding the PC's address on its real network.
 */
const OWN_SWITCH = /^vethernet \((?!wsl|default switch|nat\)|dockernat)/i
const WIFI = /wi-?fi|wlan|wireless|airport|^wl/i
const ETHERNET = /ethernet|^en\d|^eth|^en[ops]/i

/**
 * Wi-Fi first (the phone is on it), then Ethernet, then other adapters, then virtual ones,
 * a Hyper-V switch someone made before the rest.
 */
function rank(name: string): number {
  if (VIRTUAL.test(name)) return OWN_SWITCH.test(name) ? 3 : 4
  if (WIFI.test(name)) return 0
  if (ETHERNET.test(name)) return 1
  return 2
}

/**
 * The addresses a phone can open Binder at, best first: IPv4 on a private network (not link-local 169.254/16, which
 * is no network at all), on an adapter that isn't this computer's own. The first one on a real adapter is recommended.
 */
export function lanAddresses(interfaces: ReturnType<Interfaces>): LanAddress[] {
  const found = Object.entries(interfaces).flatMap(([name, infos]) =>
    (infos ?? [])
      .filter((info) => info.family === 'IPv4' && !info.internal && isPrivateIPv4(info.address))
      .map((info) => ({ address: info.address, interface: name, rank: rank(name) })),
  )
  found.sort((a, b) => a.rank - b.rank) // stable: each rank keeps the system's order
  const best = found.findIndex((a) => a.rank < 3)
  return found.map((a, i) => ({ address: a.address, interface: a.interface, recommended: i === best }))
}

/**
 * The private networks this computer is on: each non-internal private IPv4 address and its netmask, no wider than its
 * private block (a VPN's /0 is its 10/8). A public address's network is the internet's, which never may connect.
 */
function subnets(interfaces: ReturnType<Interfaces>): Array<{ address: string; bits: number }> {
  return Object.values(interfaces).flatMap((infos) =>
    (infos ?? []).flatMap((info) => {
      const block = info.family === 'IPv4' && !info.internal ? privateBlockBits(info.address) : undefined
      if (block === undefined) return []
      const bits = Number(info.cidr?.split('/')[1] ?? prefixLength(info.netmask))
      return [{ address: info.address, bits: Math.max(block, bits) }]
    }),
  )
}

/** 255.255.255.0 → 24. */
function prefixLength(netmask: string): number {
  return toNumber(netmask).toString(2).replace(/0+$/, '').length
}

/** How often the addresses are read again while phones can connect: Node has no event for a change. */
export const ADDRESS_POLL_MS = 30_000
/** Reads asked for by a request (a Host naming an address Binder didn't know) come at most this often. */
const MISS_READ_MS = 2_000

export interface AddressBook {
  /** The addresses phones can open Binder at, best first (lanAddresses), read again when 30 s old. */
  list(): LanAddress[]
  /** Whether a peer may connect: this computer, or a device on one of its private networks (not the internet). */
  allows(remote: string | undefined): boolean
  /** A request named this address as its Host: when it isn't one Binder knows, the addresses are read again. */
  noticeHost(hostname: string): void
  /** Reads the addresses every 30 s, telling onChange when they change, until stopped. */
  watch(): void
  stop(): void
}

export function createAddressBook(
  options: { interfaces?: Interfaces; onChange?: () => void; now?: () => number } = {},
): AddressBook {
  const read = () => {
    try {
      return (options.interfaces ?? os.networkInterfaces)()
    } catch {
      return {} // some systems refuse to list them (ERR_SYSTEM_ERROR): no addresses, rather than no Binder
    }
  }
  const now = options.now ?? Date.now
  let interfaces = read()
  let addresses = lanAddresses(interfaces)
  let readAt = now()
  let timer: NodeJS.Timeout | undefined

  function refresh() {
    interfaces = read()
    readAt = now()
    const next = lanAddresses(interfaces)
    const changed = JSON.stringify(next) !== JSON.stringify(addresses)
    addresses = next
    if (changed) options.onChange?.()
  }

  return {
    list() {
      if (now() - readAt >= ADDRESS_POLL_MS) refresh()
      return addresses
    },
    allows(remote) {
      if (remote === undefined) return false
      const plain = plainAddress(remote)
      if (isLoopback(plain)) return true
      if (!net.isIPv4(plain)) return false
      const inside = () => subnets(interfaces).some((subnet) => inBlock(plain, subnet.address, subnet.bits))
      if (inside()) return true
      // Perhaps the PC has just joined this network: read again, though not for every connection a stranger makes.
      if (now() - readAt < MISS_READ_MS) return false
      refresh()
      return inside()
    },
    noticeHost(hostname) {
      if (!net.isIPv4(hostname) || addresses.some((a) => a.address === hostname)) return
      if (now() - readAt >= MISS_READ_MS) refresh()
    },
    watch() {
      timer ??= setInterval(refresh, ADDRESS_POLL_MS).unref()
    },
    stop() {
      clearInterval(timer)
      timer = undefined
    },
  }
}
