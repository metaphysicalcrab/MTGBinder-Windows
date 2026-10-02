import { APP_LIBRARY_DIR, DATA_DIR, ENV_PATH, HOST, OCR_BINARY, OCR_SOURCE, PORT, WEB_DIST_DIR } from './config.ts'
import { type RunningBinder, startBinder, StartupError } from './start.ts'
import { appLibraryNote, portProblem, stopOnSignals } from './startup.ts'

// Binder from the terminal (`pnpm start`): the library in data/ (or BINDER_DATA_DIR), the key in the project's .env.

// A PORT that isn't a port number is said in one line, before anything else happens.
const badPort = portProblem(process.env.PORT)
if (badPort) {
  console.error(badPort)
  process.exit(1)
}

const note = appLibraryNote(DATA_DIR, APP_LIBRARY_DIR)
if (note) console.log(note)

let binder: RunningBinder
try {
  binder = await startBinder({
    dataDir: DATA_DIR,
    envPath: ENV_PATH,
    webDistDir: WEB_DIST_DIR,
    ocrBinary: OCR_BINARY,
    ocrSource: OCR_SOURCE,
    port: PORT,
    host: HOST,
  })
} catch (err) {
  // A library that can't be opened, or a port in use, is said in one line, not as a stack trace.
  if (!(err instanceof StartupError)) throw err
  console.error(err.message)
  process.exit(1)
}
// Ctrl+C (and on Windows, Ctrl+Break or closing the console window) closes the library before Binder exits.
stopOnSignals(binder)
