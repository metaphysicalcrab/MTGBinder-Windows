import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { Finish } from '../../shared/types.ts'
import { PhoneAccessSettings } from '../components/settings/PhoneAccessSettings.tsx'
import { ApiKeyOnThePc, ThisPhoneSettings } from '../components/settings/PhoneSettings.tsx'
import { checkbox, section, sectionHead } from '../components/settings/styles.ts'
import { apiPost } from '../lib/api.ts'
import { useOnPhone } from '../lib/client.ts'
import { formatDate } from '../lib/format.ts'
import {
  librarySizeText,
  useAiKey,
  useBackUpNow,
  useBackups,
  useCompactLibrary,
  useLibrarySize,
  useSaveAiKey,
  useSettings,
  useTestAiKey,
  useUpdateSettings,
} from '../lib/settings.ts'
import { isBulkRunning, useBulkStatus } from '../lib/use-bulk-status.ts'

/**
 * Settings (spec §5.6). On a paired phone (spec §5.10), what a phone may change: card data, the scanner, and the
 * deckbuilder, with whether Brainstorm has a key and This phone; the PC's own sections aren't shown, and what they'd
 * ask for is never asked.
 */
export function SettingsPage() {
  const queryClient = useQueryClient()
  const phone = useOnPhone()
  const { data: status, error } = useBulkStatus()
  const refresh = useMutation({
    mutationFn: () => apiPost<{ started: boolean }>('/api/bulk/refresh'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['bulk-status'] }),
  })
  const running = isBulkRunning(status)

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <h1 className="font-serif text-3xl font-semibold text-stone-50">Settings</h1>

      <section className={section}>
        <div className={sectionHead}>
          <div>
            <h2 className="text-lg font-semibold text-stone-100">Card data</h2>
            <p className="mt-1 text-sm text-stone-400">
              A local copy of every paper printing from Scryfall. Refreshes automatically when older than 7 days, or
              after a Binder update that needs something new from it.
            </p>
          </div>
          <button
            onClick={() => refresh.mutate()}
            disabled={running || refresh.isPending}
            className="shrink-0 rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:py-2.5"
          >
            {running ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>

        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-stone-400">Printings</dt>
          <dd className="text-stone-100 tabular-nums">{status ? status.cardCount.toLocaleString() : '…'}</dd>
          <dt className="text-stone-400">Last imported</dt>
          <dd className="text-stone-100">{formatDate(status?.updatedAt ?? null)}</dd>
          <dt className="text-stone-400">Scryfall data from</dt>
          <dd className="text-stone-100">{formatDate(status?.sourceUpdatedAt ?? null)}</dd>
        </dl>

        {running && status && (
          <div className="mt-5 text-sm text-amber-200">
            {status.state === 'downloading'
              ? 'Downloading card data from Scryfall…'
              : `Importing… ${status.processed.toLocaleString()} printings`}
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-stone-800">
              <div className="h-full w-1/3 animate-pulse rounded bg-amber-500" />
            </div>
          </div>
        )}
        {!running && status?.error && (
          <div className="mt-5 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
            Last refresh failed: {status.error}
          </div>
        )}
        {refresh.error && (
          <div className="mt-5 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
            {refresh.error.message}
          </div>
        )}
        {error && (
          <div className="mt-5 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
            Couldn't load status: {error.message}
          </div>
        )}
      </section>
      <ScannerSettings />
      {phone ? <ApiKeyOnThePc /> : <ApiKeySettings />}
      <DeckbuilderSettings />
      {phone ? (
        <ThisPhoneSettings />
      ) : (
        <>
          <BackupSettings />
          <LibraryFileSettings running={running} />
          <PhoneAccessSettings />
        </>
      )}
    </div>
  )
}

/** Spec §5.6 "Backups": when the last backup was made, Back up now, and the folder they're kept in. */
function BackupSettings() {
  const { data: backups, error } = useBackups()
  const backUp = useBackUpNow()
  return (
    <section className={section}>
      <div className={sectionHead}>
        <div>
          <h2 className="text-lg font-semibold text-stone-100">Backups</h2>
          <p className="mt-1 text-sm text-stone-400">
            Binder saves a compact copy of your library when it starts and the last one is more than a day old, and
            keeps a week of these daily backups, plus the last 3 extra copies made with Back up now. To restore one,
            stop Binder and copy it over <code>binder.db</code> in the folder above it, deleting{' '}
            <code>binder.db-wal</code> and <code>binder.db-shm</code>.
          </p>
        </div>
        <button
          onClick={() => backUp.mutate()}
          disabled={backUp.isPending}
          className="shrink-0 rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:py-2.5"
        >
          {backUp.isPending ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-rose-300">Couldn't load the backups: {error.message}</p>
      ) : (
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-stone-400">Last backup</dt>
          <dd className="text-stone-100">{backups ? formatDate(backups.lastBackupAt) : '…'}</dd>
          <dt className="text-stone-400">Folder</dt>
          <dd className="min-w-0 break-all font-mono text-xs text-stone-300">{backups?.folder ?? '…'}</dd>
        </dl>
      )}
    </section>
  )
}

/**
 * Spec §5.6 "Library file": its size and the unused space inside it, and compacting it (after a backup). Not while card
 * data is being refreshed (`running`), whose merge would undo the gain.
 */
function LibraryFileSettings({ running }: { running: boolean }) {
  const { data: size, error } = useLibrarySize()
  const compact = useCompactLibrary()
  const text = size && librarySizeText(size)
  const worthIt = text?.worthIt === true
  return (
    <section className={section}>
      <div className={sectionHead}>
        <div>
          <h2 className="text-lg font-semibold text-stone-100">Library file</h2>
          <p className="mt-1 text-sm text-stone-400">
            Replacing card data leaves unused space inside the library file. Compacting gives it back: Binder backs up
            first, then rewrites the file, which takes a few seconds.
          </p>
        </div>
        <button
          onClick={() => compact.mutate()}
          disabled={!worthIt || compact.isPending || running}
          className="shrink-0 rounded-md border border-stone-700 px-4 py-2 text-sm font-medium text-stone-100 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:py-2.5"
        >
          {compact.isPending ? 'Compacting…' : 'Compact the library'}
        </button>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-rose-300">Couldn't read the library's size: {error.message}</p>
      ) : (
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-stone-400">Size</dt>
          <dd className="text-stone-100">{text ? text.size : '…'}</dd>
          <dt className="text-stone-400">Unused space inside it</dt>
          <dd className="text-stone-100">{text ? text.unused : '…'}</dd>
        </dl>
      )}
    </section>
  )
}

/** Spec §5.6 "Deckbuilder": whether buy lists leave out basic lands. */
function DeckbuilderSettings() {
  const { data: settings, error } = useSettings()
  const update = useUpdateSettings()
  return (
    <section className={section}>
      <h2 className="text-lg font-semibold text-stone-100">Deckbuilder</h2>
      {error ? (
        <p className="mt-3 text-sm text-rose-300">Couldn't load settings: {error.message}</p>
      ) : (
        <label className="mt-3 flex items-center gap-2 text-sm text-stone-300 pointer-coarse:gap-3">
          <input
            type="checkbox"
            className={checkbox}
            checked={settings?.buylistIgnoreBasics ?? true}
            disabled={!settings || update.isPending}
            onChange={(e) => update.mutate({ buylistIgnoreBasics: e.target.checked })}
          />
          Leave basic lands out of buy lists, cost to finish, and completion
        </label>
      )}
    </section>
  )
}


/** Spec §5.6 "Scanner": auto-commit, default finish, accept uncertain printing. */
function ScannerSettings() {
  const { data: settings, error } = useSettings()
  const update = useUpdateSettings()
  const disabled = !settings || update.isPending
  return (
    <section className={section}>
      <h2 className="text-lg font-semibold text-stone-100">Scanner</h2>
      {error ? (
        <p className="mt-3 text-sm text-rose-300">Couldn't load settings: {error.message}</p>
      ) : (
        <div className="mt-3 space-y-3 text-sm text-stone-300">
          <label className="flex items-center gap-2 pointer-coarse:gap-3">
            <input
              type="checkbox"
              className={checkbox}
              checked={settings?.scanAutoCommit ?? false}
              disabled={disabled}
              onChange={(e) => update.mutate({ scanAutoCommit: e.target.checked })}
            />
            Add manual captures to the collection as soon as they're identified confidently (auto mode's captures wait in
            the queue)
          </label>
          <label className="flex items-center gap-2 pointer-coarse:gap-3">
            <input
              type="checkbox"
              className={checkbox}
              checked={settings?.scanAcceptUncertainPrinting ?? false}
              disabled={disabled}
              onChange={(e) => update.mutate({ scanAcceptUncertainPrinting: e.target.checked })}
            />
            Accept a card whose printing is uncertain, with its likeliest printing (for old cards whose printing doesn't
            matter)
          </label>
          <label className="flex flex-wrap items-center gap-2 pointer-coarse:gap-3">
            Scans start as
            <select
              value={settings?.scanDefaultFinish ?? 'nonfoil'}
              disabled={disabled}
              onChange={(e) => update.mutate({ scanDefaultFinish: e.target.value as Finish })}
              className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-stone-100 pointer-coarse:py-2"
            >
              <option value="nonfoil">Nonfoil</option>
              <option value="foil">Foil</option>
              <option value="etched">Etched</option>
            </select>
            unless the scan shows otherwise
          </label>
        </div>
      )}
    </section>
  )
}

/** Spec §5.6 "API key": masked field, Test, saved to .env. For Claude's deckbuilding help; scanning never uses it. */
function ApiKeySettings() {
  const { data: status, error } = useAiKey()
  const save = useSaveAiKey()
  const test = useTestAiKey()
  const [key, setKey] = useState('')
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const typed = key.trim()
  const saveTyped = () => {
    if (!typed || save.isPending) return
    save.mutate(typed, {
      onSuccess: () => {
        setKey('')
        test.reset()
        setConfirmingRemove(false) // it asked about the key this one replaced
      },
    })
  }
  const remove = () =>
    save.mutate(null, {
      onSuccess: () => {
        setConfirmingRemove(false)
        test.reset()
      },
    })
  return (
    <section className={section}>
      <h2 className="text-lg font-semibold text-stone-100">Anthropic API key</h2>
      <p className="mt-1 text-sm text-stone-400">
        For Claude's deckbuilding help. It's saved in Binder's <code>.env</code> file, readable only by you, and scanning
        never uses it.
      </p>
      {error && <p className="mt-3 text-sm text-rose-300">Couldn't load the key status: {error.message}</p>}
      {status && (
        <p className="mt-3 text-sm text-stone-300">
          {status.configured ? (
            <>
              A key ending in <span className="font-mono text-stone-100">{status.hint}</span> is saved.
            </>
          ) : (
            'No key is saved.'
          )}
        </p>
      )}
      {/* Not a form, and marked for password managers to leave alone: this isn't a sign-in. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="password"
          aria-label="API key"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          // A key typed or pasted on a phone goes in as it is: no capitals or corrections.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder={status?.configured ? 'Paste a new key to replace it' : 'sk-ant-…'}
          value={key}
          onChange={(e) => {
            setKey(e.target.value)
            test.reset()
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
            e.preventDefault()
            saveTyped()
          }}
          className="min-w-0 flex-1 basis-full rounded-md border border-stone-700 bg-stone-900 px-3 py-1.5 font-mono text-sm text-stone-100 outline-none focus:border-amber-500/70 sm:basis-0 pointer-coarse:py-2.5"
        />
        <button type="button" onClick={saveTyped} disabled={!typed || save.isPending} className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-stone-950 hover:bg-amber-400 disabled:opacity-50 pointer-coarse:py-2.5">
          Save
        </button>
        <button
          type="button"
          disabled={(!typed && !status?.configured) || test.isPending}
          onClick={() => test.mutate(typed || undefined)}
          className="rounded-md border border-stone-700 px-3 py-1.5 text-sm text-stone-200 hover:bg-stone-800 disabled:opacity-50 pointer-coarse:py-2.5"
        >
          {test.isPending ? 'Testing…' : 'Test'}
        </button>
        {status?.configured && !confirmingRemove && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => setConfirmingRemove(true)}
            className="rounded-md border border-rose-900 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-950 disabled:opacity-50 pointer-coarse:py-2.5"
          >
            Remove
          </button>
        )}
      </div>
      {status?.configured && confirmingRemove && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
          Remove the saved key? Anthropic shows a key only once, so you'd need a new one.
          <button
            type="button"
            disabled={save.isPending}
            onClick={remove}
            className="rounded-md bg-rose-700 px-2 py-1 text-rose-50 hover:bg-rose-600 disabled:opacity-50 pointer-coarse:px-3 pointer-coarse:py-2"
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() => setConfirmingRemove(false)}
            className="rounded-md border border-stone-700 px-2 py-1 text-stone-300 hover:bg-stone-800 pointer-coarse:px-3 pointer-coarse:py-2"
          >
            Keep it
          </button>
        </div>
      )}
      {test.isSuccess && (
        <p role="status" className="mt-2 text-sm text-emerald-300">
          The key works.
        </p>
      )}
      {test.error && (
        <p role="alert" className="mt-2 text-sm text-rose-300">
          {test.error.message}
        </p>
      )}
    </section>
  )
}
