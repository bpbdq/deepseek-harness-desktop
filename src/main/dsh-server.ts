/**
 * Spawn and supervise the dsh server child process.
 *
 * The child is a plain Node process. The pinned Node that ships inside the
 * runtime is preferred; re-executing Electron as Node is only a fallback for
 * hosts whose own Node is new enough for the harness.
 *
 * Contract with src/server/server.mjs:
 *   - it prints one line `dsh web: <url>?token=<token>` once the web server is up
 *   - it prints `[dsh-desktop] ready` afterwards, as our readiness signal
 *   - everything else on stdout/stderr is forwarded to the app log
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { resolve } from 'node:path'
import type { RuntimeLocation } from './paths'

/** One parsed readiness announcement from the server child. */
export interface ServerReady {
  /** Canonical loopback URL *without* the launch token, e.g. http://127.0.0.1:58645 */
  url: string
  /** The authenticated URL including ?token=..., used for the initial cookie exchange. */
  authenticatedUrl: string
  /** The OS-assigned listen port. */
  port: number
}

export interface ServerOptions {
  runtime: RuntimeLocation
  /** Harness home (DSH_HOME) for this app instance. */
  dshHome: string
  /** Workspace root handed to the agent; also the child's cwd. */
  workspace: string
  /** Extra environment for the child, e.g. decrypted credentials. */
  env?: Record<string, string>
  /** Milliseconds to wait for the readiness line before treating boot as failed. */
  readyTimeoutMs?: number
}

const READY_PATTERN = /^dsh web:\s+(?<url>\S+)/u
const DESKTOP_READY = '[dsh-desktop] ready'

/**
 * Ensure the boot script exists at `<runtime>/server.mjs` and return that path.
 *
 * Node resolves bare specifiers from the script's own directory upward, so the
 * script must live beside the runtime's `node_modules`. Running the shipped copy
 * in place (`resources/server/`) fails on any install path without a reachable
 * ancestor `node_modules` — for example `D:\Program Files\…`, where the lookup
 * walks up to the drive root and finds nothing.
 *
 * The copy is refreshed when the content differs, so a shell update that changes
 * the boot script takes effect without reinstalling the runtime, and an updated
 * runtime (which has no copy of its own) gets one too.
 *
 * @param runtime - the resolved runtime location.
 * @returns the absolute path to execute.
 */
function resolveServerEntry(runtime: RuntimeLocation): string {
  const target = runtime.serverRunEntry
  if (resolve(runtime.serverEntry) === resolve(target)) return target

  try {
    for (const name of ['client-module-cache.mjs', path.basename(runtime.serverEntry)]) {
      const source = readFileSync(path.join(path.dirname(runtime.serverEntry), name))
      const destination = name === path.basename(runtime.serverEntry) ? target : path.join(runtime.dir, name)
      let current: Buffer | undefined
      try {
        current = readFileSync(destination)
      } catch {
        current = undefined
      }
      if (current === undefined || !current.equals(source)) {
        mkdirSync(runtime.dir, { recursive: true })
        writeFileSync(destination, source)
      }
    }
    return target
  } catch {
    // If the copy fails, fall back to the shipped location: an install with a
    // reachable ancestor node_modules still works, and a module-resolution error
    // there is more informative than a failure in our own bookkeeping.
    return runtime.serverEntry
  }
}

/**
 * Owns one dsh server child process and its lifecycle.
 *
 * Emits: `ready` (ServerReady), `exit` ({code, signal}), `log` ({stream, line}).
 */
export class DshServer extends EventEmitter {
  private child: ChildProcess | undefined
  private stopping = false
  private readyInfo: ServerReady | undefined

  constructor(private readonly options: ServerOptions) {
    super()
  }

  /** The readiness announcement, once received. */
  get ready(): ServerReady | undefined {
    return this.readyInfo
  }

  /** Whether the child process is currently alive. */
  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed
  }

  /**
   * Start the child and resolve once it announces its URL.
   * @returns the readiness announcement.
   */
  async start(): Promise<ServerReady> {
    if (this.child !== undefined) throw new Error('dsh-desktop: server already started')

    const { runtime, dshHome, workspace, env, readyTimeoutMs = 120_000 } = this.options

    // Prefer the pinned Node that ships with the runtime: Electron's own Node may
    // be older than the dsh runtime requires. Falling back to re-executing
    // Electron as Node is only correct on an Electron whose Node is new enough.
    const useBundledNode = runtime.nodeBinary !== undefined
    const program = useBundledNode ? runtime.nodeBinary! : process.execPath

    // Put the pinned Node on the child's PATH so any tool the agent runs that
    // shells out to `node` finds a known-good version instead of whatever the
    // host happens to have (or nothing at all). The runner process itself always
    // uses process.execPath, so this only affects tool-spawned commands.
    const nodeDir = useBundledNode ? path.dirname(program) : undefined
    const pathValue = process.env['PATH'] ?? ''
    const childPath =
      nodeDir === undefined ? pathValue : `${nodeDir}${path.delimiter}${pathValue}`

    const child = spawn(
      program,
      [
        resolveServerEntry(runtime),
        '--dsh-home',
        dshHome,
        '--install-anchor',
        runtime.installAnchor,
        '--workspace',
        workspace,
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          ...env,
          ...(useBundledNode ? { PATH: childPath } : { ELECTRON_RUN_AS_NODE: '1' }),
          DSH_HOME: dshHome,
          DSH_DESKTOP: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child

    return await new Promise<ServerReady>((resolve, reject) => {
      let settled = false
      let tail: string[] = []

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`dsh-desktop: server did not become ready within ${readyTimeoutMs}ms`))
      }, readyTimeoutMs)

      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }

      const onLine = (stream: 'stdout' | 'stderr', line: string): void => {
        this.emit('log', { stream, line })
        tail.push(line)
        if (tail.length > 40) tail = tail.slice(-40)

        if (stream !== 'stdout') return
        const match = READY_PATTERN.exec(line)
        if (match?.groups?.url !== undefined) {
          const authenticatedUrl = match.groups.url
          const parsed = new URL(authenticatedUrl)
          this.readyInfo = {
            url: `${parsed.protocol}//${parsed.host}`,
            authenticatedUrl,
            port: Number(parsed.port),
          }
          this.emit('ready', this.readyInfo)
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(this.readyInfo)
          return
        }
        if (line.trim() === DESKTOP_READY && !settled) {
          settled = true
          clearTimeout(timer)
          resolve(this.readyInfo ?? { url: '', authenticatedUrl: '', port: 0 })
        }
      }

      attachLineReader(child.stdout, (line) => onLine('stdout', line))
      attachLineReader(child.stderr, (line) => onLine('stderr', line))

      child.once('error', (error) => fail(error))
      child.once('exit', (code, signal) => {
        this.child = undefined
        this.emit('exit', { code, signal })
        if (!settled) {
          fail(
            new Error(
              `dsh-desktop: server exited before ready (code=${String(code)}, signal=${String(signal)})\n` +
                tail.join('\n'),
            ),
          )
        }
      })
    })
  }

  /**
   * Stop the child, escalating SIGTERM -> SIGKILL.
   * @param graceMs - how long to wait after SIGTERM before force-killing.
   */
  async stop(graceMs = 5_000): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true

    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, graceMs)
      child.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      child.kill('SIGTERM')
    })

    this.child = undefined
    this.stopping = false
  }

  /** Whether {@link stop} has been requested. */
  get isStopping(): boolean {
    return this.stopping
  }
}

/** Split a readable stream into lines, forwarding each to `onLine`. */
function attachLineReader(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (stream === null) return
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      onLine(buffer.slice(0, index).replace(/\r$/u, ''))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  })
  stream.on('end', () => {
    if (buffer !== '') onLine(buffer)
  })
}
