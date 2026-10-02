import { describe, expect, it } from 'vitest'
import { computerNoun, windowsPowerShell, windowsSystemPath } from '../../src/server/platform.ts'

describe('what differs by the computer Binder runs on', () => {
  it('names the computer as Settings does: Mac, PC, or computer', () => {
    expect([computerNoun('darwin'), computerNoun('win32'), computerNoun('linux')]).toEqual(['Mac', 'PC', 'computer'])
  })

  it("finds Windows' own programs in System32, under %SystemRoot%, else %windir%, else C:\\Windows", () => {
    expect(windowsSystemPath('whoami.exe', { SystemRoot: 'D:\\WINDOWS', windir: 'E:\\WIN' })).toBe('D:\\WINDOWS\\System32\\whoami.exe')
    // A blank one counts as none, rather than making the path relative (and so whatever the current folder holds).
    expect(windowsSystemPath('icacls.exe', { SystemRoot: '', windir: 'E:\\WIN' })).toBe('E:\\WIN\\System32\\icacls.exe')
    expect(windowsSystemPath('tasklist.exe', {})).toBe('C:\\Windows\\System32\\tasklist.exe')
  })

  it('runs Windows PowerShell 5.1 by its full path, without its banner, the profile, or prompts', () => {
    expect(windowsPowerShell({ SystemRoot: 'C:\\Windows' })).toEqual([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
    ])
  })
})
