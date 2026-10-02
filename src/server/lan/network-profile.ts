import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

/**
 * The network phones reach the PC through, and whether Windows treats it as Public. Windows 11 marks a new Wi-Fi
 * network Public, and its firewall then blocks phones even after Binder was allowed on Private networks, so Settings →
 * Phone access says so, with how to make it Private.
 */
export interface NetworkProfile {
  publicProfile: boolean
  /** The network's name, as Windows shows it ("HomeWifi"). */
  name: string
}

/** Runs a program and returns what it printed. Tests pass a stand-in. */
export type RunCommand = (command: string, args: string[]) => Promise<string>

export interface NetworkProfileOptions {
  /**
   * The adapter the phones' address is on, as os.networkInterfaces() names it ("Wi-Fi"). Not the first network Windows
   * lists, which on a PC with WSL or Hyper-V is often their virtual adapter's ("vEthernet (WSL)").
   */
  interfaceName: string
  exec?: RunCommand
  /** Default: this platform. Anywhere but Windows the answer is null. */
  platform?: NodeJS.Platform
  /** When it is, for the cache (tests pass their own). Default: now. */
  now?: Date
  env?: NodeJS.ProcessEnv
}

/** How long an answer is kept: PowerShell takes a second or two to start, and Settings asks every few seconds. */
const CACHE_MS = 60_000
const TIMEOUT_MS = 5_000

/**
 * The connected networks, as JSON in UTF-8 (Windows PowerShell otherwise prints in the console's code page, which
 * garbles a name like "Café"). NetworkCategory is Public (0), Private (1) or DomainAuthenticated (2): a number, or its
 * name from a PowerShell that writes enums as names.
 */
const QUERY =
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ' +
  'Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress'

const Profile = z.object({
  Name: z.string().nullish(),
  InterfaceAlias: z.string(),
  NetworkCategory: z.union([z.number(), z.string()]),
})
type Profile = z.infer<typeof Profile>

const execFileAsync = promisify(execFile)

const run: RunCommand = async (command, args) =>
  (await execFileAsync(command, args, { encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS })).stdout

/** Each way of running commands, with what it last answered and when (tests pass their own, and get their own). */
const cache = new WeakMap<RunCommand, { at: number; profiles: Promise<Profile[] | null> }>()

/**
 * On Windows, the network profile of the adapter phones reach the PC through; null on other platforms, and when it
 * can't be told: no such network, or PowerShell failed, timed out or answered something unexpected. Answers, failures
 * included, are kept for a minute.
 */
export async function windowsNetworkProfile(options: NetworkProfileOptions): Promise<NetworkProfile | null> {
  const { platform = process.platform, exec = run, now = new Date(), env = process.env } = options
  if (platform !== 'win32') return null
  let cached = cache.get(exec)
  const age = cached ? now.getTime() - cached.at : Infinity
  if (!cached || age < 0 || age >= CACHE_MS) {
    cached = { at: now.getTime(), profiles: connectionProfiles(exec, env) }
    cache.set(exec, cached)
  }
  const profiles = await cached.profiles
  const wanted = options.interfaceName.toLowerCase()
  const profile = profiles?.find((p) => p.InterfaceAlias.toLowerCase() === wanted)
  if (!profile) return null
  const category = profile.NetworkCategory
  return {
    publicProfile: category === 0 || String(category).toLowerCase() === 'public',
    name: profile.Name?.trim() || profile.InterfaceAlias,
  }
}

/** Windows' connection profiles, from Windows PowerShell 5.1 by its full path; null when they can't be read. */
async function connectionProfiles(exec: RunCommand, env: NodeJS.ProcessEnv): Promise<Profile[] | null> {
  const windows = env.SystemRoot || 'C:\\Windows'
  const powershell = path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const output = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', QUERY])
    const text = output.replace(/^\uFEFF/, '').trim()
    if (!text) return [] // no network at all
    // One network is an object; more are an array.
    const answer = z.union([Profile.transform((p) => [p]), z.array(Profile)]).safeParse(JSON.parse(text))
    return answer.success ? answer.data : null
  } catch {
    return null
  }
}
