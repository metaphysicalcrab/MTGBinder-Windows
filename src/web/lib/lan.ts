import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LanClient, LanDevice, LanPairing, LanStatus } from '../../shared/types.ts'
import { apiGet, ApiRequestError, apiSend } from './api.ts'
import { asSentence } from './brainstorm.ts'
import type { Platform } from './platform.ts'
import { useToast } from './toast.tsx'

/** Phone access (spec §5.10): Settings → Phone access on the PC, the pairing page, and This phone on a phone. */

/** The digits of a pairing code as typed: spaces, dashes and anything else left out, and no more than 8. */
export function codeDigits(typed: string): string {
  return typed.replace(/\D/g, '').slice(0, 8)
}

/** A pairing code (or the digits typed so far) in groups of four, as the PC shows it and the phone types it: "4821 0937". */
export function groupCode(code: string): string {
  return codeDigits(code).replace(/(\d{4})(?=\d)/, '$1 ')
}

/** How long ago a moment was: "just now", "2 min ago", "3 hours ago", "yesterday", "5 days ago", then its date. */
export function agoText(iso: string, now: number): string {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return iso
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return `on ${new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
}

/** When a paired phone last used Binder, and from where: "Last seen 2 min ago from 192.168.1.23". */
export function lastSeenText(device: Pick<LanDevice, 'lastSeenAt' | 'lastIp'>, now: number): string {
  if (!device.lastSeenAt) return 'Not seen since it paired'
  return `Last seen ${agoText(device.lastSeenAt, now)}${device.lastIp ? ` from ${device.lastIp}` : ''}`
}

/** The time left on a pairing code: "4:59", and "0:00" once it's up. */
export function countdownText(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** A wait in seconds, as a person says it: "40 s", "7 min" (with a space that keeps the number and unit together). */
export function waitText(seconds: number): string {
  return seconds < 60 ? `${Math.max(1, Math.ceil(seconds))}\u00a0s` : `${Math.ceil(seconds / 60)}\u00a0min`
}

/**
 * Why a phone couldn't pair, as the pairing page says it: the server's own words for a wrong code (they say when
 * pairing has stopped) and for no pairing open, how long to wait after too many tries, and what to check when Binder
 * didn't answer at all.
 */
export function pairErrorText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'rate_limited' && err.retryAfter !== undefined) {
      return `Too many tries at pairing from this phone: try again in ${waitText(err.retryAfter)}.`
    }
    return asSentence(err.message)
  }
  return "Couldn't reach Binder on the PC: check that this phone is on the same Wi-Fi, and that Binder is running."
}

/** How a pairing window ended, as the PC's pairing dialog says it. */
export function pairingEndedText(ended: NonNullable<LanStatus['pairingEnded']>): string {
  switch (ended.reason) {
    case 'paired':
      return ended.name ? `Paired “${ended.name}”.` : 'Paired.'
    case 'expired':
      return 'The code expired before a phone used it.'
    case 'too_many_tries':
      return 'Too many wrong codes, so pairing stopped.'
  }
}

/**
 * A name for this phone, for the pairing page to offer: its model where the browser says it (Chrome over HTTPS: "Pixel
 * 8"), else what kind of device it is. Chrome's user agent no longer names the model, and over plain HTTP it tells no
 * more.
 */
export function phoneNameGuess(model: string | undefined, userAgent: string, platform: Platform): string {
  if (model?.trim()) return model.trim().slice(0, 60)
  if (/\biPhone\b/.test(userAgent)) return 'iPhone'
  if (/\biPad\b/.test(userAgent)) return 'iPad'
  if (platform === 'windows') return 'Windows PC'
  if (platform === 'mac') return 'Mac'
  return 'Android phone'
}

/** The model a browser names (Chromium's userAgentData, in a secure context), or undefined. */
export async function deviceModel(nav: Navigator): Promise<string | undefined> {
  const data = (nav as Navigator & { userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string }> } })
    .userAgentData
  try {
    return (await data?.getHighEntropyValues?.(['model']))?.model || undefined
  } catch {
    return undefined
  }
}

/** The address phones open now: the chosen one while it's this PC's, else the recommended one, else the first. */
export function addressInUse(status: Pick<LanStatus, 'address' | 'addresses'>): string | null {
  const { address, addresses } = status
  if (address && addresses.some((a) => a.address === address)) return address
  return (addresses.find((a) => a.recommended) ?? addresses[0])?.address ?? null
}

/** What a note on Settings → Phone access is: a tip, or a warning that phones can't connect. */
export interface LanNote {
  tone: 'tip' | 'warning'
  text: string
}

/**
 * What to know about this computer's firewall while phone access is on (spec §5.10). `firstTime`: no phone has paired
 * yet, so the system may not have been asked yet, or was answered wrongly. On Windows, its firewall asks the first time
 * Binder listens for phones, and a network Windows calls Public blocks them whatever the answer was; on a Mac, macOS
 * may ask whether Binder may accept incoming connections (again after a rebuild of the app). `inApp`: the page is in
 * the desktop app, whose server is Binder.exe; under `pnpm start` it's node.exe, which Windows names by its
 * description wherever it asks or lists it.
 */
export function firewallNotes(
  status: Pick<LanStatus, 'network' | 'addresses' | 'address'>,
  platform: Platform,
  firstTime: boolean,
  inApp: boolean,
): LanNote[] {
  const notes: LanNote[] = []
  if (platform === 'windows') {
    if (status.network?.publicProfile) {
      const name = status.network.name
      const adapter = status.addresses.find((a) => a.address === addressInUse(status))?.interface ?? ''
      const ethernet = /ethernet/i.test(adapter)
      notes.push({
        tone: 'warning',
        text: ethernet
          ? `Windows has ${name} as a Public network, where its firewall blocks phones: make it Private (Windows 11: Settings → ` +
            `Network & internet → Ethernet → Network profile type → Private network; Windows 10: Settings → Network & ` +
            `Internet → Ethernet → ${name} → Network profile → Private).`
          : `Windows has ${name} as a Public network, where its firewall blocks phones: make it Private (Windows 11: Settings → ` +
            `Network & internet → Wi-Fi → ${name} properties → Network profile type → Private network; Windows 10: Settings → ` +
            `Network & Internet → Wi-Fi → ${name} → Network profile → Private).`,
      })
    }
    if (firstTime) {
      const app = inApp ? 'Binder' : 'Node.js JavaScript Runtime'
      const asked = inApp ? app : `${app} (node.exe, which runs Binder from the terminal)`
      notes.push({
        tone: 'tip',
        text:
          `The first time, Windows asks whether ${asked} may use the network: allow it on Private networks. If it was ` +
          `cancelled, phones can't connect until ${app} is allowed in Windows Security → Firewall & network protection → ` +
          'Allow an app through firewall.',
      })
    }
  } else if (platform === 'mac' && firstTime) {
    notes.push({
      tone: 'tip',
      text: 'macOS may ask whether Binder may accept incoming connections: choose Allow. It may ask again after Binder is rebuilt.',
    })
  }
  return notes
}

/**
 * Whether phones open Binder over HTTPS now: its address is https://… (HTTPS on, and listening). While phone access is
 * off, or this PC has no address to give, whether it will be once on.
 */
export function phonesUseHttps(status: Pick<LanStatus, 'https' | 'url'>): boolean {
  return status.url ? status.url.startsWith('https:') : status.https
}

/**
 * Why a paired phone gets only the pairing page now, or null (spec §5.10): it paired over HTTP and phones open Binder
 * over HTTPS, or the reverse. Its cookie works only the way it paired.
 */
export function pairsAgainText(device: Pick<LanDevice, 'https'>, status: Pick<LanStatus, 'https' | 'url'>): string | null {
  const https = phonesUseHttps(status)
  if (device.https === https) return null
  return https
    ? 'Paired over HTTP: it must pair again to open Binder over HTTPS.'
    : 'Paired over HTTPS: it must pair again to open Binder while HTTPS is off.'
}

/** Settings → Phone access: polled every 2 s while a pairing dialog is open, and every 10 s otherwise. */
export function useLanStatus(pairing = false) {
  return useQuery({
    queryKey: ['lan'],
    queryFn: ({ signal }) => apiGet<LanStatus>('/api/lan', signal),
    // Also while phone access is off: the desktop app's tray can turn it on with Settings open.
    refetchInterval: pairing ? 2000 : 10_000,
    staleTime: 0,
  })
}

/** Turns phone access or HTTPS on or off, or picks the address phones open (null: the recommended one). */
export function useUpdateLan() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (change: { enabled?: boolean; https?: boolean; address?: string | null }) => apiSend<LanStatus>('PUT', '/api/lan', change),
    onSuccess: (status) => queryClient.setQueryData(['lan'], status),
  })
}

/** Opens a pairing window: the code and the QR code's link, which the status then shows as the window's. */
export function useStartPairing() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: () => apiSend<LanPairing>('POST', '/api/lan/pairing'),
    onSuccess: async (pairing) => {
      // A poll still on its way would bring back the window before this one.
      await queryClient.cancelQueries({ queryKey: ['lan'] })
      queryClient.setQueryData<LanStatus>(['lan'], (status) => status && { ...status, pairing, pairingEnded: null })
    },
    onError: (err) => toast.error(err.message),
  })
}

/** Closes the pairing window (the dialog was closed before a phone paired). */
export function useCancelPairing() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiSend<void>('DELETE', '/api/lan/pairing'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['lan'] }),
  })
}

/**
 * Closes the pairing window as the page goes away with its dialog open (a reload, the window closed): a request the
 * browser sends after the page has gone.
 */
export function cancelPairingAsPageGoes(): void {
  fetch('/api/lan/pairing', { method: 'DELETE', keepalive: true }).catch(() => {})
}

export function useRenameDevice() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => apiSend<LanDevice>('PATCH', `/api/lan/devices/${id}`, { name }),
    onSuccess: (device) =>
      queryClient.setQueryData<LanStatus>(
        ['lan'],
        (status) => status && { ...status, devices: status.devices.map((d) => (d.id === device.id ? device : d)) },
      ),
    onError: (err) => toast.error(`Couldn't rename the phone: ${err.message}`),
  })
}

export function useForgetDevice() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (device: LanDevice) => apiSend<void>('DELETE', `/api/lan/devices/${device.id}`),
    onSuccess: (_, device) => toast.success(`Forgot “${device.name}”.`),
    onError: (err) => toast.error(`Couldn't forget the phone: ${err.message}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['lan'] }),
  })
}

/** Forgets every phone: each must pair again (the server makes every device cookie worthless). */
export function useForgetAllPhones() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: () => apiSend<void>('POST', '/api/lan/forget-all'),
    onSuccess: () => toast.success('Forgot every phone.'),
    onError: (err) => toast.error(`Couldn't forget the phones: ${err.message}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['lan'] }),
  })
}

/** Makes a new certificate authority for HTTPS: each phone installs it again. */
export function useNewCertificate() {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: () => apiSend<LanStatus>('POST', '/api/lan/https/rotate'),
    onSuccess: (status) => {
      queryClient.setQueryData(['lan'], status)
      toast.success('Made a new certificate: install it on each phone.')
    },
    onError: (err) => toast.error(`Couldn't make a new certificate: ${err.message}`),
  })
}

/** Who this page is, asked again (This phone, on a phone: the PC may have renamed it). */
export function useLanMe() {
  return useQuery({ queryKey: ['lan-me'], queryFn: ({ signal }) => apiGet<LanClient>('/api/lan/me', signal) })
}

/** A phone forgetting itself (This phone): it gets the pairing page. */
export function useForgetThisPhone(onForgotten: () => void) {
  const toast = useToast()
  return useMutation({
    mutationFn: () => apiSend<void>('POST', '/api/lan/forget'),
    onSuccess: onForgotten,
    onError: (err) => toast.error(`Couldn't forget this phone: ${err.message}`),
  })
}
