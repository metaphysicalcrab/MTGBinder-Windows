/**
 * The page a phone opens on the phones' HTTP port to set up HTTPS (spec §5.10): what Binder's certificate is for, how
 * to install it on Android, its name and fingerprint to check it by, and the way on to Binder over HTTPS. Plain HTML
 * from the server, in Binder's colours, as it must work before the phone trusts anything.
 */
export interface PhoneSetup {
  /** The host the phone opened this page at (`192.168.1.5`, `[::1]`), which the way on to HTTPS keeps. */
  hostname: string
  /** Whether HTTPS for phones is on in Settings. */
  on: boolean
  /** The port Binder takes HTTPS on, while it does; null when it can't (Settings → Phone access says why). */
  port: number | null
  /** The certificate authority to install; null when HTTPS is off, or its certificate couldn't be made. */
  authority: { name: string; fingerprint: string } | null
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** "AB:CD:…" (32 bytes) in lines of 8 bytes, which a phone's screen holds and an eye can compare. */
function fingerprintLines(fingerprint: string): string {
  const bytes = fingerprint.split(':')
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 8) lines.push(bytes.slice(i, i + 8).join(':'))
  return lines.map(escape).join('<br>')
}

export function phoneSetupPage(setup: PhoneSetup): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Set up HTTPS · Binder</title>
<style>
  html { background: #0c0a09; color: #e7e5e4; font: 16px/1.5 system-ui, -apple-system, sans-serif; }
  body { max-width: 36rem; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { margin: 0 0 4px; font: 600 28px ui-serif, Georgia, serif; color: #fbbf24; }
  h2 { margin: 0 0 16px; font-size: 18px; font-weight: 600; }
  h3 { margin: 28px 0 8px; font-size: 16px; font-weight: 600; }
  p, li { color: #d6d3d1; }
  .muted { color: #a8a29e; font-size: 14px; }
  ol { padding-left: 1.4em; }
  li { margin: 0 0 16px; }
  b { color: #e7e5e4; }
  code { display: block; margin: 8px 0; padding: 10px 12px; border-radius: 8px; background: #1c1917;
    color: #fde68a; font: 14px/1.6 ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
  a { color: #fbbf24; }
  a.button { display: inline-block; margin: 8px 0 0; padding: 10px 16px; min-height: 24px; border-radius: 8px;
    background: #fbbf24; color: #0c0a09; font-weight: 600; text-decoration: none; }
</style>
<h1>Binder</h1>
<h2>HTTPS on this phone</h2>
${body(setup)}
</html>
`
}

function body({ hostname, on, port, authority }: PhoneSetup): string {
  const openBinder = '<a class="button" href="/">Open Binder</a>'
  if (!on) {
    return `<p>HTTPS for phones is off. To use it, turn it on on the PC, in Settings → Phone access, then open this
  page again.</p>
<p>Meanwhile, Binder works on this phone as it is. ${openBinder}</p>`
  }
  if (!authority) {
    return `<p>Binder couldn't make its certificate. Settings → Phone access on the PC says why.</p>
<p>Meanwhile, Binder works on this phone over HTTP. ${openBinder}</p>`
  }
  const next =
    port === null
      ? `<li>Binder can't take HTTPS connections right now: Settings → Phone access on the PC says why. Meanwhile,
    Binder works on this phone over HTTP. ${openBinder}</li>`
      : `<li>Close Chrome and open it again, so it trusts the certificate, then go on to Binder.
    <a class="button" href="https://${escape(hostname)}:${port}/pair">Continue to Binder</a></li>`
  return `<p>Binder on your PC made its own certificate, so this phone can open Binder over HTTPS: Chrome needs it for
  the live camera, for installing Binder as an app, and for copying. Install it once:</p>
<ol>
  <li>Download the certificate.
    <a class="button" href="/binder-ca.crt" download="binder-ca.crt">Download binder-ca.crt</a></li>
  <li>Open the phone's Settings → Security &amp; privacy → More security settings → Encryption &amp; credentials →
    Install a certificate → CA certificate → Install anyway, and pick binder-ca.crt from Downloads.
    <div class="muted">On a Samsung: Settings → Security and privacy → More security settings → Install from device
    storage → CA certificate. The names differ from maker to maker: searching Settings for "CA certificate" finds
    it. Android asks for a screen lock (a PIN, pattern or password) first if the phone has none.</div></li>
  <li>Check that it's Binder's: in the same place, under Trusted credentials → User, tap
    <b>${escape(authority.name)}</b>. Its SHA-256 fingerprint must be
    <code>${fingerprintLines(authority.fingerprint)}</code>
    as Settings → Phone access on the PC shows it. If it isn't, remove it: this page came over plain HTTP, which
    someone else on the Wi-Fi could have changed.</li>
  ${next}
</ol>
<h3>About this certificate</h3>
<p>It can vouch only for addresses on home and office networks (10.x, 172.16–31.x and 192.168.x) and for .local
  names, so it can't be used to read this phone's traffic to any other site. While it's installed, Android says the
  network may be monitored: that's this certificate.</p>
<p>When the PC makes a new certificate (in Settings → Phone access), remove this one (Trusted credentials → User →
  it → Remove), then install the new one from this page.</p>
<p class="muted">Firefox ignores certificates installed this way: use Chrome.</p>`
}
