import path from 'node:path'

/** What differs by the computer the server runs on: what it's called, and where Windows keeps its own programs. */

/**
 * What the server and the desktop app call the computer Binder runs on, as Settings does: "Mac" on a Mac, "PC" on
 * Windows, "computer" elsewhere.
 */
export function computerNoun(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'PC' : 'computer'
}

/**
 * One of Windows' own programs (`whoami.exe`, `WindowsPowerShell\v1.0\powershell.exe`), by its full path in System32,
 * so a program of the same name elsewhere on the PATH is never run instead: under %SystemRoot%, else %windir%, else
 * C:\Windows.
 */
export function windowsSystemPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', name)
}

/**
 * Windows PowerShell 5.1 by its full path (never `pwsh`, PowerShell 7, which can't reach WinRT, nor whatever is first
 * on the PATH), without its banner, the user's profile, or prompts: the command line, before what it's to run.
 */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string[] {
  const powershell = windowsSystemPath(path.win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe'), env)
  return [powershell, '-NoLogo', '-NoProfile', '-NonInteractive']
}
