import { useQuery } from '@tanstack/react-query'
import { useId, useState, type ReactNode } from 'react'
import type {
  AdvancedForm,
  ColorField,
  ColorMode,
  FormatStatus,
  NumericField,
  NumericOp,
} from '../../../shared/search/advanced.ts'
import { apiGet } from '../../lib/api.ts'
import { symbolUrl } from '../ManaText.tsx'

interface SetInfo {
  code: string
  name: string
  releasedAt: string
}
interface TypeCatalog {
  supertypes: string[]
  types: string[]
  subtypes: string[]
}

const FORMATS = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper', 'commander', 'oathbreaker', 'brawl', 'premodern']
const RARITIES = ['common', 'uncommon', 'rare', 'mythic']
const NUMERIC_OPS: NumericOp[] = ['=', '!=', '<', '<=', '>', '>=']
const COLOR_MODES: Array<[ColorMode, string]> = [
  ['exactly', 'Exactly'],
  ['including', 'Including'],
  ['atMost', 'At most'],
]

const input =
  'w-full rounded-md border border-stone-700 bg-stone-900 px-2.5 py-1.5 text-sm text-stone-100 outline-none placeholder:text-stone-600 focus:border-amber-500/70 disabled:opacity-50 pointer-coarse:py-2.5'

/**
 * A text field's keyboard on a phone: names, codes and rules words go into a search as typed, so no capitals,
 * corrections or suggestions, and Enter says Search (it submits the search above).
 */
const searchKeyboard = { autoCapitalize: 'none', autoCorrect: 'off', autoComplete: 'off', spellCheck: false, enterKeyHint: 'search' } as const

interface Props {
  form: AdvancedForm
  scope: 'library' | 'cards'
  /** The query text no longer says what the form says (edited by hand, or changed by navigation). */
  paused: boolean
  onChange: (form: AdvancedForm) => void
  onReset: () => void
}

/** Gatherer-style form (spec §5.2.3). Every change rewrites the query text above it. */
export function AdvancedPanel({ form, scope, paused, onChange, onReset }: Props) {
  const set = <K extends keyof AdvancedForm>(key: K, value: AdvancedForm[K]) => onChange({ ...form, [key]: value })
  const types = useQuery({
    queryKey: ['catalog', 'types'],
    queryFn: ({ signal }) => apiGet<TypeCatalog>('/api/catalog/types', signal),
    staleTime: Infinity,
  })
  const sets = useQuery({
    queryKey: ['catalog', 'sets'],
    queryFn: ({ signal }) => apiGet<SetInfo[]>('/api/catalog/sets', signal),
    staleTime: Infinity,
  })
  const typeListId = useId()
  const setListId = useId()
  const allTypes = types.data ? [...types.data.supertypes, ...types.data.types, ...types.data.subtypes] : []

  return (
    <section className="rounded-xl border border-stone-800 bg-stone-900/40 p-4 sm:p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-stone-100">Advanced search</h2>
          <p className="text-xs text-stone-500">Fill in any fields; they're added to the search text above.</p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 rounded-md border border-stone-700 px-3 py-1 text-xs text-stone-300 hover:bg-stone-800 pointer-coarse:py-2.5 pointer-coarse:text-sm"
        >
          Reset form
        </button>
      </div>
      {paused && (
        <p className="mb-4 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          The search text changed since the form last wrote it, so the form is paused. Reset the form to start over (your text stays).
        </p>
      )}
      <fieldset disabled={paused} className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        <Field label="Name">
          <input className={input} {...searchKeyboard} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. bolt" />
        </Field>
        <Field label="Rules text">
          <input className={input} {...searchKeyboard} value={form.oracle} onChange={(e) => set('oracle', e.target.value)} placeholder="e.g. draw a card" />
        </Field>
        <Field label="Types">
          <TypeChips types={form.types} listId={typeListId} onChange={(next) => set('types', next)} />
          <datalist id={typeListId}>
            {allTypes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
        <Field label="Mana cost">
          <input className={input} {...searchKeyboard} value={form.mana} onChange={(e) => set('mana', e.target.value)} placeholder="e.g. {2}{W}{W} or 2WW" />
        </Field>
        <Field label="Colors">
          <ColorPicker field={form.colors} onChange={(next) => set('colors', next)} />
        </Field>
        <Field label="Commander color identity">
          <ColorPicker field={form.identity} onChange={(next) => set('identity', next)} />
        </Field>
        <div className="grid grid-cols-2 gap-3 md:col-span-2 md:grid-cols-4">
          <Field label="Mana value">
            <NumberInput field={form.mv} onChange={(next) => set('mv', next)} />
          </Field>
          <Field label="Power">
            <NumberInput field={form.power} onChange={(next) => set('power', next)} />
          </Field>
          <Field label="Toughness">
            <NumberInput field={form.toughness} onChange={(next) => set('toughness', next)} />
          </Field>
          <Field label="Loyalty">
            <NumberInput field={form.loyalty} onChange={(next) => set('loyalty', next)} />
          </Field>
        </div>
        <Field label="Rarity">
          <div className="flex flex-wrap gap-3 pt-1">
            {RARITIES.map((r) => (
              <label key={r} className="flex items-center gap-1.5 text-sm text-stone-300 capitalize pointer-coarse:min-h-10 pointer-coarse:gap-2">
                <input
                  type="checkbox"
                  checked={form.rarities.includes(r)}
                  onChange={(e) => set('rarities', e.target.checked ? [...form.rarities, r] : form.rarities.filter((x) => x !== r))}
                  className="accent-amber-500 pointer-coarse:size-5"
                />
                {r}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Set">
          <input className={input} {...searchKeyboard} list={setListId} value={form.set} onChange={(e) => set('set', e.target.value)} placeholder="Set code, e.g. dmu" />
          <datalist id={setListId}>
            {sets.data?.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Format">
          <div className="flex gap-2">
            <select className={input} value={form.format} onChange={(e) => set('format', e.target.value)}>
              <option value="">Any</option>
              {FORMATS.map((f) => (
                <option key={f} value={f} className="capitalize">
                  {f}
                </option>
              ))}
            </select>
            <select
              className={`${input} w-36`}
              value={form.formatStatus}
              onChange={(e) => set('formatStatus', e.target.value as FormatStatus)}
            >
              <option value="legal">Legal</option>
              <option value="banned">Banned</option>
              <option value="restricted">Restricted</option>
            </select>
          </div>
        </Field>
        <Field label="Artist">
          <input className={input} {...searchKeyboard} value={form.artist} onChange={(e) => set('artist', e.target.value)} />
        </Field>
        <Field label="Flavor text">
          <input className={input} {...searchKeyboard} value={form.flavor} onChange={(e) => set('flavor', e.target.value)} />
        </Field>
        <Field label="Keywords">
          <input className={input} {...searchKeyboard} value={form.keywords} onChange={(e) => set('keywords', e.target.value)} placeholder="Comma-separated, e.g. flying, haste" />
        </Field>
        {scope === 'library' && (
          <div className="grid gap-3 border-t border-stone-800 pt-4 md:col-span-2 md:grid-cols-4">
            <Field label="In deck">
              <input
                className={input}
                {...searchKeyboard}
                list={`${setListId}-decks`}
                value={form.inDeck}
                onChange={(e) => set('inDeck', e.target.value)}
                placeholder="deck, built, or a name"
              />
              <datalist id={`${setListId}-decks`}>
                <option value="deck">Any deck</option>
                <option value="built">A built deck</option>
                <option value="prospective">A prospective deck</option>
              </datalist>
            </Field>
            <Field label="Free copies">
              <NumberInput field={form.free} onChange={(next) => set('free', next)} />
            </Field>
            <Field label="Copies owned">
              <NumberInput field={form.qty} onChange={(next) => set('qty', next)} />
            </Field>
            <Field label="Finish">
              <select className={input} value={form.finish} onChange={(e) => set('finish', e.target.value as AdvancedForm['finish'])}>
                <option value="">Any</option>
                <option value="nonfoil">Nonfoil</option>
                <option value="foil">Foil</option>
                <option value="etched">Etched</option>
              </select>
            </Field>
          </div>
        )}
      </fieldset>
    </section>
  )
}

/** A captioned group of controls. Not a <label>: several fields hold more than one control, and a label would
 * forward caption clicks to the first of them (toggling White, or "common"). */
function Field({ label, children }: { label: string; children: ReactNode }) {
  const captionId = useId()
  return (
    <div role="group" aria-labelledby={captionId} className="space-y-1">
      <span id={captionId} className="block text-xs font-medium text-stone-400">
        {label}
      </span>
      {children}
    </div>
  )
}

function NumberInput({ field, onChange }: { field: NumericField; onChange: (field: NumericField) => void }) {
  return (
    <div className="flex gap-1.5">
      <select className={`${input} w-16 px-1.5`} value={field.op} onChange={(e) => onChange({ ...field, op: e.target.value as NumericOp })}>
        {NUMERIC_OPS.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>
      <input className={input} inputMode="decimal" enterKeyHint="search" value={field.value} onChange={(e) => onChange({ ...field, value: e.target.value })} />
    </div>
  )
}

function ColorPicker({ field, onChange }: { field: ColorField; onChange: (field: ColorField) => void }) {
  const toggle = (letter: string) => {
    if (letter === 'C') return onChange({ ...field, colors: field.colors === 'C' ? '' : 'C' })
    const current = field.colors.replace('C', '')
    onChange({ ...field, colors: current.includes(letter) ? current.replace(letter, '') : current + letter })
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {['W', 'U', 'B', 'R', 'G', 'C'].map((letter) => {
        const on = field.colors.includes(letter)
        return (
          <button
            key={letter}
            type="button"
            aria-pressed={on}
            aria-label={{ W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' }[letter]}
            onClick={() => toggle(letter)}
            className={`rounded-full p-0.5 ring-2 transition pointer-coarse:p-2 ${on ? 'opacity-100 ring-amber-400' : 'opacity-40 ring-transparent hover:opacity-80'}`}
          >
            <img src={symbolUrl(letter)} alt="" className="size-6" />
          </button>
        )
      })}
      <select
        className={`${input} ml-1 w-28`}
        value={field.mode}
        onChange={(e) => onChange({ ...field, mode: e.target.value as ColorMode })}
      >
        {COLOR_MODES.map(([mode, label]) => (
          <option key={mode} value={mode}>
            {label}
          </option>
        ))}
      </select>
    </div>
  )
}

function TypeChips({ types, listId, onChange }: { types: string[]; listId: string; onChange: (types: string[]) => void }) {
  const [draft, setDraft] = useState('')
  /** Adds each of the comma-separated values not already there, and keeps `rest` typed. */
  const add = (text: string, rest = '') => {
    const values = text.split(',').map((v) => v.trim())
    const next = [...types]
    for (const value of values) if (value !== '' && !next.includes(value)) next.push(value)
    if (next.length > types.length) onChange(next)
    setDraft(rest)
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-stone-700 bg-stone-900 px-2 py-1">
      {types.map((t) => (
        <span key={t} className="flex items-center gap-1 rounded bg-stone-700 px-1.5 py-0.5 text-xs text-stone-100 pointer-coarse:text-sm">
          {t}
          <button
            type="button"
            aria-label={`Remove ${t}`}
            onClick={() => onChange(types.filter((x) => x !== t))}
            className="text-stone-400 hover:text-stone-100 pointer-coarse:-my-2 pointer-coarse:-mr-1.5 pointer-coarse:size-9 pointer-coarse:text-base"
          >
            ×
          </button>
        </span>
      ))}
      <input
        list={listId}
        value={draft}
        // A comma ends a chip. Read from the text rather than the key: a phone's keyboard doesn't say which key it was
        // (Gboard's keydown is "Unidentified"), and a paste can bring several.
        onChange={(e) => {
          const text = e.target.value
          const comma = text.lastIndexOf(',')
          if (comma === -1) setDraft(text)
          else add(text.slice(0, comma), text.slice(comma + 1).trimStart())
        }}
        onKeyDown={(e) => {
          // Enter adds a typed chip; in an empty Types input it falls through and submits the search.
          if (e.key === 'Enter' && draft.trim() !== '') {
            e.preventDefault()
            add(draft)
          } else if (e.key === 'Backspace' && draft === '' && types.length > 0) {
            onChange(types.slice(0, -1))
          }
        }}
        onBlur={() => add(draft)}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        placeholder={types.length === 0 ? 'e.g. Legendary, Creature, Elf' : ''}
        className="min-w-24 flex-1 bg-transparent py-0.5 text-sm text-stone-100 outline-none placeholder:text-stone-600 pointer-coarse:py-2"
      />
    </div>
  )
}
