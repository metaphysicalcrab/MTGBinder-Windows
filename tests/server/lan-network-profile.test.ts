import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { windowsNetworkProfile, type RunCommand } from '../../src/server/lan/network-profile.ts'

const NOW = new Date('2026-10-02T12:00:00Z')
const WINDOWS = { SystemRoot: 'C:\\Windows' }

/** A stand-in for PowerShell that prints `output` (or fails with it), counting its runs. */
function powershell(output: string | Error) {
  return vi.fn<RunCommand>(async () => {
    if (output instanceof Error) throw output
    return output
  })
}

const profile = (network: string, alias: string, category: number | string) =>
  ({ Name: network, InterfaceAlias: alias, NetworkCategory: category })

describe("Windows' network profile (phone access)", () => {
  it("reads one network, as Windows PowerShell 5.1 prints it, by PowerShell's full path", async () => {
    const exec = powershell(`${JSON.stringify(profile('HomeWifi', 'Wi-Fi', 1))}\r\n`)
    expect(await windowsNetworkProfile({ exec, platform: 'win32', now: NOW, env: WINDOWS })).toEqual({
      publicProfile: false,
      name: 'HomeWifi',
    })
    expect(exec).toHaveBeenCalledOnce()
    const [command, args] = exec.mock.calls[0]!
    expect(command).toBe(path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    expect(args[4]).toContain('Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory')
  })

  it('picks the adapter the phones reach the PC through from several networks, and says when it is Public', async () => {
    const exec = powershell(
      JSON.stringify([profile('Unidentified network', 'vEthernet (WSL)', 1), profile('CafeWifi', 'Wi-Fi', 0)]),
    )
    const options = { exec, platform: 'win32' as const, now: NOW, env: WINDOWS }
    expect(await windowsNetworkProfile({ ...options, interfaceName: 'Wi-Fi' })).toEqual({
      publicProfile: true,
      name: 'CafeWifi',
    })
    expect(await windowsNetworkProfile({ ...options, interfaceName: 'wi-fi' })).toMatchObject({ name: 'CafeWifi' })
    // Without an adapter, the first network; with one Windows doesn't list, nothing to say.
    expect(await windowsNetworkProfile(options)).toEqual({ publicProfile: false, name: 'Unidentified network' })
    expect(await windowsNetworkProfile({ ...options, interfaceName: 'Ethernet' })).toBeNull()
    expect(exec).toHaveBeenCalledOnce()
  })

  it('reads the category as a number or by name: only Public is public', async () => {
    const cases: Array<[number | string, boolean]> = [
      [0, true],
      ['Public', true],
      [1, false],
      ['Private', false],
      [2, false],
      ['DomainAuthenticated', false],
    ]
    for (const [category, publicProfile] of cases) {
      const exec = powershell(JSON.stringify(profile('Net', 'Wi-Fi', category)))
      expect(await windowsNetworkProfile({ exec, platform: 'win32', now: NOW })).toEqual({ publicProfile, name: 'Net' })
    }
  })

  it("reads an answer with a byte order mark, and names a network that has no name by its adapter", async () => {
    const exec = powershell(`\uFEFF${JSON.stringify({ Name: null, InterfaceAlias: 'Ethernet 2', NetworkCategory: 0 })}`)
    expect(await windowsNetworkProfile({ exec, platform: 'win32', now: NOW })).toEqual({
      publicProfile: true,
      name: 'Ethernet 2',
    })
  })

  it("answers null when PowerShell fails or times out, answers something else, or there's no network", async () => {
    const answers = [
      new Error('Command failed: powershell.exe (timed out)'),
      'Get-NetConnectionProfile : The term is not recognized',
      JSON.stringify({ Name: 'HomeWifi' }),
      '',
    ]
    for (const output of answers) {
      expect(await windowsNetworkProfile({ exec: powershell(output), platform: 'win32', now: NOW })).toBeNull()
    }
  })

  it('answers null on the Mac and Linux without running anything', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const exec = powershell(JSON.stringify(profile('HomeWifi', 'Wi-Fi', 0)))
      expect(await windowsNetworkProfile({ exec, platform, now: NOW })).toBeNull()
      expect(exec).not.toHaveBeenCalled()
    }
  })

  it('asks Windows at most once a minute, failures included, sharing one question between callers', async () => {
    const exec = powershell(JSON.stringify(profile('HomeWifi', 'Wi-Fi', 0)))
    const at = (seconds: number) => ({ exec, platform: 'win32' as const, now: new Date(NOW.getTime() + seconds * 1000) })
    await Promise.all([windowsNetworkProfile(at(0)), windowsNetworkProfile(at(0))])
    await windowsNetworkProfile(at(59))
    expect(exec).toHaveBeenCalledTimes(1)
    await windowsNetworkProfile(at(60))
    expect(exec).toHaveBeenCalledTimes(2)

    const failing = powershell(new Error('Command failed'))
    await windowsNetworkProfile({ exec: failing, platform: 'win32', now: NOW })
    await windowsNetworkProfile({ exec: failing, platform: 'win32', now: new Date(NOW.getTime() + 30_000) })
    expect(failing).toHaveBeenCalledTimes(1)
  })
})
