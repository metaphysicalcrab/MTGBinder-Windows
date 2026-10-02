import { useEffect, useRef, useState } from 'react'
import type { LanDevice } from '../../shared/types.ts'
import { ApiRequestError, apiSend } from '../lib/api.ts'
import { hasPairingKey, takePairingKey } from '../lib/client.ts'
import { codeDigits, deviceModel, groupCode, pairErrorText, phoneNameGuess, waitText } from '../lib/lan.ts'
import { PLATFORM } from '../lib/platform.ts'

type Paired = Pick<LanDevice, 'id' | 'name'>

/** A name for this phone: its model where the browser says it, else what kind of device it is. */
async function guessName(): Promise<string> {
  return phoneNameGuess(await deviceModel(navigator), navigator.userAgent, PLATFORM)
}

/**
 * Pairing this phone with Binder on the PC (spec §5.10): the 8-digit code the PC shows, typed here, or its QR code,
 * whose link opens this page with a key that pairs at once. Shown instead of the app to a phone that isn't paired
 * (ClientGate), outside the app's frame: nothing here asks the API for anything but pairing. `lost`: the phone was
 * paired until a moment ago (as `lastName`, offered again). `pairedAs`: it's paired, and was opened from a pairing QR
 * code: it pairs again with its key only when asked to (that replaces it, and uses up the code), or goes on.
 */
export function PairPage({
  lost,
  lastName = null,
  pairedAs,
  onPaired,
  onSkip,
}: {
  lost: boolean
  lastName?: string | null
  pairedAs: string | null
  onPaired: (device: Paired) => void
  onSkip: () => void
}) {
  const [code, setCode] = useState('')
  /** The name the phone had, or has: it pairs again by that. */
  const [known] = useState(lastName ?? pairedAs)
  const [name, setName] = useState(() => known ?? phoneNameGuess(undefined, navigator.userAgent, PLATFORM))
  // A name typed, or the one the phone had: the model guessed doesn't replace it.
  const named = useRef(known !== null)
  const [fromQrCode] = useState(hasPairingKey)
  /** Paired already, and opened from a QR code: Pair again, or Go on to the library. */
  const [choosing, setChoosing] = useState(pairedAs !== null)
  /** The QR code's key, kept for Pair again. */
  const qrKey = useRef<string | null>(null)
  const [pairing, setPairing] = useState(fromQrCode && pairedAs === null)
  const [error, setError] = useState<string | null>(null)
  /** After too many tries (429): when Pair may be tried again, which it counts down to. */
  const [waitUntil, setWaitUntil] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now)
  const waiting = waitUntil !== null

  useEffect(() => {
    if (waitUntil === null) return
    const timer = setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (at < waitUntil) return
      setWaitUntil(null)
      // Nothing else is said meanwhile: Pair and typing wait.
      setError(null)
    }, 1000)
    return () => clearInterval(timer)
  }, [waitUntil])

  const pair = async (input: { code: string } | { key: string }, as: string) => {
    setPairing(true)
    setError(null)
    try {
      onPaired(await apiSend<Paired>('POST', '/api/lan/pair', { ...input, name: as }))
    } catch (err) {
      setError(pairErrorText(err))
      const wait = err instanceof ApiRequestError ? err.retryAfter : undefined
      if (wait) {
        setNow(Date.now())
        setWaitUntil(Date.now() + wait * 1000)
      }
      setPairing(false)
    }
  }

  useEffect(() => {
    let alive = true
    // Opened from the PC's QR code: pairs with its key as soon as the phone's name is known, unless it's paired already
    // (then only on Pair again). The key is taken once, so StrictMode's second run of this effect finds none, and the
    // first run's pairing goes on.
    const key = takePairingKey()
    if (key) qrKey.current = key
    void guessName().then((guess) => {
      if (!alive && !key) return
      if (!named.current) setName(guess)
      if (key && pairedAs === null) void pair({ key }, known ?? guess)
    })
    return () => {
      alive = false
    }
  }, [])

  const pairAgain = () => {
    setChoosing(false)
    // Without the key (it's never missing), the code is typed instead.
    if (qrKey.current && pairedAs !== null) void pair({ key: qrKey.current }, pairedAs)
  }

  const digits = codeDigits(code)
  const submit = () => {
    if (digits.length !== 8 || !name.trim() || pairing || waiting) return
    void pair({ code: digits }, name.trim())
  }
  const secure = typeof window !== 'undefined' && window.isSecureContext

  return (
    <main className="mx-auto min-h-dvh max-w-md space-y-6 bg-stone-950 px-4 pt-[calc(env(safe-area-inset-top)+2.5rem)] pb-[calc(env(safe-area-inset-bottom)+2.5rem)] text-stone-200">
      <p className="font-serif text-xl font-semibold tracking-wide text-amber-400">Binder</p>
      <div className="space-y-2">
        <h1 className="font-serif text-2xl font-semibold text-stone-50">Pair this phone</h1>
        {lost && <p className="text-amber-200">This phone needs to pair with Binder again.</p>}
        {pairedAs !== null && (
          <p className="text-stone-300">
            This phone is paired as “{pairedAs}”. Pairing it again with this QR code replaces that, and uses up the code.
          </p>
        )}
        {!choosing && (
          <p className="text-stone-400">
            On the PC: <span className="text-stone-200">Settings → Phone access → Pair a phone</span>. Then scan the QR code it shows with
            this phone's camera, or type its code here.
          </p>
        )}
      </div>

      {choosing ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={pairAgain}
            className="w-full rounded-lg bg-amber-500 px-4 py-3 font-medium text-stone-950 hover:bg-amber-400"
          >
            Pair again as “{pairedAs}”
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="w-full rounded-lg border border-stone-700 px-4 py-3 font-medium text-stone-200 hover:bg-stone-800"
          >
            Go on to the library
          </button>
        </div>
      ) : fromQrCode && pairing && !error ? (
        <p role="status" className="text-stone-300">
          Pairing…
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <label className="block space-y-1.5">
            <span className="text-sm text-stone-300">Code</span>
            <input
              value={groupCode(code)}
              onChange={(e) => {
                setCode(codeDigits(e.target.value))
                // How long to wait stays said until Pair can be tried again.
                if (!waiting) setError(null)
              }}
              autoFocus={!fromQrCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              enterKeyHint="go"
              placeholder="8 digits"
              aria-describedby={error ? 'pair-error' : undefined}
              className="w-full rounded-lg border border-stone-700 bg-stone-900 px-4 py-3 font-mono text-2xl tracking-[0.2em] text-stone-50 tabular-nums outline-none placeholder:font-sans placeholder:text-base placeholder:tracking-normal placeholder:text-stone-600 focus:border-amber-500/70"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm text-stone-300">This phone's name, as the PC lists it</span>
            <input
              value={name}
              maxLength={60}
              onChange={(e) => {
                named.current = true
                setName(e.target.value)
              }}
              autoComplete="off"
              enterKeyHint="go"
              className="w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-2.5 text-stone-100 outline-none focus:border-amber-500/70"
            />
          </label>
          <button
            type="submit"
            disabled={digits.length !== 8 || !name.trim() || pairing || waiting}
            className="w-full rounded-lg bg-amber-500 px-4 py-3 font-medium text-stone-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pairing ? 'Pairing…' : waitUntil !== null ? `Try again in ${waitText((waitUntil - now) / 1000)}` : 'Pair'}
          </button>
        </form>
      )}

      {pairedAs !== null && !choosing && !pairing && (
        <button type="button" onClick={onSkip} className="text-amber-300 underline-offset-2 hover:underline pointer-coarse:py-2">
          Go on to the library
        </button>
      )}

      {error && (
        <p id="pair-error" role="alert" className="rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
          {error}
        </p>
      )}

      {!secure && (
        <p className="text-xs text-stone-500">
          The live camera needs HTTPS (Settings → Phone access on the PC). Until then, scanning works by photo.
        </p>
      )}
    </main>
  )
}
