import { useState } from 'react'
import { reportForgotten, useClient } from '../../lib/client.ts'
import { useForgetThisPhone, useLanMe } from '../../lib/lan.ts'
import { useAiKey } from '../../lib/settings.ts'
import { confirmBox, confirmNo, confirmYes, dangerButton, section } from './styles.ts'

/** Spec §5.6 "API key", on a paired phone: whether Brainstorm has a key, which only the PC sets. */
export function ApiKeyOnThePc() {
  const { data: status, error } = useAiKey()
  return (
    <section className={section}>
      <h2 className="text-lg font-semibold text-stone-100">Anthropic API key</h2>
      {error ? (
        <p className="mt-3 text-sm text-rose-300">Couldn't load the key status: {error.message}</p>
      ) : (
        <p className="mt-1 text-sm text-stone-400">
          {!status ? '…' : status.configured ? 'Brainstorm uses the key set on the PC.' : 'Add an Anthropic API key in Settings on the PC.'}
        </p>
      )}
    </section>
  )
}

/** Spec §5.10, on a paired phone: the name the PC knows it by, and forgetting it, which brings the pairing page. */
export function ThisPhoneSettings() {
  const client = useClient()
  const { data: me } = useLanMe()
  const forget = useForgetThisPhone(reportForgotten)
  const [confirming, setConfirming] = useState(false)
  const name = me?.client === 'device' ? me.name : client.kind === 'device' ? client.name : null
  return (
    <section className={section}>
      <h2 className="text-lg font-semibold text-stone-100">This phone</h2>
      <p className="mt-1 text-sm text-stone-400">
        {name ? <>Paired with Binder as “{name}”. </> : 'Paired with Binder. '}
        The PC running Binder renames or forgets it in Settings → Phone access.
      </p>
      {confirming ? (
        <div role="alert" className={`mt-3 ${confirmBox}`}>
          Forget this phone? It must pair again, with a code from the PC, to open Binder.
          <button type="button" disabled={forget.isPending} onClick={() => forget.mutate()} className={confirmYes}>
            Forget
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={confirmNo}>
            Keep it
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={`mt-3 ${dangerButton}`}>
          Forget this phone
        </button>
      )}
    </section>
  )
}
