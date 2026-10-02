// `pnpm run setup`: gets the OCR helper ready (builds it on a Mac, checks Windows OCR on Windows), creates the database,
// and performs the first Scryfall card-data import.
import { createBulkImporter } from '../src/server/bulk/import.ts'
import { ensureCardNamesCurrent } from '../src/server/cards/repo.ts'
import { BACKUP_DIR, DATA_DIR, DB_PATH, OCR_BINARY, OCR_SOURCE, ROOT_DIR } from '../src/server/config.ts'
import { openLibrary } from '../src/server/db/index.ts'
import { buildOcrHelper } from '../src/server/scanner/ocr-client.ts'
import { checkWindowsOcr, NO_OCR_HELPER, ocrHelper } from '../src/server/scanner/ocr-helper.ts'
import { createScryfallClient } from '../src/server/scryfall/client.ts'
import { trustSystemCertificates } from '../src/server/system-ca.ts'

// Scanning needs the OCR helper; everything else works without it, so a failure here is said and setup carries on.
if (process.platform === 'darwin') {
  try {
    const built = await buildOcrHelper(OCR_SOURCE, OCR_BINARY)
    console.log(built ? `Built the OCR helper at ${OCR_BINARY}` : 'The OCR helper is up to date.')
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
  }
} else if (process.platform === 'win32') {
  try {
    const check = await checkWindowsOcr(ocrHelper({ platform: 'win32', appRoot: ROOT_DIR, buildFromSource: true }))
    if (check.english) {
      console.log(`Windows OCR is ready: scanning reads cards in ${check.english}.`)
    } else {
      console.error(check.error ?? "Windows OCR can't read English on this PC.")
      process.exitCode = 1
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
  }
} else {
  console.log(`${NO_OCR_HELPER} Everything else works.`)
}

const db = openLibrary(DB_PATH, BACKUP_DIR)
console.log(`Database ready at ${DB_PATH}`)
if (ensureCardNamesCurrent(db)) console.log('Rebuilt the card name index for this version.')

// On Windows, the certificates antivirus that checks HTTPS adds, without which Scryfall would look offline.
trustSystemCertificates()
const bulk = createBulkImporter({ db, client: createScryfallClient(), dataDir: DATA_DIR })
if (!bulk.isStale()) {
  console.log('Card data is up to date.')
} else {
  console.log('Importing Scryfall card data (downloads about 80 MB when Scryfall has newer data)…')
  const started = Date.now()
  const timer = setInterval(() => {
    const s = bulk.status()
    const progress = s.state === 'downloading' ? 'Downloading from Scryfall…' : `Importing… ${s.processed.toLocaleString()} printings`
    process.stdout.write(`\r  ${progress}   `)
  }, 500)
  await bulk.start()
  clearInterval(timer)
  const status = bulk.status()
  if (status.state === 'error') {
    console.error(`\nCard data import failed: ${status.error}`)
    process.exitCode = 1
  } else {
    console.log(`\nImported ${status.cardCount.toLocaleString()} printings in ${Math.round((Date.now() - started) / 1000)}s.`)
  }
}
db.close()
