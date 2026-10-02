# M13: Binder on Windows, and the phone

**Date:** 2026-10-02
**Goal:** Binder runs on a Windows 10/11 PC as well as it runs on the Mac: `pnpm start`, `pnpm run setup`, `pnpm test`, and a
packaged desktop app with a notification-area (tray) icon, with scanning that reads cards with Windows' own text
recognition. An Android phone on the same Wi-Fi is Binder's companion: paired with a code, it opens the PC's Binder in
Chrome (or as an installed web app), with every page usable by touch, and scans cards with its own camera into the PC's
library. The Mac build keeps working exactly as before: every Mac-only piece is chosen per platform, not replaced.

This milestone reverses two of spec §1's non-goals for this fork (the owner's choices, 2026-10-02): network access
(paired phones on the local network only; nothing on the internet) and a phone-friendly UI (the same pages, made
responsive; not a separate phone app).

## Decisions

| Topic | Decision |
|---|---|
| Android | A companion, not a standalone app: the phone uses the PC's Binder over Wi-Fi, paired with a code (the owner's choice). |
| macOS | Keeps working. Platform code branches on `process.platform` (server, scripts, Electron) or `lib/platform.ts` (web) (the owner's choice). |
| Windows library | `%LOCALAPPDATA%\Binder` for the desktop app (not Roaming: the library is large and machine-specific; and not Documents, which OneDrive syncs). `pnpm start` keeps the project's `data/`, as on the Mac. One function, `appLibraryDir()`, names it for every caller. |
| Windows OCR | `native/ocr.ps1`: Windows PowerShell 5.1 (`powershell.exe`, never `pwsh`) using `Windows.Media.Ocr` through WinRT. No build step, nothing to install on Windows 10/11 with English. Same JSON-lines protocol as `native/ocr.swift` (spec §5.1.4). |
| Windows app | Electron, packaged by electron-builder as a per-user NSIS installer that `pnpm app` builds and runs silently (`%LOCALAPPDATA%\Programs\binder`, Start menu shortcut, an entry in Settings → Apps). `pnpm app --no-install` builds `release/win-unpacked/`. A tray icon in the notification area: click opens Binder, right-click → Quit Binder. `Binder.exe --quit` quits a running Binder cleanly. |
| Icons | `scripts/make-icons.ts` (Node, no dependencies) draws the binder page on every platform: the Windows `.ico` and tray icons, and the web app's icons (committed in `src/web/public/icons/`). The Mac keeps `scripts/make-icons.swift` for `Binder.icns` and the menu-bar template. |
| Phone access | Off by default; turned on in Settings → Phone access on the PC. A second listener, `0.0.0.0:4322` (HTTP), and `4323` (HTTPS) when HTTPS is on; `BINDER_LAN_PORT` moves them. The loopback listener, `127.0.0.1:4321`, is unchanged and keeps every rule it has. |
| Pairing | Settings shows a QR code and an 8-digit code, good for 5 minutes and 5 tries. The phone gets a long-lived device cookie (HttpOnly, SameSite=Strict). Devices are listed, renamed and forgotten on the PC. |
| What a phone may do | Everything a person does with their library: browse, search, cards, decks, sets, scanning, playtest, brainstorm, the scanner and deckbuilder settings, and a card data refresh (at most once an hour). Not: the API key, backups, the library file, or phone access itself (PC-only). |
| HTTPS | Optional, in Settings → Phone access. Binder makes its own certificate authority, limited to private addresses (name constraints), which the owner installs on the phone once. It unlocks the live camera, installing Binder as an app, and the clipboard. Without it everything else works, and scanning uses the phone's camera app (one photo per card). |
| Phone scanning | Over HTTP: "Take a photo" opens the camera app; the phone shows the photo with the card guide to fit, then crops, shrinks (≤ 2000 px tall) and sends a JPEG like the desktop's capture. With HTTPS (or Chrome's insecure-origin flag): the live camera, as on the desktop. |
| Playtest on a phone | Touch works (drags, long-press menus, tap to play). Below tablet width the page says it needs a bigger screen. |
| Matcher | Unchanged for Windows until a Windows run of `pnpm ocr:bench` gives data. The PowerShell helper splits a line at wide word gaps to match Vision's lines. |
| Windows firewall | No installer rule (it would need an administrator prompt at every install). Windows asks the first time phone access is turned on; Settings explains the "Private network" requirement and detects a Public Wi-Fi. |

## Interfaces between tasks

Tasks run in parallel pairs, so these are fixed here. A task that needs one of them before it exists builds against
this text.

### Server: paths and the OCR helper (Tasks 3 and 5)
- `src/server/config.ts`: `appLibraryDir(platform = process.platform, env = process.env, home = os.homedir()): string`.
  darwin `~/Library/Application Support/Binder` (path.posix); win32 `(LOCALAPPDATA || home\AppData\Local)\Binder`
  (path.win32); others `(XDG_DATA_HOME || ~/.local/share)/Binder` (path.posix). `APP_LIBRARY_DIR = appLibraryDir()`.
- `src/server/scanner/ocr-helper.ts`:
  ```ts
  export interface OcrHelper {
    /** The helper's command and arguments, or null when this platform has no helper. */
    command: string[] | null
    /** Builds or checks the helper before its first image; a rejection fails that image with its message. */
    prepare?: () => Promise<void>
    /** What the helper is, for logs and the benchmark: 'Apple Vision' | 'Windows OCR' | 'none'. */
    engine: string
  }
  export function ocrHelper(input: { platform: NodeJS.Platform; appRoot: string; buildFromSource: boolean; env?: NodeJS.ProcessEnv }): OcrHelper
  ```
  `BinderOptions` takes `ocr: OcrHelper` in place of `ocrBinary`/`ocrSource`; `AppPaths` keeps `appRoot` and
  `packaged` so Electron's server process builds the same helper.

### Web: platform and clipboard (Task 2; used by Tasks 4, 6 and 9)
- `src/web/lib/platform.ts`: `IS_MAC`, `IS_WINDOWS`, `IS_ANDROID`, `IN_DESKTOP_APP` (Electron), `CAN_USE_LIVE_CAMERA`
  (`isSecureContext && navigator.mediaDevices?.getUserMedia`), `undoKeyLabel` ('⌘Z' or 'Ctrl+Z'),
  `isUndoKey(e, mac = IS_MAC)`, and a `useCoarsePointer()` hook. Pure helpers take the platform as an argument so tests
  run on any OS.
- `src/web/lib/clipboard.ts`: `copyText(text): Promise<void>`: `navigator.clipboard` in a secure context, else a hidden
  textarea and `document.execCommand('copy')`; rejects when neither works.
- `src/web/lib/back-to-close.ts`: `useBackToClose(open, onClose)`: an open overlay pushes a history entry, so Android's
  Back closes it.
- Shared touch classes: tap targets use Tailwind's `pointer-coarse:` variant (≥ 40 px), not user-agent sniffing.
- The bottom tab bar is `fixed bottom-0` below `lg`; pages pad their bottom with the `pb-nav` utility (index.css) so
  sticky bars and toasts sit above it.

### Server: phone access (Tasks 7 and 8; the UI is Task 9)
All under `/api/lan`. The client kind (`pc`, `device`, `unpaired`) comes from the listener a request arrived on and
its cookie.

| Route | Who | Answer |
|---|---|---|
| `GET /api/lan/me` | anyone | `{ client: 'pc' } \| { client: 'device', id, name } \| { client: 'unpaired', https: boolean }` |
| `GET /api/lan` | PC | `LanStatus` (below) |
| `PUT /api/lan` | PC | `{ enabled?: boolean, https?: boolean, address?: string \| null }` → `LanStatus` |
| `POST /api/lan/pairing` | PC | `{ code: '48210937', url: 'http://192.168.1.5:4322/pair#k=…', expiresAt }` |
| `DELETE /api/lan/pairing` | PC | 204 |
| `POST /api/lan/pair` | unpaired phone (LAN listener only) | body `{ code?: string, key?: string, name: string }` → 201 `{ id, name }` and the cookie |
| `PATCH /api/lan/devices/:id` | PC | `{ name }` → the device |
| `DELETE /api/lan/devices/:id` | PC | 204 |
| `POST /api/lan/forget-all` | PC | 204 (rotates the secret: every phone must pair again) |
| `POST /api/lan/forget` | a phone, for itself | 204, and clears the cookie |
| `POST /api/lan/https/rotate` | PC | `LanStatus` (a new certificate authority; phones install it again) |

```ts
interface LanStatus {
  enabled: boolean
  https: boolean
  port: number                // 4322
  httpsPort: number           // 4323
  listening: boolean
  error: string | null        // "Couldn't listen on port 4322: …"
  addresses: Array<{ address: string; interface: string; recommended: boolean }>
  address: string | null      // the chosen one (null: the recommended one)
  url: string | null          // what the phone opens: https://… when HTTPS is on, else http://…
  setupUrl: string | null     // http://<address>:4322/phone-setup when HTTPS is on (installing the certificate)
  caFingerprint: string | null // SHA-256 of the certificate authority, "AB:CD:…", when HTTPS is on
  pairing: { code: string; url: string; expiresAt: string } | null
  devices: Array<{ id: number; name: string; createdAt: string; lastSeenAt: string | null; lastIp: string | null }>
  network: { publicProfile: boolean; name: string } | null   // Windows: the Wi-Fi is "Public"
}
```

Error codes a phone can see: `unpaired` (401), `pc_only` (403, "Change this on the PC running Binder"), `wrong_host`
(403), `cross_site` (403), `use_https` (403), `rate_limited` (429, with Retry-After), `too_large` (413). The loopback
listener keeps `forbidden` and "Requests must come from this computer".

## Tasks

Each task is one commit (or a task commit and its fix commit), titled `M13 Task N: …` as the earlier milestones are.
Every task: keeps the Mac's behavior; matches the code's comment style and density; adds or updates tests; runs
`pnpm typecheck` and the tests it touches, and the whole suite before committing.

1. **Portable tests, and the server on Windows' file system.** `.gitattributes` (LF, CRLF for `.ps1`/`.cmd`), Windows
   clutter in `.gitignore`, `packageManager`, `.node-version`, better-sqlite3 out of `onlyBuiltDependencies` (pnpm
   would otherwise run node-gyp on Windows, needing Visual Studio). Tests that inject failures with chmod (which root
   and Windows ignore) use spies or a folder in a file's place; temp folders are removed after the databases in them
   close; `fileURLToPath` for helper paths; owner-only checks per platform; generous timing budgets. `openDb` closes
   on failure. A retrying rename/remove (`src/server/fs-retry.ts`) for Windows' transient locks (antivirus, indexer,
   OneDrive), used by backups, card data, the key file and scan images. The key file restricted to its owner with
   `icacls` on Windows, and read in CRLF or UTF-16 as Notepad and PowerShell write it. Ctrl+C, closing the console and
   Ctrl+Break stop the terminal Binder cleanly. Static files: no Windows device names (`/CON`), security headers, cache
   headers. `scripts/make-icons.ts` and the web app's icons.
2. **The web app's foundations, and every page on a phone** (but Scan and Playtest). `platform.ts`, `clipboard.ts`,
   `back-to-close.ts`; the manifest, theme color and viewport; touch basics in `index.css`; an error page instead of
   React Router's; the header with a bottom tab bar below `lg`; the card drawer, Search, Library, Sets, Decks, the deck
   editor, Brainstorm and Settings at phone width with touch-sized controls and words where only a tooltip said it;
   Android's Back closes the drawer and dialogs; Ctrl+Z on Windows; Windows wording (`Ctrl`, sizes as Explorer counts);
   CSV import in Windows' encodings, and an Excel-friendly export.
3. **Scanning on Windows.** `native/ocr.ps1`; `ocrHelper()`; the client: hidden window, ASCII requests, a BOM-proof
   reader, validated answers, a longer first-request budget; the Swift helper applies EXIF orientation and caps the
   size; `pnpm run setup` and `pnpm ocr:bench` per platform.
4. **Scanning from the phone.** The Scan page without a live camera: "Take a photo" / "Choose a photo", a review screen
   to fit the card guide, the crop and shrink on the phone; the live camera picks the back camera on a phone and the
   mounted camera on Windows; the queue and its controls at phone width; help and errors per platform.
5. **The Windows desktop app.** `appLibraryDir()`; Electron per platform (camera permission, tray icon and click,
   menus, AppUserModelID, dark title bar, `--quit`, the log's rotation, paths passed safely); `pnpm app` and
   `pnpm app:dev` on Windows (NSIS, silent install, refusing while Binder runs); `pnpm move-library` to
   `%LOCALAPPDATA%\Binder`; the packaged files per platform.
6. **Playtest by touch.** Drags that a finger can make (no browser pan), long-press menus that don't also tap the card,
   tap to play from hand, menus as bottom sheets, a Select mode, Cancel for attaching; the "bigger screen" notice below
   tablet width; Ctrl+Z.
7. **Phone access: the listener, the guard, pairing and devices.** `src/server/lan/`; the guard replacing `localOnly`
   (trust by listener, a loopback peer for the PC, an X-Forwarded-For check for Vite's proxy); the route policy (default
   PC-only, with a test over every route); pairing and the device cookie; migration 009; rate limits and body limits;
   the terminal's `[phone]` line.
8. **Phone access over HTTPS.** The certificate authority and the server certificate (`@peculiar/x509`), reissued when
   the PC's address changes; the HTTPS listener; `/phone-setup` and `/binder-ca.crt` on the HTTP port, which otherwise
   redirects; Windows' network profile check; the tray's Phone access items and the window's `ServerMessage`.
9. **Phone access in the app.** The pairing page an unpaired phone gets; Settings → Phone access on the PC (on/off,
   address, QR code and code, devices, HTTPS and the certificate's install steps, Windows network hints); PC-only
   sections hidden on a phone; a revoked phone back to the pairing page.
10. **The README, the spec, and the follow-ups,** with the owner's first-use checks on Windows and the phone.

## In execution

The tasks ran in the pairs above (1 and 2, 3 and 4, 5 and 6), each reviewed and given a fix commit, with these
differences from the plan:
- **Task 8 was built in two halves.** The certificate authority and Windows' network profile (`certs.ts`,
  `network-profile.ts`) were built beside Task 7, as modules alone; the HTTPS listener, `/phone-setup`,
  `/binder-ca.crt` and the tray's Phone access items were built beside Task 9, on Task 7's merged listener. The
  authority's fix added limits the plan didn't name: extended key usage serverAuth alone, and email addresses and URIs
  constrained to `invalid`, so its key can't sign mail a phone trusts.
- **`LanStatus` grew** past the interface above: `pairingEnded` (Task 7, for the PC's dialog to say how pairing
  ended), `caName` and `caReplaced` (Task 8, which Task 9's Settings shows: the authority's name, and that phones must
  install a new one), and `LanDevice.https` (a phone pairs again when HTTPS is turned on or off). `url` is null unless
  Binder listens, `httpsPort` is the real port while HTTPS listens, and with `BINDER_LAN=0` both ports read 0 and
  `error` says why. `LanSummary`, with `available` for the tray's checkbox, moved to `src/shared/types.ts`. Until Task
  8's second half, `PUT /api/lan {https: true}` was refused (400 `https_unavailable`). The last gaps between Tasks 8 and
  9 were closed after both merged: a wrong code says how many tries are left, Settings asks for the status every 10 s
  even while phone access is off (the tray can turn it on with Settings open), and Settings says when the authority
  was replaced.
- **Pairing**: 5 wrong codes stop one address, and 20 from anywhere close the window, rather than 5 in all, so one
  device on the Wi-Fi can't keep the owner from pairing. A phone forgotten on its own stays forgotten in
  `lan/forgotten`, so a restored backup can't let it back in. Pairing over HTTPS also forgets the phone's HTTP device
  when its old cookie arrives.
- **The gate**: a failed `GET /api/lan/me` shows the PC's view only at the computer's own address; a phone's page says
  it's connecting and asks again, since the PC's view would show a phone the PC's parts.
- **Playtest**: Task 6 first made a finger's tap open the card's menu, Play first; its fix made the tap play, as the
  plan says. The "bigger screen" notice shows only where the pointer is a finger, and on a phone either way up (a screen
  under 500 px tall), not only below tablet width.
- **Scanning**: `OcrHelper.prepare` takes an optional log, so the Mac still logs "[scan] Built the OCR helper", and
  `ocr-helper.ts` also exports `NO_OCR_HELPER`, `powershellCommand` and `checkWindowsOcr`. `ocr.ps1` reads requests from
  `[Console]::In` (a raw stdin stream read nothing under PowerShell 7), and under Constrained Language mode answers once
  and exits.
- **The Windows app**: `pnpm app` asks a running Binder to quit before packaging (electron-builder starts by deleting
  `release\win-unpacked`) instead of refusing, as the Mac's still does. `package.json` names an author, so Windows
  doesn't list Electron's. The app also stops its server when Windows ends the session.
- **Export for Excel** ended as a plain link to the server's `?excel=1` (Tasks 1 and 2 had each added the byte order
  mark on their side), and the playtest's conflict messages say "or on another device" on the page as on the server.
- **The whole-milestone review**, after Task 10's docs were first written, changed:
  - a phone's cookie works only over the scheme it paired with, told by the connection (TLS) rather than the URL: a
    phone paired over HTTP pairs again once HTTPS is on, and the reverse. Settings marks the phones that must, and with
    HTTPS on the pairing dialog and the phones' address say to install Binder's certificate first;
  - a new phone's id is moved past every forgotten one (a restored backup winds SQLite's count back), and Forget all
    keeps `1-<last id>` in `lan/forgotten`, so a backup brought back lists none of the old phones;
  - `src/server/owner-only.ts` is the one way to write a private file, the certificates' writes without blocking and
    every file's leftovers included; `src/server/platform.ts` names the computer (`computerNoun`: Mac, PC or computer,
    in the tray and the server's own lines) and Windows' own programs (`windowsSystemPath`, `windowsPowerShell`);
  - `pnpm app` and `pnpm move-library` count only this user's Binder.exe (`tasklist /FI USERNAME`), and move-library
    clears its staging with retries;
  - `BINDER_LAN_PORT` is a port from 1 to 65534, and on Windows the phones' port failures say what the desktop app
    says of its own;
  - Windows' firewall tip names Node.js JavaScript Runtime under `pnpm start` (`IN_DESKTOP_APP` tells them apart); a
    request with no answer says what to check instead of "Failed to fetch"; a tablet held upright is told to turn it on
    its side; and `useMediaQuery`, `inBinderApp` and `isThisComputersHostname` moved into `lib/platform.ts`.
- **After the review**: a phone's page left open over HTTP as HTTPS came on said "Connecting…" for good, and now opens
  itself again over HTTPS; the setup page and Settings say the certificate vouches for any private address and `.local`
  name, never a website, and that its key, if copied, could pose as another device on the network; and
  `/binder-ca.crt` is served as `application/octet-stream`, so Chrome on Android keeps it in Downloads.
- Nothing ran on a Windows PC, an Android phone or a Mac. What each task couldn't check is in `m13-followups.md`, with
  the owner's first-use checks.
