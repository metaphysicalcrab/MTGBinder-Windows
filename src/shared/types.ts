export type Finish = 'nonfoil' | 'foil' | 'etched'

export interface Prices {
  usd: number | null
  usdFoil: number | null
  usdEtched: number | null
}

export interface CardFace {
  name: string
  manaCost: string
  typeLine: string
  oracleText: string
  power: string | null
  toughness: string | null
  loyalty: string | null
  imageNormal: string | null
}

/** One printing, as returned by the API. */
export interface Card {
  id: string
  oracleId: string
  name: string
  faceNames: string[]
  layout: string
  releasedAt: string
  setCode: string
  setName: string
  collectorNumber: string
  rarity: string
  manaCost: string
  cmc: number
  typeLine: string
  oracleText: string
  flavorText: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
  colors: string
  colorIdentity: string
  keywords: string[]
  legalities: Record<string, string>
  finishes: Finish[]
  artist: string | null
  prices: Prices
  imageNormal: string | null
  imageSmall: string | null
  imageArtCrop: string | null
  /** Empty for single-faced cards. */
  faces: CardFace[]
  purchaseUris: Record<string, string>
  scryfallUri: string
  isPromo: boolean
}

export interface Printing {
  id: string
  setCode: string
  setName: string
  collectorNumber: string
  releasedAt: string
  rarity: string
  finishes: Finish[]
  prices: Prices
  imageSmall: string | null
  isPromo: boolean
}

export interface CardDetail {
  card: Card
  printings: Printing[]
  /** Every owned copy of this card identity, across printings and finishes. */
  copies: Copy[]
  ownership: Ownership
}

/** Owned copies of one printing in one finish (a collection row). */
export interface Copy {
  cardId: string
  setCode: string
  setName: string
  collectorNumber: string
  finish: Finish
  quantity: number
  /** Price of one copy in this finish. */
  priceUsd: number | null
  addedAt: string
}

export interface CollectionStats {
  /** Copies owned. */
  totalCards: number
  /** Card identities owned. */
  uniqueCards: number
  /** Σ quantity × the price of each copy's finish, in dollars. Copies with no price add nothing. */
  valueUsd: number
  /** Copies whose finish has no price. */
  unpricedCards: number
  /** When a copy was last added (ISO time), or null for an empty collection. */
  lastAddedAt: string | null
}

/** A set and how much of it the collection holds (spec §5.8): its cards are the card identities among its printings. */
export interface SetProgress {
  code: string
  name: string
  /** Scryfall's set type (`expansion`, `commander`, …); '' in card data imported before set types were kept. */
  setType: string
  /** The release date of the set's earliest printing (YYYY-MM-DD). */
  releasedAt: string
  /** The set's cards with a copy owned from the set, in any of its printings there and any finish. */
  owned: number
  /** The set's cards. */
  total: number
}

/** One card of a set: its printing with the lowest collector number in the set. */
export interface SetCard {
  cardId: string
  oracleId: string
  name: string
  collectorNumber: string
  manaCost: string
  rarity: string
  /** Copies owned of the card's printings in this set, in every finish. */
  copies: number
}

/** A set with its cards, in collector-number order (spec §5.8). */
export interface SetDetail extends SetProgress {
  cards: SetCard[]
}

/** The collection row a change left behind; quantity 0 means none are left. */
export interface CopyCount {
  cardId: string
  finish: Finish
  quantity: number
}

/**
 * How a CSV row resolved: `resolved` names one printing; `ambiguous` found the card but had to pick its printing;
 * `unresolved` can't be imported.
 */
export type ImportRowStatus = 'resolved' | 'ambiguous' | 'unresolved'

export interface ImportRow {
  /** Line in the file where the row starts (the header is line 1). */
  line: number
  status: ImportRowStatus
  /** What the file says. */
  input: { name: string; set: string; collectorNumber: string }
  quantity: number
  finish: Finish
  /** The printing it will add, or null when unresolved. */
  card: { id: string; name: string; setCode: string; setName: string; collectorNumber: string } | null
  /** Why a row is ambiguous or unresolved, or what the import changed (a finish the printing lacks). */
  note: string | null
}

export interface ImportPreview {
  rows: ImportRow[]
  counts: Record<ImportRowStatus, number>
}

/** Copies to add: one entry per CSV row. */
export interface ImportItem {
  cardId: string
  finish: Finish
  quantity: number
}

export interface ImportResult {
  /** Collection rows created or increased. */
  rows: number
  /** Copies added. */
  copies: number
}

/** Autocomplete result: one per card identity, pointing at its default printing. */
export interface CardSummary {
  oracleId: string
  cardId: string
  name: string
  manaCost: string
  typeLine: string
  imageSmall: string | null
}

export type BulkState = 'idle' | 'downloading' | 'importing' | 'error'

export interface BulkStatus {
  state: BulkState
  /** Printings imported so far in the current run. */
  processed: number
  /** Message from the most recent failed refresh; cleared by a successful one. */
  error: string | null
  updatedAt: string | null
  sourceUpdatedAt: string | null
  cardCount: number
}

export interface ApiErrorBody {
  /** `span` is set on query errors: the character range of the query that's wrong. */
  error: { code: string; message: string; span?: { start: number; end: number } }
}

export type DeckStatus = 'prospective' | 'built'

/**
 * Where a card sits in a deck. The maybe board holds candidates: it never counts toward ownership (allocation,
 * completion, the buy list) or the counting format rules (deck size, sideboard, copies, commanders), but legality and
 * commander color identity warnings apply to its cards too.
 */
export type Board = 'commander' | 'main' | 'side' | 'maybe'

/** A deck card's standing (spec §4.3): enough free copies, copies held by other built decks, or copies to buy. */
export type LineStatus = 'owned' | 'in_other_deck' | 'buy'

export type FormatId = 'commander' | 'standard' | 'pioneer' | 'modern' | 'legacy' | 'vintage' | 'pauper' | 'casual'

/** A deck with a card in it: the copies on its boards (commander, main, side), and those on its maybe board. */
export interface DeckRef {
  id: number
  name: string
  status: DeckStatus
  quantity: number
  maybe: number
}

export interface Ownership {
  /** Copies owned across every printing and finish. */
  owned: number
  /** Owned copies not in built decks; negative when built decks claim more than you own. */
  free: number
  /** Every deck with the card on any board, maybe too (a deck with it only there has a quantity of 0). */
  decks: DeckRef[]
}

export type SearchSort = 'name' | 'mv' | 'price' | 'color' | 'rarity' | 'added' | 'quantity'
export type SortDir = 'asc' | 'desc'

/** One search result: a printing plus the owner's stake in that card identity. */
export interface SearchCard {
  cardId: string
  oracleId: string
  name: string
  manaCost: string
  typeLine: string
  setCode: string
  setName: string
  collectorNumber: string
  rarity: string
  power: string | null
  toughness: string | null
  loyalty: string | null
  priceUsd: number | null
  imageNormal: string | null
  imageSmall: string | null
  /** Library only: the finish of the collection row shown (which also sets `priceUsd`). */
  finish: Finish | null
  /** Library only: copies matching the search (per row in the printings view, summed per card in the cards view). */
  quantity: number | null
  ownership: Ownership
}

export interface SearchPage {
  total: number
  /**
   * The total is an estimate: Scryfall's count, which includes the digital-only cards and tokens left out of each page
   * (exact when the whole search fits on its first page).
   */
  estimated: boolean
  page: number
  pageSize: number
  hasMore: boolean
  cards: SearchCard[]
  /** Parts of the query the search engine ignored (Scryfall reports these). */
  warnings: string[]
}

export interface Settings {
  /** Leave basic lands out of buy lists, cost to finish, and completion (spec §4.3; default on). */
  buylistIgnoreBasics: boolean
  /** Add confidently identified scans to the collection right away (spec §5.1.3; default off). */
  scanAutoCommit: boolean
  /** The finish new scans start with, when the printing comes in it (default nonfoil). */
  scanDefaultFinish: Finish
  /** Accept a scan whose card is certain but whose printing isn't, with the likeliest printing (default off). */
  scanAcceptUncertainPrinting: boolean
}

/** Whether an Anthropic API key is set, without the key itself (spec §5.6). */
export interface AiKeyStatus {
  configured: boolean
  /** The key's last four characters, to tell keys apart. */
  hint: string | null
}

export interface DeckSummary {
  id: number
  name: string
  format: FormatId
  status: DeckStatus
  notes: string
  createdAt: string
  updatedAt: string
  /** Copies on each board. */
  boards: Record<Board, number>
  /** Copies in the deck: every board but maybe. */
  cardCount: number
  /**
   * Share of the deck's copies it has available, 0–1 (spec §5.4.1: Σ(n − short) / Σ n); 1 for an empty deck. Basic
   * lands don't count while basics are ignored in buy lists.
   */
  completion: number
  /** What the buy list costs. */
  costToFinish: number
  /** Copies on the buy list that have no price. */
  unpricedToBuy: number
  /** What the deck's copies cost (every board but maybe, owned or not), each at its line's price. */
  valueUsd: number
  /** Copies in the deck (every board but maybe) that have no price, a card gone from the card data's too. */
  unpricedCards: number
  /** WUBRG letters: the commanders' color identity in a commander deck, else every card's. */
  colorIdentity: string
}

/** One card on one board of a deck. */
export interface DeckLine {
  id: number
  oracleId: string
  /** The printing shown: the chosen one, else the card's default printing ('' when the card is gone from the card data). */
  cardId: string
  /** That printing's set code and collector number. */
  setCode: string
  collectorNumber: string
  /** The printing chosen for this line, or null to show the default. */
  preferredCardId: string | null
  name: string
  manaCost: string
  typeLine: string
  cmc: number
  colorIdentity: string
  imageSmall: string | null
  imageNormal: string | null
  quantity: number
  board: Board
  category: string | null
  /** What one copy costs to buy: the cheapest printing's price (spec §4.3), null when none has one. */
  priceUsd: number | null
  /** Every non-maybe line of a card shares its status; a maybe line is judged alone, as if prospective. */
  status: LineStatus
  short: number
  owned: number
  inOtherBuiltDecks: number
  /**
   * Copies of the card that scanning into this deck added to this board (spec §5.1.3). They fill the line's copies
   * before any are added beyond them.
   */
  scanned: number
  /** Format problems with this card (legality, copies, color identity). */
  warnings: string[]
}

export interface BuyListItem {
  oracleId: string
  /** The printing the price comes from. */
  cardId: string
  name: string
  /** Copies short. */
  quantity: number
  priceUsd: number | null
  /** TCGplayer page for that printing, when Scryfall has one. */
  purchaseUrl: string | null
}

export interface BuyList {
  items: BuyListItem[]
  totalUsd: number
  /** Copies with no price. */
  unpriced: number
  /** Basic lands were left out. */
  ignoreBasics: boolean
}

export interface DeckDetail extends DeckSummary {
  lines: DeckLine[]
  /** Problems with the deck as a whole (size, sideboard, commanders). */
  warnings: string[]
  buyList: BuyList
}

export interface DeckImportItem {
  oracleId: string
  cardId: string | null
  quantity: number
  board: Board
  /** A role for the line, such as "Ramp"; a line that already has one keeps it when this is left out. */
  category?: string | null
}

/** How a decklist line matched a card (spec §5.4.2: exact name, then face name, then fuzzy ≥ 0.92). */
export type DeckImportMatch = 'exact' | 'face' | 'fuzzy' | 'unresolved'

export interface DeckImportRow {
  line: number
  quantity: number
  board: Board
  /** The name as written. */
  name: string
  match: DeckImportMatch
  /** Name similarity for fuzzy matches, 0–1. */
  score: number | null
  /** The card it matched; `cardId` is the printing the line named, or null for the default printing. */
  card: { oracleId: string; cardId: string | null; name: string } | null
}

export interface DeckImportPreview {
  rows: DeckImportRow[]
  /** Lines that aren't cards or headings. */
  skipped: Array<{ line: number; text: string }>
  counts: Record<DeckImportMatch, number>
}

export type ScanStatus = 'queued' | 'identifying' | 'confident' | 'review' | 'committed' | 'discarded'

/** The printing a scan settled on (spec §5.1.3). */
export interface ScanCard {
  id: string
  oracleId: string
  name: string
  setCode: string
  setName: string
  collectorNumber: string
  imageSmall: string | null
  finishes: Finish[]
  prices: Prices
}

/** A card the scan might be, with how closely its name matched. */
export interface ScanCandidate {
  cardId: string
  name: string
  setCode: string
  collectorNumber: string
  score: number
}

/**
 * Settings → Library file: how big the library is, how much of it is free space compacting would give back, and its
 * write-ahead log (which compacting also empties into it). Bytes.
 */
export interface LibrarySize {
  bytes: number
  freeBytes: number
  logBytes: number
}

/** Settings → Backups (spec §5.6): when the last backup was made, and the folder backups are kept in. */
export interface BackupStatus {
  lastBackupAt: string | null
  folder: string
}

/** The boards a scan can go to: a physical deck has no maybe board. */
export type ScanBoard = Exclude<Board, 'maybe'>

/** Where a scan goes besides the collection (spec §5.1.3): a deck's board. */
export interface ScanTarget {
  deckId: number
  board: ScanBoard
}

/** One captured card in the scan queue (spec §5.1.2). */
export interface ScanItem {
  id: number
  status: ScanStatus
  /** How it was identified: OCR, or picked by hand. */
  method: 'ocr' | 'manual' | null
  /** Why a review item needs a look: its printing is uncertain, or the card itself is. */
  reason: 'printing' | 'unsure' | null
  /** Taken by auto mode, which is never committed straight away (spec §5.1.3). */
  auto: boolean
  card: ScanCard | null
  finish: Finish
  quantity: number
  confidence: number | null
  candidates: ScanCandidate[]
  error: string | null
  createdAt: string
  /** The deck and board it goes to besides the collection, or null for the collection only. */
  target: (ScanTarget & { deckName: string }) | null
  /**
   * An auto-mode capture of the same printing as the auto-mode capture before it, with no bare-mat capture between:
   * auto mode may have caught one card twice (spec §5.1.3).
   */
  sameCardAsBefore: boolean
}

/** A scan the worker added by itself (auto-commit), for the Scan page to announce. */
export interface AutoAddedScan {
  id: number
  name: string
  copies: number
  deckName: string | null
}

/** The scan queue, the scans auto-commit added in the last minute, and how many bare-mat captures it skipped then. */
export interface ScanQueue {
  items: ScanItem[]
  added: AutoAddedScan[]
  skipped: number
}

/** What a commit added: scans, copies, and per deck the copies that went to it. */
export interface ScanCommitResult {
  items: number
  copies: number
  decks: Array<{ id: number; name: string; copies: number }>
}

/** A prospective deck Claude saved to the deckbuilder. */
export interface CreatedDeck {
  id: number
  name: string
  format: FormatId
  cardCount: number
  /** Share of the deck the owner has available, 0–1. */
  completion: number
  costToFinish: number
  /** Card names Claude gave that match no card, so were left out. */
  unresolved: string[]
}

/** A brainstorm conversation with Claude (spec §5.5). */
export interface ThreadSummary {
  id: number
  /** From the owner's first message; empty until then. */
  title: string
  /** The deck the conversation is about, when it was started from the deck editor. */
  deck: { id: number; name: string } | null
  createdAt: string
  updatedAt: string
}

/** One thing a conversation shows, in order. */
export type ChatItem =
  /** The owner's message; `deck` names the deck whose summary went with it. */
  | { kind: 'user'; text: string; deck: string | null }
  | { kind: 'text'; text: string }
  /** A note Claude wrote while working, such as what it's about to look up (a thinking block, display `updates`). */
  | { kind: 'note'; text: string }
  | { kind: 'tool'; id: string; name: string; activity: string; state: 'running' | 'done' | 'failed'; error: string | null; deck: CreatedDeck | null }
  /** The model declined and another carried on (spec §2 refusal fallbacks). */
  | { kind: 'fallback'; from: string; to: string }
  | { kind: 'notice'; tone: 'info' | 'error'; text: string }

export interface ThreadDetail extends ThreadSummary {
  items: ChatItem[]
  /** Estimated spend so far, in US dollars. */
  costUsd: number
  /** The conversation ends waiting for Claude (an answer failed partway): Continue asks again. */
  canContinue: boolean
  /** The conversation has outgrown Claude's context window: only a new one can go on. */
  tooLong: boolean
  /** Claude is answering right now. */
  busy: boolean
}

/** One server-sent event of a brainstorm answer (POST /api/ai/threads/:id/messages). */
export type ChatEvent =
  /** A new item starts; text and note items then grow by `delta`s. */
  | { type: 'item'; item: ChatItem }
  | { type: 'delta'; text: string }
  /** The owner's first message named the conversation. */
  | { type: 'title'; title: string }
  | { type: 'tool_done'; id: string; state: 'done' | 'failed'; error: string | null; deck: CreatedDeck | null }
  /** Claude has started writing a tool call; its line appears once the call is written. */
  | { type: 'working' }
  /** The answer failed; with `canContinue`, Continue asks again. */
  | { type: 'error'; message: string; canContinue: boolean }
  | { type: 'done' }

/** An address of this PC that a phone on the same network can open Binder at (spec §5.10). */
export interface LanAddress {
  address: string
  /** The network adapter's name: "Wi-Fi", "Ethernet", "en0". */
  interface: string
  /**
   * The one Binder uses when none is chosen: the first on a real adapter, Wi-Fi before Ethernet. Virtual adapters
   * (Hyper-V, WSL, VirtualBox, Docker, VPNs) come last and are never recommended: a phone can't reach them.
   */
  recommended: boolean
}

/** A paired phone, as Settings → Phone access lists it. */
export interface LanDevice {
  id: number
  name: string
  createdAt: string
  lastSeenAt: string | null
  lastIp: string | null
}

/** An open pairing window: the code to type on the phone, and the address its QR code holds. */
export interface LanPairing {
  /** 8 digits, shown as "4821 0937". */
  code: string
  /** `http://<address>:<port>/pair#k=<key>`: opening it pairs the phone without the code. */
  url: string
  expiresAt: string
}

/** Phone access (spec §5.10), as Settings on the PC shows it: GET and PUT /api/lan. */
export interface LanStatus {
  enabled: boolean
  /** Phones use HTTPS: false until it's turned on. */
  https: boolean
  /** The phones' port: 4322 unless BINDER_LAN_PORT moves it. */
  port: number
  /** The HTTPS port, the next one up. */
  httpsPort: number
  listening: boolean
  /** Why phones can't connect: "Couldn't listen on port 4322: …". */
  error: string | null
  /** This PC's addresses on its networks, best first. */
  addresses: LanAddress[]
  /** The address chosen in Settings; null uses the recommended one. */
  address: string | null
  /** What the phone opens: https://… when HTTPS is on, else http://…; null when this PC has no address to give. */
  url: string | null
  /** `http://<address>:4322/phone-setup` when HTTPS is on, for installing the certificate. */
  setupUrl: string | null
  /** The SHA-256 fingerprint of Binder's certificate authority ("AB:CD:…") when HTTPS is on. */
  caFingerprint: string | null
  pairing: LanPairing | null
  /**
   * How the last pairing window ended, until another opens: the phone paired (with its name), the code expired, or
   * there were too many wrong codes. Null while one is open, after one is cancelled, and when there was none.
   */
  pairingEnded: { reason: 'paired' | 'expired' | 'too_many_tries'; name: string | null } | null
  devices: LanDevice[]
  /** On Windows: the network's name, and whether Windows calls it Public (which blocks phones). */
  network: { publicProfile: boolean; name: string } | null
}

/** Who is asking (GET /api/lan/me): this PC, a paired phone, or a phone that isn't paired yet. */
export type LanClient =
  | { client: 'pc' }
  | { client: 'device'; id: number; name: string }
  | { client: 'unpaired'; https: boolean }
