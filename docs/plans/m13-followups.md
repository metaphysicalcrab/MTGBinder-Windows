# M13 follow-ups

These are the deferred findings from milestone 13 (Binder on Windows, and the phone as its companion). They come from
the task reviews and each task's hand-off. None of them blocks M13. Nothing in M13 ran on a Windows PC, an Android
phone, or a Mac (it was built on Linux, with PowerShell 7 for `native/ocr.ps1`'s self-test and Chromium for the pages),
so the checks below are the first real use of most of it. The "Later" sections of `m1-followups.md` to
`m12-followups.md` still hold what earlier milestones left.

## Checks for the owner (the first real use)

### On the Windows PC
1. **Installing.** Node 24.5 or later (24.5 is what trusts Windows' own certificates, §6 of the spec) and pnpm 10
   (`corepack enable`, or pnpm's installer). Clone the repository; `.gitattributes` keeps LF line endings whatever
   `core.autocrlf` says. Then `pnpm install`, on a PC without Visual Studio or Python: it should finish without
   node-gyp. If pnpm asks to approve builds of better-sqlite3 or electron-winstaller, say no: they're meant to be
   left alone.
2. **`pnpm run setup`.** It should say "Windows OCR is ready: scanning reads cards in en-US." If it says Windows OCR
   can't read English, do what it says (Settings → Time & language → Language & region → add English (United States),
   or `Add-WindowsCapability -Online -Name 'Language.OCR~~~en-US~0.0.1.0'` in PowerShell as administrator) and run it
   again. The Scryfall import should run as on the Mac. If it fails as if offline, note the antivirus and Node's
   version.
3. **`pnpm start`.**
   - The "Binder running at http://localhost:4321" line, and no `[library]` warning unless the project is in OneDrive
     (if it is, the warning is right: move the project, or set `BINDER_DATA_DIR`). Open it in Edge or Chrome, and look
     at Library, Search, a card, and a deck.
   - Ctrl+C: "Binder stopped" within a second or two. Note whether pnpm then asks "Terminate batch job (Y/N)?". Start
     it again and close the console window instead: the next start opens the library without complaint.
   - With a USB webcam, if there is one: the camera list, the help note when only the laptop's camera is there, Capture
     and Auto, and a card read by Windows OCR. Note the laptop camera's and the webcam's names in the list (they're
     ranked by name).
   - Settings → Library file's sizes against File Explorer's.
   - Library → Export for Excel opens in Excel with Séance and Lim-Dûl's Vault spelled right. Import CSV reads a file
     Excel saved as "CSV (Comma delimited)", and one saved as "Unicode Text".
   - Playtest: Ctrl+Z undoes on the board and in the mulligans, and the Undo button's tooltip says Ctrl+Z.
4. **`pnpm test`** once. Note any failure with its first lines. These run only on Windows, and have never run:
   - the owner-only checks, which read `icacls`'s real output (`tests/helpers/private.ts`);
   - the OCR helper's parse check, self-test and protocol test in Windows PowerShell 5.1;
   - `ocr-helper.test.ts`'s end-to-end read of a card it draws at a "Zoë card.jpg" path, whose expected text (a title
     box above y 0.1, "U 0201" and "2023 Wizards of the Coast" as separate lines) may need tuning to what Windows OCR
     really reads.
5. **`pnpm ocr:bench`.** Record its table as M5 did for the Mac:
   - for each era (the 1993, 1997, 2003 and 2015 frames, 2020+, showcase/borderless, split/DFC/adventure): cards,
     right, wrong printing, wrong card, printing?, printing? wrong card, unsure, and error;
   - the median and slowest time, the cards read as foil, and the list of cards not identified outright.

   The Mac's was 66 right, 4 with the printing to check, 0 wrong. The bar is 0 confidently wrong. Then copy the Mac's
   `data/bench/*.apple-vision.json` into `data\bench`, and diff each against its `*.windows-ocr.json`
   (`git diff --no-index`): how the lines split, and how •, ★, ©, ™ and 0/O read. That decides the matcher changes in
   Later. To try other values, change a copy of `native\ocr.ps1` (`$GapFactor`, `$TargetLongSide`) and run
   `pnpm ocr:bench --helper path\to\copy.ps1`.
6. **`pnpm app`.** The first build downloads Electron and NSIS for Windows. It should end with "Installed Binder in
   C:\Users\…\AppData\Local\Programs\binder. Open Binder from the Start menu." and say to run `pnpm move-library`
   before opening it. Check the Start menu and desktop shortcuts, and Settings → Apps' entry (its publisher should be
   Binder). Note any SmartScreen prompt.
7. **`pnpm move-library`**, *before* opening Binder the first time. It copies `data\` to `%LOCALAPPDATA%\Binder` and
   prints what it copied (copies, cards, decks). Run it once more while Binder runs, to see it refuse.
8. **The app.** Open Binder from the Start menu.
   - The window's icon and dark title bar; Alt shows the menu bar (File, Edit, View, Help → About Binder).
   - Enter the API key again in Settings; check the collection and decks are all there.
   - Scan: the camera works. Turn off Settings → Privacy & security → Camera → Let desktop apps access your camera:
     Scan says to turn it on; turn it on, and Start it again works. No console window flashes while scans are read.
   - Close the window: the one-time "Binder is still running" notification. Find the icon (Windows 11 may keep it under
     the ^ arrow), and check it reads on the taskbar, light or dark. A click opens the window; a right-click shows Open
     Binder, Phone access, Phone access…, and Quit Binder.
   - `& "$env:LOCALAPPDATA\Programs\binder\Binder.exe" --quit` quits it: the icon goes, and Task Manager shows no
     Binder. `%LOCALAPPDATA%\Binder\Logs\binder.log` ends with the stop.
   - With Binder running, `pnpm app` again: it asks Binder to quit, installs, and the new Binder opens from the Start
     menu.
   - Restart or sign out with Binder running: the next start opens the library without complaint, and `binder.log`
     says the server stopped.
   - `pnpm start` while the app runs fails on port 4321 with one line. Quit one first.

### On the Android phone (Chrome)
1. **Phone access on.** In the app, Settings → Phone access → On (or the tray's Phone access).
   - Windows Defender Firewall asks: allow it on Private networks. Note the dialog's words and the program it names.
   - The address Settings shows should be the Wi-Fi's (recommended); the tray's line and tooltip show the same. With
     Hyper-V or WSL on the PC, check a virtual adapter isn't the one recommended.
   - If Settings warns the Wi-Fi is Public, make it Private as it says; the warning should go within a minute.
2. **Pairing by QR code.** Settings → Pair a phone. Scan the QR code with the phone's camera app, and open the link in
   Chrome: it pairs at once, and the PC's dialog says Paired “Android phone”.
3. **Pairing by code.** On the PC, Forget the phone. On the phone, the next tap shows the pairing page ("This phone
   needs to pair with Binder again"). On the PC, Pair a phone again; on the phone, type the code with one wrong digit
   first (it says how many tries are left), then right. Check the numeric keyboard comes up.
4. **Every page.**
   - Library, Search (All cards, My library, Advanced), a card's details, Sets and a set, Decks, and the deck editor's
     Cards, Add cards and Stats.
   - Brainstorm, with the key set on the PC (Enter makes a new line); let the phone sleep during an answer: no error
     toast.
   - Settings: Card data, Scanner, Deckbuilder, the key line, and This phone; no Backups, Library file or Phone access.
   - More, and Back (the gesture and the button) closing the card details, More, a dialog, and the import panel.
   - Playtest: the "bigger screen" notice either way up, and Show the table anyway; setup and the mulligans.
   - Turn the phone sideways on the deck editor and on Scan.
5. **Scanning by photo** (over HTTP).
   - Scan → Take a photo of the card opens the camera app. Fit the guide (drag, pinch, the slider), Use photo: the
     scan is read on the PC, and appears in the queue on both.
   - A photo taken sideways, Choose a photo from the gallery, a HEIF photo if the camera makes them, Cancel while it's
     sending, and Back on the review.
   - Note whether Chrome reloads the page while the camera app is open (Android can end the tab; the photo would be
     lost).
   - Add the scans from the phone.
6. **HTTPS.** On the PC, Settings → Phone access → Use HTTPS. Note whether the firewall asks again for port 4323.
   - On the phone, open the setup address (or scan its QR code) and tap Download binder-ca.crt. Note whether Chrome
     saves it to Downloads, or hands it to Android's installer, which refuses authorities since Android 11.
   - Install it as the steps say. Note the real menu names on this phone, to correct the steps. Check the fingerprint
     against Settings', and the "Network may be monitored" notice.
   - Restart Chrome, then Continue to Binder: pair again over HTTPS, with a new code. The name offered should now be
     the phone's model. Settings lists one phone, not two.
7. **The live camera** (over HTTPS): Scan opens the back camera (the main one, not a wide or macro one); Capture; Take
   a photo beside it; the camera list's real names ("camera2 0, facing back"); Auto (mounted) with the phone held still
   over the mat.
8. **Binder as an app.** Chrome's ⋮ → Add to Home screen (or Install app). Note whether it installs as an app or only
   adds a shortcut, with Binder's own certificate. Then: the icon under Android's mask; it opens on Library without the
   address bar; the top and bottom fit around the status bar and the gesture bar; Back closes overlays, and leaves the
   app from Library.
9. **The rest.**
   - On the PC, Make a new certificate: the phone can't open Binder over HTTPS until it has the new one; remove the
     old one and install the new one, as Settings and the log say.
   - Turn HTTPS off: the phone pairs again over HTTP.
   - Settings → This phone → Forget this phone, then pair it again.
   - With the window closed, turn Phone access off in the tray: the phone can't reach Binder. Turn it on in the tray
     with Settings open on the PC: Settings follows within 10 s.

### On the Mac (what M13 changed there, which couldn't be run here)
1. **Installing:** `pnpm install`, then `pnpm run setup`: it builds `bin/ocr` from the changed `native/ocr.swift`
   (EXIF orientation and the 4096 px cap, through `CGImageSourceCreateThumbnailAtIndex`), which was never compiled.
   Binder.app's library upgrades with migration 009 (`lan_devices`) at its first start, saving
   `backups/binder-YYYY-MM-DD-before-009.db` first.
2. **Scanning:** with `pnpm start`, `[scan] Built the OCR helper` after touching `ocr.swift`; scanning with the iPhone
   as before; a photo with EXIF Orientation 6 (an iPhone photo taken sideways, scanned from a phone) reads upright.
   `pnpm ocr:bench` still gives 66 / 4 / 0, and now writes `data/bench/*.apple-vision.json` for the PC's diff.
3. **`pnpm icons`** runs `make-icons.swift`, then `make-icons.ts`: `Binder.icns` and the menu-bar template as before,
   and `git status` shows the web icons unchanged.
4. **`pnpm app`**, now through Vite's and electron-builder's APIs: Binder.app installs as before, with the OCR helper
   inside and only the Mac's better-sqlite3 build. It opens, and it scans.
5. **Binder.app:**
   - the menus as before; the camera prompt and the iPhone as before;
   - the menu-bar icon's menu: Open Binder, Phone access, Phone access…, Quit Binder. Turn Phone access on: macOS asks
     whether Binder may accept incoming connections (and may ask again after the next `pnpm app`); the address line;
     the tooltip; Phone access… opens Settings → Phone access;
   - `/Applications/Binder.app/Contents/MacOS/Binder --quit` quits it.
6. **The pages:** the shortcuts list shows ⌘Z, and Cmd+Z undoes; a Control-click on a playtest card opens its menu
   without tapping it, and on a menu's backdrop acts as a right-click; Getting started's Mac text; the key file is still
   mode 600 after saving it; Escape in the main search box now clears it (a side effect of `type=search`).
7. **A phone on the Mac:** pairing and a few pages, as on Windows.

## Later (left after M13)
- **Scanning on Windows** (`src/server/scanner/matcher.ts`, `native/ocr.ps1`), once `pnpm ocr:bench` has run there.
  The matcher is unchanged for Windows until then.
  - `SET_LINE` accepts only •, ★, `*` and · between the set code and the language. If Windows reads the bullet as
    `.`, `-`, `–`, `°`, `+`, `»` or `e`, or drops it, widen the class, or take no separator when the next word is a
    language code (EN, DE, FR, IT, ES, PT, JA, KO, RU, ZHS, ZHT, …). Still require a letter in the set code, and only
    codes the lookups know, exactly or one character off.
  - Re-derive `FOIL_MARKS` from how Windows reads ★.
  - If the gap split misses a collector line, a `NUMBER_LINE` fallback that tries the text before a copyright on the
    same line.
  - Re-check `TITLE_BAND` (0.12), `COLLECTOR_BAND` (0.8) and `PT_BOX_X` (0.7) against Windows' boxes, and `ocr.ps1`'s
    `$GapFactor` (1.5) and `$TargetLongSide` (2400).
  - Ask a Windows webcam for more than an ideal 1920×1440, if the benchmark wants sharper captures.
  - Windows 11 Phone Link's "connected camera": its label is unknown, and if it says "Virtual" it ranks last.
  - Under Constrained Language mode, the helper exits after each answer, so an image sent while it exits may say only
    "The OCR helper stopped (exit code 1)". `ocr.ps1` has no `-Mta`; well-known OCR scripts wait in the default STA.
- **Phone access** (`src/server/lan/`, `src/web/`):
  - Errors a phone sees can name the PC's paths (`GET /api/bulk/status`'s error, a scan's OCR error, which can hold
    the folder's path and so the account's name). Redact them for phones.
  - Ask on the PC before a phone pairs (its name, Allow or Refuse), as well as the code.
  - A per-phone Brainstorm switch: a phone spends the owner's Anthropic money like the PC.
  - A phone's page whose `GET /api/lan/me` is refused with 403 `use_https` keeps saying "Connecting to Binder on the
    PC…" and asking every 10 s, instead of saying where to open Binder (the refusal's message has the address). It
    takes a page loaded over HTTP just before HTTPS came on (a page loaded after is sent to HTTPS). The gate could treat
    `use_https` (and `wrong_host`) as answers.
  - `/binder-ca.crt` is served as `application/x-x509-ca-cert`. If Chrome hands it to Android's installer (which
    refuses authorities since Android 11) rather than saving it, serve it as `application/octet-stream`.
  - The words about what the certificate can vouch for: the setup page says it "can't be used to read this phone's
    traffic to any other site", and Settings that it vouches "never for a website". It can vouch for any private
    address and any `.local` name, so its key, if copied, could pose as another device on the home network (the
    router's page, a printer). Say that plainly, as the README now does.
  - Phone-facing words say "the PC" on a Mac too: the tray's "Phones: this PC isn't on a network a phone can reach",
    the log's, "Connecting to Binder on the PC…", `pc_only`'s "Change this on the PC running Binder", and the setup
    page's "Binder on your PC".
  - `certs.ts` keeps its own non-blocking private-file writer and its own leftovers cleanup (`removeLeftovers`,
    `otherProcessRunning`), which duplicate `owner-only.ts` and `ai/key-store.ts`. Move one shared version into
    `owner-only.ts`.
  - `PORT` and the phones' ports: with `PORT=4322` or `4323` (the old README's example) and phone access on, Binder's
    own two listeners want one port. The phones' then can't listen (EADDRINUSE on Linux; untried on Windows and the
    Mac), and Settings blames "another program". Nothing warns at start. The README's example is now 4330.
  - After the tray's Phone access… scrolls to the section, the `#phone-access` hash is dropped, so a reload of
    Settings doesn't scroll there again.
  - The firewall tips show until a phone has paired, since Binder can't tell whether Windows has asked.
  - An iPhone pairs over HTTP like any phone (untested), but the HTTPS steps are Android's: iOS installs a profile,
    then turns on full trust for it.
  - `tests/helpers/app.ts`'s `makeLanApp` could pass `networkProfile` explicitly; the injected `interfaces` already
    keep the real one from running.
- **The web app on a phone** (`src/web/`):
  - Playtest on a phone held sideways: the header and the tab bar take 114 of 412 px. The notice covers phones now
    (screens under 500 px tall), but a short window could hide the tab bar and fold the header on `/playtest`.
  - The pile and log panels aren't closed by Back: they'd race the menu and dialog entry they share a board with.
  - Move `useMediaQuery` (`components/playtest/use-media-query.ts`) into `lib/platform.ts`, beside `useCoarsePointer`.
  - One `csv-bytes` check is skipped where `TextDecoder` reads windows-1252 as Latin-1 (Node 22): its bytes 0x80–0x9F
    are checked only in a browser.
- **The desktop app on Windows** (`electron/`, `scripts/lib/install-win32.ts`):
  - Neither the installer nor `Binder.exe` is signed. SmartScreen or Smart App Control may stop them on another PC; a
    code-signing certificate would answer that.
  - Ending the session (shutdown, sign-out) is caught by a hidden window that stops the server and waits up to 3 s,
    blocking. It's best effort, and unverified.
  - `tasklist` on a Windows in another language: only its quoted rows are read, so its "no tasks" line shouldn't
    matter. Untested.
  - The Mac could take the dark title bar too (`nativeTheme.themeSource = 'dark'`); it was left as it was.
  - `scripts/setup.ts` still builds the Mac's helper from `OCR_SOURCE` and `OCR_BINARY` rather than through
    `ocrHelper()`, and `buildOcrHelper` lives in `ocr-client.ts` for `scripts/app.ts`'s sake.
- **Windows' file system** (`src/server/fs-retry.ts`, `src/server/startup.ts`):
  - The synchronous retries block the server (`Atomics.wait`) for up to 10 s when a file stays locked (2 s for scan
    images). `certs.ts` shows the asynchronous way.
  - Node 24 itself wasn't run (Node 22.22 here). `tls.setDefaultCACertificates` (24.5) and `import.meta.main` (24.2)
    have fallbacks; with Node 24.0 to 24.4, Windows' own certificates aren't trusted, so HTTPS-checking antivirus would
    make Scryfall look offline. `.node-version` says only 24.
  - The startup sweep deletes only images whose own scan is committed or discarded; a file no scan names (after
    restoring an older backup) stays.
- **Tooling:**
  - A CI matrix: windows-latest, macos-latest, and Ubuntu as a non-root user, plus a Linux job with
    `VITEST_SIMULATE_WINDOWS_LOCKS=1` and PowerShell 7 for `ocr.ps1`'s tests.
  - M13's headless checks (pages at phone width, touch, pairing, Settings → Phone access, photo capture) ran outside
    the repository, as M3's, M8's and M9's did. They could move in with the browser check.
