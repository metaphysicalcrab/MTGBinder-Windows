import path from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { describeAiError, type AiClient } from './ai/client.ts'
import { backupNow, backupStatus } from './backup.ts'
import { CompactUnfinishedError, compactLibrary, librarySize } from './compact.ts'
import type { DB } from './db/index.ts'
import { ApiError, parseWith, readJson, type AppEnv } from './http.ts'
import { getSettings, updateSettings } from './settings.ts'

/** Strict, so a mistyped setting is refused rather than answered 200 with nothing changed. */
const SettingsBody = z
  .object({
    buylistIgnoreBasics: z.boolean().optional(),
    scanAutoCommit: z.boolean().optional(),
    scanDefaultFinish: z.enum(['nonfoil', 'foil', 'etched']).optional(),
    scanAcceptUncertainPrinting: z.boolean().optional(),
  })
  .strict()

/** Without one pair of matching quotes around it (`"…"` or `'…'`). */
const unquoted = (text: string) => (/^(["']).*\1$/s.test(text) ? text.slice(1, -1) : text)

/**
 * A pasted key without the `.env` dressing people copy along with it: trimmed, then without a leading `export `, one
 * pair of quotes around the whole line, a leading `ANTHROPIC_API_KEY=` and then one pair of quotes around its value,
 * trimmed again. Only quotes around a value are removed after the name, so a doubled pair (`""sk-…""`) stays and is
 * refused.
 */
function bareKey(pasted: string): string {
  let key = pasted.trim()
  if (key.startsWith('export ')) key = key.slice('export '.length)
  key = unquoted(key)
  if (key.startsWith('ANTHROPIC_API_KEY=')) key = unquoted(key.slice('ANTHROPIC_API_KEY='.length))
  return key.trim()
}

/** An Anthropic API key: letters, digits, `-` and `_` only (it's written as one line of `.env`). */
const ApiKey = z
  .string()
  .transform(bareKey)
  .pipe(z.string().min(10).max(300).regex(/^[A-Za-z0-9_-]+$/, 'An API key has only letters, digits, "-" and "_"'))
const KeyBody = z.object({ apiKey: ApiKey.nullable() })
const TestBody = z.object({ apiKey: ApiKey.optional() })

export function settingsRoutes(deps: { db: DB; ai?: AiClient; backupDir?: string }): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.get('/', (c) => c.json(getSettings(deps.db)))
  routes.patch('/', async (c) => c.json(updateSettings(deps.db, parseWith(SettingsBody, await readJson(c.req)))))

  // The Anthropic API key (spec §5.6): never sent back, only whether one is set and its last four characters (not
  // to a phone, which can't change it: spec §5.10).
  const ai = () => {
    if (!deps.ai) throw new ApiError(404, 'not_found', 'No API key settings here')
    return deps.ai
  }
  routes.get('/ai', (c) => {
    const status = ai().status()
    return c.json(c.get('client')?.kind === 'device' ? { ...status, hint: null } : status)
  })
  routes.put('/ai', async (c) => c.json(ai().setKey(parseWith(KeyBody, await readJson(c.req)).apiKey)))
  routes.post('/ai/test', async (c) => {
    const client = ai() // no key settings here is a 404, whatever the body
    const { apiKey } = parseWith(TestBody, await readJson(c.req))
    try {
      await client.test(apiKey)
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(400, 'key_failed', describeAiError(err))
    }
    return c.json({ ok: true })
  })

  // Backups (spec §5.6): when the last one was made, where they are, and one now.
  const backupDir = () => {
    if (!deps.backupDir) throw new ApiError(404, 'not_found', 'No backup settings here')
    return deps.backupDir
  }
  routes.get('/backups', (c) => c.json(backupStatus(deps.db, backupDir())))
  routes.post('/backups', (c) => {
    let file: string
    try {
      file = backupNow(deps.db, backupDir())
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(500, 'backup_failed', `Couldn't back up: ${err instanceof Error ? err.message : String(err)}`)
    }
    return c.json({ ...backupStatus(deps.db, backupDir()), file: path.basename(file) })
  })

  // The library file (Settings → Library file): its size and free space, and compacting it, after a backup.
  routes.get('/library', (c) => c.json(librarySize(deps.db)))
  routes.post('/library/compact', (c) => {
    const dir = backupDir()
    try {
      const { before, after, backup } = compactLibrary(deps.db, dir)
      return c.json({ before, after, backup: path.basename(backup) })
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(500, 'compact_failed', compactFailure(err))
    }
  })
  return routes
}

/**
 * Why compacting failed, and what to do next, by its cause: a file in the library folder another program holds (on
 * Windows: antivirus, OneDrive, or another Binder, mid-backup), or a full disk (VACUUM's working copy goes on the
 * temporary files' drive, which may not be the library's). The library is said to be unchanged only when the
 * failure came before VACUUM rewrote it, or from VACUUM itself, which leaves it as it was when it fails.
 */
export function compactFailure(err: unknown): string {
  const unfinished = err instanceof CompactUnfinishedError
  const cause = unfinished ? err.cause : err
  const reason = (cause instanceof Error ? cause.message : String(cause)).replace(/\.$/, '')
  const code = (cause as { code?: unknown } | null)?.code
  const next =
    code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
      ? 'A file in the library folder is in use by another program (antivirus, OneDrive, or another Binder); try again in a moment'
      : code === 'SQLITE_FULL'
        ? "Free up disk space, on the library's drive and on the one that holds temporary files, and try again"
        : 'Free up disk space and try again'
  if (unfinished) return `Couldn't finish compacting the library: ${reason}. It was compacted; compact it again to finish.`
  return `Couldn't compact the library: ${reason}. ${next}; the library is unchanged.`
}
