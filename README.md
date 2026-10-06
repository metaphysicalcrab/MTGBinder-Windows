# Binder

Personal MTG collection manager for your Mac or Windows PC, with an Android phone as its companion. On the computer,
open the desktop app (Binder.app on a Mac, Binder from the Start menu on Windows), or run `pnpm start` in a terminal.
Either way it's at http://localhost:4321. A paired phone opens the same Binder over the Wi-Fi (see Your phone).

## First run

On a Mac, in Terminal:

```bash
pnpm install
pnpm run setup      # builds the OCR helper, creates data/binder.db, imports Scryfall card data (~1 min)
pnpm start          # builds the UI and serves everything at http://localhost:4321
```

On a Windows 10 or 11 PC, in PowerShell:

```powershell
pnpm install        # nothing to compile: no Visual Studio or Python needed
pnpm run setup      # checks that Windows OCR reads English, creates data\binder.db, imports Scryfall card data
pnpm start          # builds the UI and serves everything at http://localhost:4321
```

Both need Node 24 and pnpm 10 (`.node-version` and `package.json`'s `packageManager` name the versions). It's
`pnpm run setup`, not `pnpm setup`, which is pnpm's own command for setting pnpm itself up. Ctrl+C stops Binder in the
terminal, closing the library first. An environment variable goes before the command on a Mac (`PORT=4330 pnpm start`),
and in a statement of its own in PowerShell (`$env:PORT=4330; pnpm start`; it lasts until the window closes, and
`Remove-Item Env:PORT` clears it).

Binder opens on **Library**. With an empty collection, it shows three ways to start: scan your cards, import a CSV,
or scan or build a deck. Press `?` (anywhere but a text box or dropdown) for the keyboard shortcuts.

## Binder.app

Binder also comes as a Mac app, with its own window and a menu-bar icon. Build it and put it in Applications with:

```bash
pnpm app            # draws the icons, builds the UI and the OCR helper, packages Binder.app, installs it
```

The first time, move your library into it, with Binder quit:

```bash
pnpm move-library   # copies data/ to ~/Library/Application Support/Binder; data/ is left as it was
```

Then open Binder from Spotlight, Launchpad, or Applications, and enter your Anthropic API key again in Settings (it
isn't copied). Closing the window keeps Binder running in the menu bar, so scans finish and card data refreshes;
click the menu-bar icon, then **Open Binder** (or click the Dock icon) to open it again; **Quit Binder** in the
menu-bar icon's menu, or Cmd+Q, stops it. The same menu turns **Phone access** on or off (Your phone). Opening Binder
again while it runs brings its window forward, and links to Scryfall and other sites open in your browser.
`/Applications/Binder.app/Contents/MacOS/Binder --quit` in Terminal quits a running Binder as Quit Binder does.
The first time you open Scan, macOS asks whether Binder may use the camera; your iPhone appears through Continuity
Camera as it does in a browser. If it's refused (by mistake, or after an update), turn Binder on in System Settings →
Privacy & Security → Camera, then quit and reopen Binder; if its switch is already on and the camera still won't
start, clear the old permission with `tccutil reset Camera local.binder.app` in Terminal, then reopen Binder.
Binder.app is signed on this Mac, not by a developer account, so macOS may ask again after an update.

Binder.app keeps everything in `~/Library/Application Support/Binder`: the library, its backups and card data, the
key, phone access's own files (`lan/`), its window's own files (`Electron/`), and the server's log (`Logs/binder.log`,
the run before in `binder.previous.log`). To update it, quit Binder and run `pnpm app` again. `pnpm start` still runs
Binder from the terminal on the project's `data/`, and says so when Binder.app keeps its own library.

## Binder on Windows

On a Windows PC, Binder is a desktop app too, with its own window and an icon in the notification area, beside the
clock. Build it and install it with:

```powershell
pnpm app            # draws the icons, builds the UI, packages Binder and its installer, installs Binder
```

It installs for your Windows account only, without asking for an administrator: in `%LOCALAPPDATA%\Programs\binder`,
with a Start menu shortcut, one on the desktop, and an entry in Settings → Apps to uninstall it (which never deletes
your library). The installer runs silently and doesn't open Binder. If Binder is running, `pnpm app` asks it to quit
first and waits up to 10 seconds; if it doesn't quit, quit it yourself (right-click its icon → **Quit Binder**) and run
`pnpm app` again. The first build downloads Electron and the installer's tools for Windows. The installer isn't signed,
so Windows may warn about it on another PC. `pnpm app --no-install` builds `release\win-unpacked\Binder.exe` without
installing it.

The first time, move your library into it, with Binder quit:

```powershell
pnpm move-library   # copies data\ to %LOCALAPPDATA%\Binder; data\ is left as it was
```

Then open Binder from the Start menu, and enter your Anthropic API key again in Settings (it isn't copied). Closing the
window keeps Binder running, so scans finish and card data refreshes; the first time, Windows says so. Click the
notification-area icon to open Binder again, or right-click it for **Open Binder**, **Phone access** (Your phone), and
**Quit Binder**, which stops it (so do Ctrl+Q and File → Quit Binder in the window). Windows 11 may keep the icon under
the ^ arrow: Settings → Personalization → Taskbar → Other system tray icons puts it on the taskbar. Opening Binder again
while it runs brings its window forward, and links to Scryfall and other sites open in your browser. The window's menu
bar shows when you press Alt. Shutting down, restarting, or signing out stops Binder too, closing the library first. In
PowerShell, `& "$env:LOCALAPPDATA\Programs\binder\Binder.exe" --quit` quits a running Binder as Quit Binder does.
Binder uses the camera unless Windows keeps it from desktop apps: if Scan says Binder isn't allowed to use the camera,
turn on **Camera access** and **Let desktop apps access your camera** in Settings → Privacy & security → Camera, then
press **Start it again**.

Binder keeps everything in `%LOCALAPPDATA%\Binder`: the library, its backups and card data, the key, phone access's own
files (`lan\`), its window's own files (`Electron\`), and the server's log (`Logs\binder.log`, the run before in
`binder.previous.log`). That's your account's Local folder: not Roaming (the library is large, and this PC's own), and
not Documents, which OneDrive may sync. To update Binder, run `pnpm app` again. `pnpm start` still runs Binder from the
terminal on the project's `data\`, and says so when the app keeps its own library. Phones paired with one library pair
again with the other.

## Your phone

An Android phone on the same Wi-Fi as the computer can use Binder too. In Chrome it opens the computer's Binder, every
page fitted to a phone, and it scans cards with its own camera into the same library. Nothing needs installing on the
phone, and nothing goes beyond your own network: the computer keeps the library and does the work.

**Turning it on.** On the computer, turn on Settings → Phone access, or choose **Phone access** in the menu of Binder's
notification-area (or menu-bar) icon. Binder then also listens on port 4322 for phones, from the computer's own home or
office networks only (addresses like 192.168.x.x, 10.x.x.x, or 172.16–31.x.x). It stays on through restarts until it's
turned off; while it's off, Binder opens only on the computer. Settings shows the address phones open (like
`http://192.168.1.5:4322`) as text and as a QR code, and the terminal's `[phone]` line and the icon's menu say it too.
- On Windows, the first time, Windows Defender Firewall asks whether Binder may use the network (for `pnpm start`, it
  asks about Node.js JavaScript Runtime): allow it on **Private networks**. If that was cancelled, allow Binder (or
  Node.js JavaScript Runtime) in Windows Security → Firewall & network protection → Allow an app through firewall;
  until a phone has paired, Settings names the one to allow. A network Windows calls **Public** blocks phones whatever
  the answer was. Settings says when the PC's is, and how to make it Private: on Windows 11, Settings → Network &
  internet → Wi-Fi → the network's properties → Network profile type → Private network; on Windows 10, Settings →
  Network & Internet → Wi-Fi → the network → Network profile → Private.
- On a Mac, macOS may ask whether Binder may accept incoming connections: choose Allow. It may ask again after
  `pnpm app` rebuilds Binder.app.

A phone that can't reach Binder says it's connecting until it can: check that it's on the same Wi-Fi, and that Binder
runs on the computer with phone access on.

**Pairing.** Each phone pairs once. On the computer, Settings → Phone access → **Pair a phone** shows a QR code and an
8-digit code, good for 5 minutes and for one phone. On the phone, scan the QR code with the camera and open its link in
Chrome: the phone pairs at once. Or open the address in Chrome and type the code. With HTTPS on, the phone installs
Binder's certificate first (HTTPS, below), as the dialog says. The phone is named after its model (over HTTPS; else
"Android phone"), which you can change before pairing. It then stays paired: Chrome keeps its cookie for 400 days,
renewed each day the phone uses Binder. A phone that types 5 wrong codes waits for a new code, and 20 wrong codes from
anywhere end it. Settings → Phone access lists the paired phones, with when and from where each was last seen, and
which must pair again (one paired over HTTP while phones open Binder over HTTPS, or the reverse): rename one,
**Forget** one, or **Forget all phones**. A forgotten phone goes back to the pairing page the next time it uses Binder,
and restoring an older backup neither lets it in again nor lists it. On the phone, Settings → This phone → **Forget
this phone** does the same from there.

**What a phone can do.** Everything you do with your library: Library, Search, Sets, Decks, Scan, Playtest (on a
tablet), and Brainstorm (with the key set on the computer); a card data refresh, at most once an hour; and the Scanner
and Deckbuilder settings. Only the computer sets the Anthropic API key, makes backups, shows or compacts the library
file, and changes phone access itself (pairing, forgetting phones, HTTPS): a phone's Settings leaves those out, and
anything else that tries says "Change this on the PC running Binder". On a phone, the pages are along the bottom
(Library, Search, Scan, Decks, and More for Sets, Brainstorm, Playtest, and Settings); Back closes a card's details, a
dialog, or a menu; the deck editor shows Cards, Add cards, and Stats one at a time; and in Brainstorm, Enter makes a new
line and **Send** sends.

**Scanning with the phone.** Over plain HTTP, Chrome gives a page no live camera, so Scan takes photos: **Take a photo
of the card** opens the camera app, and **Choose a photo** picks one already taken. Hold the phone upright over one
card, filling most of the picture, without glare. Binder then shows the photo with the card guide: drag the guide onto
the card, pinch (or use the slider) to fit it to the card's edges, and tap **Use photo**. The phone crops the photo to
the guide, shrinks it, and sends it as the computer's camera would; the next photo starts with the guide where you left
it. A photo Chrome can't read says to turn off HEIF photos in the camera's settings. With HTTPS (below), Scan uses the
live camera as on the computer, starting with the phone's back camera, and offers **Take a photo** beside it; **Auto
(mounted)** is for a phone mounted over the mat. Below the camera, the capture button stays above the tabs, with how
many scans are ready and to check: tap those words to go to the queue.

**HTTPS.** Chrome lets only a secure page use the live camera or be installed as an app, so Binder can serve phones
over HTTPS too, with a certificate of its own that each phone installs once. Everything else works without it.
1. On the computer, in Settings → Phone access, turn on **Use HTTPS**. Phones then open Binder at
   `https://<address>:4323`, and the HTTP address sends pages there (a page a phone has open over HTTP opens again
   there at its next request).
2. On the phone, in Chrome, open the setup address Settings shows (`http://<address>:4322/phone-setup`, or scan its QR
   code), and tap **Download binder-ca.crt**. Chrome keeps it in Downloads.
3. Android doesn't install a certificate from the download itself. Open the phone's Settings → Security & privacy → More
   security settings → Encryption & credentials → Install a certificate → CA certificate → Install anyway, and pick
   `binder-ca.crt` from Downloads. On a Samsung: Settings → Security and privacy → More security settings → Install from
   device storage → CA certificate. The names vary from maker to maker; searching Settings for "CA certificate" finds
   it. Android asks for a screen lock (a PIN, pattern, or password) first if the phone has none.
4. Check that it's Binder's: under Encryption & credentials → Trusted credentials → User, tap "Binder on <your PC's
   name> (<the day it was made>)". Its SHA-256 fingerprint must be the one Settings → Phone access shows. If it isn't,
   remove it: the download came over plain HTTP, which someone else on the Wi-Fi could have changed.
5. Close Chrome fully, open it again, and tap **Continue to Binder** on the setup page. A phone paired over HTTP pairs
   again there, with a new code from Pair a phone: its pairing works only over HTTP. If HTTPS is turned off later,
   phones paired over HTTPS pair again too.

The certificate can vouch only for addresses on home and office networks (10.x, 172.16–31.x, 192.168.x), for `.local`
names and the computer's own name, and only for a site at one of them (never for mail). So it can't be used to read
the phone's traffic to any site on the internet; someone who copied its key could at most pose as another device on
your own network, such as the router's page. While it's installed, Android says the network may be monitored: that's
this certificate. Its key stays in the library's `lan` folder, private to your account, and backups and
`pnpm move-library` don't copy it: keep the computer as safe as the phone. It lasts 10 years; the server certificate it
signs for the computer's addresses is made again by itself (when an address changes, and before its 397 days end),
which phones don't notice. If you think the key was copied, **Make a new certificate** in Settings → Phone access,
then on each phone remove the old one (Trusted credentials → User → it → Remove) and install the new one from the
setup page. Settings also says when Binder made a new one itself, because the old one's files were missing, damaged,
or near their end. Firefox for Android ignores certificates installed this way: use Chrome.

**Binder as an app on the phone.** Over HTTPS, Chrome's ⋮ menu → **Add to Home screen** (or **Install app**) puts
Binder on the home screen. It opens on Library, in its own window.

**When the computer's address changes.** A phone is paired at the computer's address. If the router gives the computer
another one, Binder's log says so, Settings shows the new address, and each phone pairs again there. A reservation for
the computer in the router's settings (DHCP) keeps its address the same. A computer on several networks (Wi-Fi and
Ethernet, a VPN, or virtual machines' adapters) gives phones its Wi-Fi address first; Settings → Phone access can choose
another.

**Ports.** Phones use port 4322, and 4323 for HTTPS. `BINDER_LAN_PORT` moves them (a port from 1 to 65534, HTTPS on
the next port up), as in `$env:BINDER_LAN_PORT=4422; pnpm start`, and `BINDER_LAN=0` keeps phone access off for that
Binder, whatever Settings says. The desktop app on Windows reads them as environment variables for your account. When
Binder can't listen on a port, Settings says why.

## Searching

Open **Search**. Choose **All cards** (Scryfall, full Scryfall syntax; the default) or **My library** (your
collection). To jump to one card by name, use the **Find a card** box at the top of every page (or press `/`).
Queries use Scryfall syntax: `t:creature c:g mv<=3 o:"draw a card"`, `id<=bg is:commander`, `-t:land r>=rare`.
My library also understands `in:deck`, `in:built`, `in:"Deck Name"`, `free>0`, `qty>=2`, `is:foil`, `is:wanted`, and
`is:unpriced` (copies with no price, which the Library's value leaves out: its "without a price" note links there).
**Advanced ▾** opens a form that writes the query for you. If Scryfall is unreachable, Search offers to search the
local card data instead. Scryfall's totals beyond one page read "About N": it counts digital-only cards that Binder
leaves out.

## Your library

Open any card (from Library, Search, Sets, or the `/` finder) to see **Your copies**. Step them up or down, or pick
a printing and finish under **Add a copy**. **Library** lists what you own, with totals (cards, unique cards, and
value at each copy's finish price), and searches only your collection. Sort it by **Quantity** (with the ↑/↓ button
for either way round) to see what you have the most, or the fewest, copies of.

**Import CSV** reads exports from Moxfield, Deckbox, ManaBox, Archidekt, TCGplayer, and Dragon Shield, or any CSV with
Count and Name columns (add Edition and Collector Number to pin the printing; with those two, the name is optional). It shows how each row matched before
anything is added, and it adds to your library rather than replacing it. It reads a CSV as Excel saves it on Windows
too: UTF-8, Unicode Text (UTF-16), or Windows' own encoding. **Export CSV** writes
`Count,Name,Edition,Collector Number,Foil`, which Moxfield and most other apps can import. On Windows, **Export for
Excel** writes the same file marked as UTF-8, so Excel shows names like Séance and Lim-Dûl's Vault as they are.

## Sets

**Sets** lists every set you own a card from, with how much of it you have: "85 / 276 30%". A set counts as
complete when you own one copy of each card in it, in any printing from that set (a showcase or borderless copy counts
for its card) and any finish; a copy of the same card from another set counts for that set instead. Copies you've put
in decks count too. Percentages round down, so only a complete set shows 100%, with a gold bar, and a set with cards
owned but under 1% shows "<1%". Sort by completion, release date, name, or cards owned, and filter by name or code.
Open a set to see every card in collector-number order, the ones you're missing dimmed; **Missing only** lists just
those. Click a card to add a copy.

## Decks

**Decks** lists your decks: built ones (you've put them together from cards you own) and prospective ones (ideas).
Each shows what the whole deck costs, how complete it is, and what the missing cards cost. In a deck:
- search on the left and press **+** to add cards, or paste a list under **Import / Export** (Arena, MTGO, or
  Moxfield text);
- each card shows ✅ **Owned**, ⚠️ **N held by other built decks**, or 🛒 **Buy N** (hover the icon for the words).
  On the maybe board of a built deck, ⚠️ says **N already used by this deck** when the deck's own other boards hold
  the copies. **Buy list** totals the missing cards with TCGplayer links;
- **Deck health** flags format problems (size, copies, legality, commander color identity) without blocking anything;
- a deck you've scanned into shows **Scanned N of M** in its header, and each card how many of its copies were scanned.

Basic lands are left out of completion, cost to finish, and the buy list by default (Settings → Deckbuilder).

Any card's details also offer **Add to deck**.

## Playtest

**Playtest** is a table for playing your decks by hand: you pilot both seats, or one seat to goldfish, and resolve
every card yourself. Binder moves cards, keeps the counts, and remembers the game; it enforces no rules. Pick a deck
for each seat (or **Nobody** for seat 2), who goes first, and starting life, or press **Playtest** in a deck.

- **Mulligans** follow the playgroup's rule: draw 10, click 3 to put on the bottom (the first one clicked ends up at the
  very bottom), and keep 7. **Mulligan** shuffles and draws 10 again, as often as you like.
- **The table**: the seat you're viewing sits at the bottom, the other seat at the top. **Next turn** untaps the next
  seat's permanents, draws its card, and turns the board to it; **Switch side** (or Tab) turns it by hand. The other
  seat's hand shows only card backs.
- **Cards**: drag a card anywhere on the battlefield, to a hand, onto a library, graveyard, exile, the command zone, or
  the stack in the bar. Drop one on the other seat's battlefield to give it control. Double-click a card in hand to
  play it; click one on the battlefield to tap or untap it. Drag a box, or Shift-click, to select several. Right-click
  a card for everything else: counters, flip, face down, attach, a token copy, an ability on the stack, or move it.
- **Libraries**: click to draw; right-click to draw several, look at the top cards (scry and surveil), search, mill,
  reveal the top card, or shuffle. Click a graveyard or exile to see its cards and drag them out.
- **Tokens**: right-click a card on the battlefield (or a spell on the stack) to make one of the tokens or emblems it
  makes, pictured, in one click. **Create token…** (in a card's menu, or right-click an empty battlefield) searches
  every paper token and emblem Scryfall has, and keeps a form for anything else. Emblems go to the command zone. Card
  data imported by an older Binder has no tokens; it refreshes by itself at the next start. A game started before the
  card data has tokens has none; **Rematch** picks them up.
- **Commander**: commanders start in the command zone, and their tax counts itself. A commander going to a graveyard,
  exile, a hand, or a library asks **Command zone instead?** Commander damage is entered in each seat's panel.
- **Undo** (⌘Z on a Mac, Ctrl+Z on Windows) takes back anything, back to the mulligans. **Log** tells the game as the
  seat you're viewing would know it. The game saves as you play: leave the page or quit Binder, and it's there when you
  come back (on your phone or tablet too: it's the same game). **End game** offers a **Rematch** with the same decks or
  a **New game**.
- **By touch** (a tablet, or a touch screen): a finger drags cards and draws a box to select. Tap a card in hand or the
  command zone to play it, and a library to draw. Press and hold a card, a library, a stack item, or empty battlefield
  (about half a second) for what a right-click opens, as a sheet along the bottom; a tap on a stack item, or on a card
  in a graveyard or exile list, opens its menu too, and the library's ⋯ opens its own. **Select** in the turn bar makes
  taps add cards to the selection or take them out, and **Clear** empties it; attaching has **Cancel**. **View card**
  in a card's menu shows it large, as hovering does with a mouse. Back closes a menu, a dialog, or the card you're
  viewing. Below a laptop's width, the turn bar's Log, Switch side, and End game are under its ⋯. On a phone, either
  way up, Playtest says it needs a bigger screen and offers **Show the table anyway**; setup and the mulligans work
  there. A tablet held upright whose screen is too narrow for the table is told to turn it on its side.

## Brainstorm

Open **Brainstorm** to ask Claude what to build next, or how to improve a deck. Claude searches your library and
Scryfall, reads your decks, and can save an idea as a prospective deck (**Open in deckbuilder**). In a deck, **Brainstorm
with Claude** starts a conversation about that deck. Card names in answers open the card, and Claude's notes show what
it's checking as it works.

Brainstorming needs your Anthropic API key (Settings → Anthropic API key) and uses Claude Opus 5.5. Each conversation
shows an estimate of what it has cost so far (usually a little under what Anthropic bills). Every message sends the
whole conversation again; Anthropic caches it for 5 minutes, and the first message after a pause pays to cache it again.
So a long conversation costs more per message: start a new one for a new idea. A conversation answers one message at a
time. **Stop** ends an answer early and keeps what it said; so does leaving the page, opening another conversation, or
following a deck link while Claude answers. When an answer fails partway, **Continue** asks again.

## Scanning

Open **Scan** and pick your iPhone as the camera. It appears through Continuity Camera when both devices share an
Apple ID with Wi-Fi and Bluetooth on; lock the iPhone and mount it in landscape over the scanning area. Put a card in
the guide and press **Capture** (or Space), or switch to **Auto**, which captures each card once it holds still.
Auto starts by learning the empty mat, so start with the guide clear; the line under the camera says what it's doing.

Binder reads each card with the Mac's own text recognition:
- most cards printed since 2015 come back **Ready**, with their exact printing;
- older cards, which print no set code, often come back as **Check the printing**, with the likeliest one picked;
- anything it can't read is **Not sure**: pick the card from its suggestions or search for it.

Correct the printing, finish, or count on any row, then press **Add N cards to collection**, which adds the ready
rows it counted. A card whose collector line has the foil star (★, which the Mac reads as `*`) starts as **Foil**
when its printing comes in foil.
Auto mode captures a card again when it's nudged or moved; the second row then says "Same card as the scan before it.
Discard it if the camera caught one card twice." Lifting the card, and leaving the mat empty for about a second,
between two copies of it keeps them apart.

To scan a deck you own, choose it (or **New deck…**) under **Scanning into**, or press **Scan cards into this deck** in
the deck. Its cards go to your collection and the deck at once: they first fill the copies the deck already lists, so a
deck you planned first isn't doubled, and only extra copies are added. Each row says which deck and board it goes to,
with **Change** for a scan taken while the wrong deck was chosen. The deck stays chosen for the rest of the session;
check **Scanning into** before you start. If you forgot, **Send every scan here to…** above the queue moves every scan
waiting there to the right deck (and new captures follow). A row you accept with **Looks right** reads **Ready ·
confirmed**. Auto mode doesn't photograph the empty mat; if it ever does, the capture is skipped and the queue says how
many.

Scanning happens entirely on this Mac. Settings → Scanner can **Add manual captures to the collection as soon as
they're identified confidently** (auto mode's captures always wait in the queue), choose what **Scans start as**, or
**Accept a card whose printing is uncertain, with its likeliest printing** (old cards; never one whose set, number, or
year contradicted its name). (Settings → Anthropic API key is for Claude's deckbuilding help, saved in `.env` and
readable only by you.)

Scanning needs Xcode's command line tools (`xcode-select --install`) to build the OCR helper, `bin/ocr`, from
`native/ocr.swift`; the server rebuilds it when the source changes. `pnpm ocr:bench` measures recognition on about 70
Scryfall card images, downloaded once into `data/bench`.

## Scanning on Windows

On a Windows PC, Scan works the same way with a camera over the scanning area. A USB webcam mounted over the mat,
looking straight down, appears in the camera list once it's plugged in, and Binder picks it over a laptop's own camera
(and remembers the one you choose). Or scan with your phone (Your phone). Binder reads each card with Windows' own text
recognition, Windows OCR, through Windows PowerShell: on Windows 10 or 11 with English there's nothing to build or
install, and scanning happens entirely on the PC. `pnpm run setup` says whether Windows OCR reads English here. If it
doesn't, add English (United States) in Settings → Time & language → Language & region, or install only its text
recognition, in PowerShell as administrator:

```powershell
Add-WindowsCapability -Online -Name 'Language.OCR~~~en-US~0.0.1.0'
```

A PC whose organization runs PowerShell under a device policy (Constrained Language mode) keeps Binder from Windows
OCR, and each scan's error says so. How well Windows OCR reads cards is still to be measured: `pnpm ocr:bench` runs the
same benchmark as on a Mac, and keeps what each engine read beside the images
(`data\bench\<set>-<number>.windows-ocr.json`; a Mac's are `.apple-vision.json`), so the two can be compared.
`pnpm ocr:bench --helper <file>` reads with another helper, such as a changed copy of `native\ocr.ps1`.

## Keyboard shortcuts

`?` lists them. `/` finds a card. `g` then a letter goes to a page: `g l` Library, `g c` Scan, `g d` Decks,
`g p` Playtest, `g s` Search, `g e` Sets, `g b` Brainstorm, `g t` Settings. On the Scan page, Space captures and `a`
switches between Auto and Manual. On the Playtest page, `t` taps, `f` flips, `+` and `-` add or remove a +1/+1
counter (on the card under the pointer, or the selection), `d` draws, Tab switches side, and ⌘Z undoes (Ctrl+Z on
Windows). None of them fire while a text field or dropdown has focus. (Space still captures on a focused dropdown,
instead of opening it.) In the Windows app, Ctrl+W closes the window and Ctrl+Q quits Binder.

## Development

```bash
pnpm dev            # API on :4321 (auto-restarts) + Vite on http://localhost:5173
pnpm app:dev        # the desktop app's window, run from the project on data/ (no packaging): its key is data/.env
                    # (not the project's .env), and it writes data/Electron/ and data/Logs/
pnpm app --no-install   # packages the desktop app into release/ (Binder.app, or win-unpacked\Binder.exe), no install
pnpm test           # unit and integration tests
pnpm typecheck
```

Card data refreshes automatically at startup when it's older than 7 days (or when a Binder update needs
something new from it), or from Settings → Card data.
Everything lives in `data/` (database, downloads, and backups in `data/backups`: a backup is written when Binder
starts and the last one is over 24 hours old, and the newest 7 are kept). Phone access keeps its own files in
`data/lan/` (the phones' secret, the phones forgotten, and the HTTPS certificates, private to you), which backups
leave out.
Settings → Backups shows the last backup and the folder, and **Back up now** saves one on demand (once today's backup
exists it saves an extra copy; the newest 3 extra copies are kept, apart from the daily 7).
Before a Binder update changes the database's structure, it also saves `binder-YYYY-MM-DD-before-NNN.db` there (the
newest 3 are kept); if it can't, it doesn't start, and the database is left as it was.
To restore a backup, stop Binder and copy it over `data/binder.db` (Binder.app's is
`~/Library/Application Support/Binder/binder.db`, and Binder on Windows' `%LOCALAPPDATA%\Binder\binder.db`), deleting
`binder.db-wal` and `binder.db-shm`. Set `BINDER_DATA_DIR` to use a different folder.
Replacing card data leaves unused space inside `data/binder.db`; Settings → Library file shows how much (its size
also counts the log beside the file; on Windows, sizes count as File Explorer counts them), and **Compact the
library** gives it back (after a backup).
If port 4321 is taken (Binder may already be running, from a terminal or as the desktop app), start with
`PORT=4330 pnpm start` (in PowerShell, `$env:PORT=4330; pnpm start`). Ports 4322 and 4323 are the phones' (Your phone).

On Windows:
- `pnpm install` builds nothing: better-sqlite3 loads the prebuilt binary it comes with (`package.json` tells pnpm not
  to build it), so no Visual Studio or Python is needed. `.gitattributes` keeps text files with LF line endings in every
  checkout, and Windows' own scripts (`.ps1`, `.cmd`, `.bat`) with CRLF, which Windows PowerShell 5.1 expects.
- `pnpm test` runs the same suite, plus a few tests of Windows' own: files made private to you (`icacls`), and the OCR
  helper reading a card it draws, with Windows OCR. The OCR helper's self-test and protocol tests run in Windows
  PowerShell there.
- At start, Binder warns when the library is in OneDrive (which copies it while Binder writes it), on a network share,
  or at a path long enough for Windows to refuse its files: set `BINDER_DATA_DIR` to a folder elsewhere. If Windows
  refuses a port (it keeps some for Hyper-V, WSL, or Docker), `netsh interface ipv4 show excludedportrange
  protocol=tcp` lists them; start with `$env:PORT` set to another.

Windows' parts are checked on a Mac or Linux too. The OCR helper's self-test and protocol tests run in PowerShell 7
(`pwsh`) when it's on the PATH, or in the PowerShell that `BINDER_TEST_POWERSHELL` names, and are skipped without one.
On Linux, `VITEST_SIMULATE_WINDOWS_LOCKS=1 pnpm test` refuses, as Windows does, to delete or rename a database file
that's open, so a test that cleans up before closing a database fails there as it would on Windows.

A phone can use the dev server: Vite's proxy passes the phone's address on to Binder (`X-Forwarded-For`), so it's a
phone there too, paired with the code as usual, and only while phone access is on. Vite listens only on this computer
unless it's told otherwise: run the two halves yourself (`node --watch src/server/main.ts`, and
`pnpm exec vite --host` beside it), and open `http://<address>:5173` on the phone.
