import fs from 'node:fs'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createAiClient } from '../../src/server/ai/client.ts'
import { createKeyStore } from '../../src/server/ai/key-store.ts'
import type { AiKeyStatus, ApiErrorBody, BackupStatus, Settings } from '../../src/shared/types.ts'
import { body, makeApp } from '../helpers/app.ts'
import { createTestDb } from '../helpers/db.ts'
import { expectOwnerOnly } from '../helpers/private.ts'
import { tempDir } from '../helpers/tmp.ts'

const send = (app: ReturnType<typeof makeApp>, method: string, url: string, json: unknown) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) })

describe('settings', () => {
  const app = makeApp()
  it('reads and changes the deckbuilder and scanner settings, which start at their defaults', async () => {
    const defaults: Settings = { buylistIgnoreBasics: true, scanAutoCommit: false, scanDefaultFinish: 'nonfoil', scanAcceptUncertainPrinting: false }
    expect(await body<Settings>(await app.request('/api/settings'))).toEqual(defaults)
    const changed: Settings = { buylistIgnoreBasics: false, scanAutoCommit: true, scanDefaultFinish: 'foil', scanAcceptUncertainPrinting: true }
    expect(await body<Settings>(await send(app, 'PATCH', '/api/settings', changed))).toEqual(changed)
    expect(await body<Settings>(await app.request('/api/settings'))).toEqual(changed)
    expect((await send(app, 'PATCH', '/api/settings', { buylistIgnoreBasics: 'yes' })).status).toBe(400)
    expect((await send(app, 'PATCH', '/api/settings', { scanDefaultFinish: 'shiny' })).status).toBe(400)
  })

  it('refuses a key it does not know instead of changing nothing', async () => {
    const fresh = makeApp()
    const res = await send(fresh, 'PATCH', '/api/settings', { buylistIgnoreBasic: false })
    expect(res.status).toBe(400)
    expect((await body<ApiErrorBody>(res)).error).toMatchObject({ code: 'bad_request', message: expect.stringContaining('buylistIgnoreBasic') })
    expect((await send(fresh, 'PATCH', '/api/settings', { scanAutoCommit: true, typo: 1 })).status).toBe(400)
    expect((await body<Settings>(await fresh.request('/api/settings'))).scanAutoCommit).toBe(false) // nothing was changed
  })
})

describe('the API key routes without a key store', () => {
  it('answers 404 whatever the body, before looking at it', async () => {
    const app = makeApp()
    for (const [method, url] of [['GET', '/api/settings/ai'], ['PUT', '/api/settings/ai'], ['POST', '/api/settings/ai/test']] as const) {
      const res = await app.request(url, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : 'not json' })
      expect([method, url, res.status]).toEqual([method, url, 404])
    }
  })
})

describe('backups (spec §5.6)', () => {
  it('says when the last backup was made and where they are, and backs up now', async () => {
    const backupDir = tempDir('binder-backups-')
    const app = makeApp({ db: createTestDb(), backupDir })
    expect(await body<BackupStatus>(await app.request('/api/settings/backups'))).toEqual({ lastBackupAt: null, folder: backupDir })
    const res = await app.request('/api/settings/backups', { method: 'POST' })
    expect(res.status).toBe(200)
    const made = await body<BackupStatus & { file: string }>(res)
    expect(made).toEqual({ lastBackupAt: expect.any(String), folder: backupDir, file: expect.stringMatching(/^binder-\d{4}-\d{2}-\d{2}\.db$/) })
    expect(fs.readdirSync(backupDir)).toEqual([made.file])
    expect((await body<BackupStatus>(await app.request('/api/settings/backups'))).lastBackupAt).toBe(made.lastBackupAt)
  })

  it('explains a backup that fails', async () => {
    const backupDir = tempDir('binder-backups-')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    onTestFinished(() => rename.mockRestore())
    const res = await makeApp({ db: createTestDb(), backupDir }).request('/api/settings/backups', { method: 'POST' })
    expect(res.status).toBe(500)
    expect((await body<ApiErrorBody>(res)).error).toEqual({ code: 'backup_failed', message: "Couldn't back up: ENOSPC: no space left on device" })
    expect(fs.readdirSync(backupDir)).toEqual([])
  })

  it('has no backup routes without a backups folder', async () => {
    const app = makeApp()
    for (const method of ['GET', 'POST']) {
      const res = await app.request('/api/settings/backups', { method })
      expect([res.status, (await body<ApiErrorBody>(res)).error.code]).toEqual([404, 'not_found'])
    }
  })
})

describe('Anthropic API key (spec §5.6)', () => {
  const KEY = 'sk-ant-api03-good-key-1234'
  let envPath: string
  let app: ReturnType<typeof makeApp>
  /** A stand-in client: keys ending in "bad" are refused. */
  const fakeClient = (apiKey: string) =>
    ({
      models: {
        retrieve: async () => {
          if (apiKey.endsWith('bad')) throw new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers())
          return { id: 'claude-opus-5' }
        },
      },
    }) as unknown as Anthropic
  beforeEach(() => {
    const dir = tempDir('binder-env-')
    envPath = path.join(dir, '.env')
    fs.writeFileSync(envPath, 'OTHER_SETTING=1\n')
    app = makeApp({ ai: createAiClient(createKeyStore(envPath), fakeClient) })
  })
  const status = async () => body<AiKeyStatus>(await app.request('/api/settings/ai'))

  it('saves a key to .env, readable only by its owner, and never sends it back', async () => {
    expect(await status()).toEqual({ configured: false, hint: null })
    const saved = await send(app, 'PUT', '/api/settings/ai', { apiKey: `  ${KEY} ` })
    expect(await body(saved)).toEqual({ configured: true, hint: '1234' })
    expect(fs.readFileSync(envPath, 'utf8')).toBe(`OTHER_SETTING=1\nANTHROPIC_API_KEY=${KEY}\n`)
    expectOwnerOnly(envPath)
    expect(JSON.stringify(await status())).not.toContain('good-key')
    // A new client reads the saved key back.
    expect(createAiClient(createKeyStore(envPath), fakeClient).status()).toEqual({ configured: true, hint: '1234' })
  })

  it('replaces and removes the key, keeping the rest of .env', async () => {
    await send(app, 'PUT', '/api/settings/ai', { apiKey: KEY })
    await send(app, 'PUT', '/api/settings/ai', { apiKey: 'sk-ant-api03-other-key-9876' })
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\nANTHROPIC_API_KEY=sk-ant-api03-other-key-9876\n')
    expect(await body(await send(app, 'PUT', '/api/settings/ai', { apiKey: null }))).toEqual({ configured: false, hint: null })
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\n')
  })

  it('tests a typed key, or the saved one, explaining a refusal', async () => {
    const test = (json: unknown) => send(app, 'POST', '/api/settings/ai/test', json)
    expect(await body(await test({ apiKey: KEY }))).toEqual({ ok: true })
    const refused = await test({ apiKey: 'sk-ant-api03-this-one-is-bad' })
    expect([refused.status, (await body<ApiErrorBody>(refused)).error]).toEqual([
      400,
      { code: 'key_failed', message: 'The API key was refused' },
    ])
    expect((await body<ApiErrorBody>(await test({}))).error.message).toBe('No API key is saved')
    await send(app, 'PUT', '/api/settings/ai', { apiKey: KEY })
    expect(await body(await test({}))).toEqual({ ok: true })
  })

  // What people paste: the key, or its whole .env line.
  const PASTED = [
    `ANTHROPIC_API_KEY=${KEY}`,
    `export ANTHROPIC_API_KEY=${KEY}`,
    `ANTHROPIC_API_KEY="${KEY}"`,
    `"ANTHROPIC_API_KEY=${KEY}"`,
    `export ANTHROPIC_API_KEY='${KEY}'`,
    `"${KEY}"`,
    `'${KEY}'`,
    `  export ANTHROPIC_API_KEY="${KEY}"\n`,
  ]

  it.each(PASTED)('saves the bare key from %j, and never sends it back', async (pasted) => {
    const saved = await send(app, 'PUT', '/api/settings/ai', { apiKey: pasted })
    const text = await saved.text()
    expect([saved.status, JSON.parse(text)]).toEqual([200, { configured: true, hint: '1234' }])
    expect(text).not.toContain('good-key')
    expect(fs.readFileSync(envPath, 'utf8')).toBe(`OTHER_SETTING=1\nANTHROPIC_API_KEY=${KEY}\n`)
  })

  it.each(PASTED)('tests the bare key from %j, and never sends it back', async (pasted) => {
    const tried: string[] = []
    app = makeApp({ ai: createAiClient(createKeyStore(envPath), (apiKey) => (tried.push(apiKey), fakeClient(apiKey))) })
    const tested = await send(app, 'POST', '/api/settings/ai/test', { apiKey: pasted })
    const text = await tested.text()
    expect([tested.status, JSON.parse(text)]).toEqual([200, { ok: true }])
    expect(text).not.toContain('good-key')
    expect(tried).toEqual([KEY])
  })

  it('never echoes a pasted key it refuses', async () => {
    // A space inside, too short once bare, and nothing once bare.
    for (const pasted of ['ANTHROPIC_API_KEY=sk-ant secret-part', "ANTHROPIC_API_KEY='secret'", 'export ANTHROPIC_API_KEY=""']) {
      for (const [method, url] of [['PUT', '/api/settings/ai'], ['POST', '/api/settings/ai/test']] as const) {
        const res = await send(app, method, url, { apiKey: pasted })
        const text = await res.text()
        expect([res.status, JSON.parse(text).error.code]).toEqual([400, 'bad_request'])
        expect(text).not.toContain('secret')
      }
    }
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\n')
  })

  it.each([
    ['mismatched quotes', `"${KEY}'`],
    ['a lone leading quote', `"${KEY}`],
    ['a doubled quote pair', `""${KEY}""`],
    ['an equals sign inside', 'sk-ant-api03=good-key-1234'],
    ['a space inside', 'sk-ant-api03 good-key-1234'],
  ])('refuses a key with %s, without echoing it', async (_, pasted) => {
    const tried: string[] = []
    app = makeApp({ ai: createAiClient(createKeyStore(envPath), (apiKey) => (tried.push(apiKey), fakeClient(apiKey))) })
    for (const [method, url] of [['PUT', '/api/settings/ai'], ['POST', '/api/settings/ai/test']] as const) {
      const res = await send(app, method, url, { apiKey: pasted })
      const text = await res.text()
      expect([res.status, JSON.parse(text).error.code]).toEqual([400, 'bad_request'])
      expect(text).not.toContain('good-key')
    }
    expect(tried).toEqual([])
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\n')
  })

  it('refuses a key with spaces or line breaks, which would break .env', async () => {
    expect((await send(app, 'PUT', '/api/settings/ai', { apiKey: 'sk-ant bad key' })).status).toBe(400)
    expect((await send(app, 'PUT', '/api/settings/ai', { apiKey: 'sk-ant-api03\nOTHER=2' })).status).toBe(400)
    expect(fs.readFileSync(envPath, 'utf8')).toBe('OTHER_SETTING=1\n')
  })

  it("sends only Binder's own headers, whatever the shell's ANTHROPIC_CUSTOM_HEADERS says, and leaves the shell's setting be", async () => {
    const shell = process.env.ANTHROPIC_CUSTOM_HEADERS
    onTestFinished(() => {
      if (shell === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS
      else process.env.ANTHROPIC_CUSTOM_HEADERS = shell
    })
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-api-key: not-binders\nx-extra: 1'
    fs.writeFileSync(envPath, `ANTHROPIC_API_KEY=${KEY}\n`)
    const client = createAiClient(createKeyStore(envPath)).get()!
    // The headers a request would carry; building them sends nothing.
    const build = (client as unknown as { buildHeaders(o: object): Promise<Headers> }).buildHeaders.bind(client)
    const headers = await build({ options: {}, method: 'post', bodyHeaders: undefined, retryCount: 0 })
    expect(headers.get('x-api-key')).toBe(KEY)
    expect(headers.has('x-extra')).toBe(false)
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-api-key: not-binders\nx-extra: 1')
  })

  it("sends the saved key only to Anthropic, whatever the shell's ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN say", () => {
    const shell = { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN }
    onTestFinished(() => {
      for (const [name, value] of Object.entries(shell)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.invalid/anthropic'
    process.env.ANTHROPIC_AUTH_TOKEN = 'a-token-that-is-not-binders'
    fs.writeFileSync(envPath, `ANTHROPIC_API_KEY=${KEY}\n`)
    // The client Binder makes for itself; building it sends nothing.
    const client = createAiClient(createKeyStore(envPath)).get()!
    expect([client.baseURL, client.authToken, client.apiKey]).toEqual(['https://api.anthropic.com', null, KEY])
  })
})
