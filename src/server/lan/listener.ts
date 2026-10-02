import type { Server } from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'
import { serve, type HttpBindings } from '@hono/node-server'
import type { Listener } from '../http.ts'

/** The app's fetch, as a listener calls it: Node's request and response, and which listener it is. */
export type ListenerFetch = (
  request: Request,
  env: HttpBindings & { listener: Listener },
) => Response | Promise<Response>

/** What an HTTPS listener serves: the server certificate's private key, and its chain (PEM). */
export interface TlsCertificate {
  key: string
  cert: string
}

/** The phones' listener (spec §5.10), which phone access starts and stops while Binder runs. */
export interface LanListener {
  /** Starts listening. A failure is kept in `error` (and the promise still resolves): it never stops Binder. */
  start(): Promise<void>
  /** Stops listening, closing the connections phones keep open. */
  stop(): Promise<void>
  /** HTTPS: serves another certificate from now on, to new connections, without stopping (the PC's address changed). */
  setCertificate(certificate: TlsCertificate): void
  readonly listening: boolean
  /** The port: the one it was given (0 when that's no port), or the one the system picked for 0 once listening. */
  readonly port: number
  /** "Couldn't listen on port 4322: …", from the last start; null once it listens, and once it's stopped. */
  readonly error: string | null
}

export interface LanListenerOptions {
  port: number
  /** 0.0.0.0, every IPv4 network the PC is on; tests listen on 127.0.0.1, so the firewall asks nothing. */
  host: string
  fetch: ListenerFetch
  /** Whether a peer may connect at all: others' connections are closed as they open, before a request is read. */
  allows(remote: string | undefined): boolean
  /** For HTTPS: the certificate it serves, asked for at each start. Without it, HTTP. */
  certificate?: () => TlsCertificate
  platform?: NodeJS.Platform
}

/** Why the phones' port (with `https`, their HTTPS port) can't be listened on, in a line for the log and Settings. */
export function lanListenFailure(
  err: NodeJS.ErrnoException,
  port: number,
  platform = process.platform,
  https = false,
): string {
  const reserved = platform === 'win32' ? ' (Windows may keep it for Hyper-V, WSL or Docker)' : ''
  const why =
    err.code === 'EADDRINUSE'
      ? 'another program is using it. Set BINDER_LAN_PORT to use another port'
      : err.code === 'EACCES'
        ? `Binder isn't allowed to use it${reserved}. Set BINDER_LAN_PORT to use another port`
        : err.message
  return `Couldn't listen on port ${port}${https ? ' for HTTPS' : ''}: ${why}`
}

/**
 * Serves the app on the phones' port with the request marked as the phones' (`listener: 'lan'`), so the guard applies
 * their rules: over HTTP, or over HTTPS with a certificate (spec §5.10). Requests over HTTPS have `https://` URLs,
 * which is how the routes tell them apart (cookie.ts).
 */
export function createLanListener(options: LanListenerOptions): LanListener {
  const valid = Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535
  let server: Server | https.Server | null = null
  let starting: Promise<void> | null = null
  let port = valid ? options.port : 0
  let error: string | null = null
  const failure = (err: NodeJS.ErrnoException, at: number) =>
    lanListenFailure(err, at, options.platform, options.certificate !== undefined)

  function listen(): Promise<Server | https.Server> {
    return new Promise((resolve, reject) => {
      const fetch: Parameters<typeof serve>[0]['fetch'] = (request, env) =>
        options.fetch(request, { ...(env as HttpBindings), listener: 'lan' })
      const tls = options.certificate?.()
      const secure = tls ? { createServer: https.createServer, serverOptions: { key: tls.key, cert: tls.cert } } : {}
      const created = serve({ fetch, port: options.port, hostname: options.host, ...secure }, (info) => {
        port = info.port
        resolve(created)
      }) as Server | https.Server
      created.on('connection', (socket: Socket) => {
        if (!options.allows(socket.remoteAddress)) socket.destroy()
      })
      created.once('error', reject)
    })
  }

  async function start() {
    if (!valid) {
      error = "Couldn't listen for phones: BINDER_LAN_PORT must be a port number from 1 to 65535"
      return
    }
    try {
      server = await listen()
      error = null
      // Kept, rather than thrown where nothing would catch it.
      server.on('error', (err: NodeJS.ErrnoException) => (error = failure(err, port)))
    } catch (err) {
      error = failure(err as NodeJS.ErrnoException, options.port)
    }
  }

  return {
    start() {
      if (server) return Promise.resolve()
      starting ??= start().finally(() => (starting = null))
      return starting
    },
    async stop() {
      await starting
      const closing = server
      server = null
      port = valid ? options.port : 0
      error = null // a failed start's, which no longer applies once phone access is off
      if (!closing) return
      await new Promise<void>((resolve) => {
        closing.close(() => resolve())
        // Connections a phone's browser keeps open would hold close() back.
        closing.closeAllConnections()
      })
    },
    setCertificate(certificate) {
      if (server instanceof https.Server) server.setSecureContext({ key: certificate.key, cert: certificate.cert })
    },
    get listening() {
      return server !== null
    },
    get port() {
      return port
    },
    get error() {
      return error
    },
  }
}
