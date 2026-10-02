import type { CliOptions } from 'electron-builder'
import { ROOT_DIR } from '../../src/server/config.ts'

/** Why `pnpm app` stopped, in one line. */
export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

/** The first line of what went wrong: the tools print their own details as they fail. */
export function firstLine(err: unknown): string {
  if (err instanceof InstallError) return err.message
  const text = err instanceof Error ? err.message : String(err)
  return text.trim().split(/\r?\n/)[0] ?? text
}

/** Runs one of `pnpm app`'s steps; a failure becomes an InstallError: what failed, and the first line of why. */
export async function step<T>(failure: string, work: () => T | Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof InstallError) throw err
    throw new InstallError(`${failure}: ${firstLine(err)}`)
  }
}

/**
 * Packages Binder with electron-builder and package.json's build section, as its command line would with the same
 * options (`{ mac: [] }` is `electron-builder --mac`), here rather than through `pnpm exec`, which Windows can't start
 * without a shell. Returns the files it made (none for a folder, the `dir` target). Loaded only when it's needed.
 */
export async function electronBuilder(options: CliOptions): Promise<string[]> {
  const { build } = await import('electron-builder')
  return build({ projectDir: ROOT_DIR, ...options })
}
