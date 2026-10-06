// `pnpm move-library`: copies the library from data/ (or BINDER_DATA_DIR) to the desktop app's folder once (spec
// §3.4): ~/Library/Application Support/Binder on a Mac, %LOCALAPPDATA%\Binder on Windows. Binder must not be running;
// data/ is left as it is, and the API key isn't copied (it's entered again in the app's Settings).
import net from 'node:net'
import os from 'node:os'
import { APP_LIBRARY_DIR, DATA_DIR } from '../src/server/config.ts'
import { portProblem } from '../src/server/startup.ts'
import { APP_PORT } from '../electron/paths.ts'
import { desktopRunning } from './lib/install.ts'
import { describeLibrary, desktopWords, moveLibrary, MoveError, strayLibraryNote } from './lib/move.ts'

/** Whether something answers on the port: Binder from the terminal, or the desktop app. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

const words = desktopWords()
// The app's port, and the one PORT names, where `pnpm start` (or the app) listens instead.
const ports = [APP_PORT]
if (process.env.PORT !== undefined && !portProblem(process.env.PORT)) ports.push(Number(process.env.PORT))
const listening = await Promise.all(ports.map(answers))
if (desktopRunning() || listening.includes(true)) {
  console.error(`Binder is running: quit it (${words.quit}, or Ctrl+C where pnpm start runs), then run pnpm move-library again.`)
  process.exit(1)
}
const stray = strayLibraryNote(process.platform, os.homedir())
if (stray) console.log(stray)
try {
  // The copy and its check take a while on a real library (tens of seconds): say it has started.
  console.log(`Copying your library from ${DATA_DIR} to ${APP_LIBRARY_DIR}…`)
  const summary = await moveLibrary(DATA_DIR, APP_LIBRARY_DIR)
  console.log(`Copied your library (${describeLibrary(summary)}) to ${APP_LIBRARY_DIR}.`)
  console.log(`${words.open} to use it, and enter your Anthropic API key again in Settings → Anthropic API key.`)
  console.log(`Your original is still in ${DATA_DIR}; delete it once you've checked ${words.app}.`)
} catch (err) {
  if (!(err instanceof MoveError)) throw err
  console.error(err.message)
  process.exit(1)
}
