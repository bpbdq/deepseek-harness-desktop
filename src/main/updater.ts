/**
 * Runtime updater: keeps the bundled dsh runtime current from the npm registry.
 *
 * Two tracks, deliberately separated:
 *
 *   runtime track (this file)  — swaps @deepseek-ai/dsh to a new version without
 *                                reinstalling the app. Lands in userData/runtime,
 *                                which resolveRuntime() prefers over the in-box copy.
 *   shell track                — the Electron shell itself; handled by
 *                                electron-updater against GitHub Releases.
 *
 * Safety model: a failed boot always falls back. Versions land in immutable
 * per-version directories (`runtime/<version>/`) and `runtime/current` is a
 * junction that is created/deleted atomically, so activating, rolling back, or
 * recovering from a crash is a single link operation — never a partial copy.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE_NAME = '@deepseek-ai/dsh'
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'
const FALLBACK_REGISTRY = 'https://registry.npmjs.org'

/** One published version as the updater needs to see it. */
export interface VersionInfo {
  /** Version string, e.g. 0.1.5-rc.2 */
  version: string
  /** Registry the answer came from. */
  registry: string
}

/** Result of an update attempt. */
export interface UpdateResult {
  updated: boolean
  fromVersion: string
  toVersion: string
  /** Directory the new runtime was installed into, when updated. */
  directory?: string
  reason?: string
}

/** Outcome of probing the registry for a newer version. */
export interface UpdateCheck {
  current: string
  latest: VersionInfo
  newer: boolean
}

/**
 * Compare two semver-ish versions, tolerating prerelease tags.
 * @returns negative when a < b, 0 when equal, positive when a > b.
 */
export function compareVersions(a: string, b: string): number {
  const split = (value: string): { main: number[]; pre: string } => {
    const [core = '', pre = ''] = value.split('-', 2) as [string, string?]
    return { main: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre: pre ?? '' }
  }
  const left = split(a)
  const right = split(b)
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.main[index] ?? 0) - (right.main[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  // Compare dot-separated prerelease identifiers numerically when both are numbers.
  const leftParts = left.pre.split('.')
  const rightParts = right.pre.split('.')
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const l = leftParts[index]
    const r = rightParts[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const ln = Number.parseInt(l, 10)
    const rn = Number.parseInt(r, 10)
    const lNumeric = String(ln) === l
    const rNumeric = String(rn) === r
    if (lNumeric && rNumeric) return ln - rn
    if (lNumeric) return -1
    if (rNumeric) return 1
    return l < r ? -1 : 1
  }
  return 0
}

/**
 * Ask the registry for the newest published version.
 *
 * `latest` is the channel the CLI itself installs by default; `next`/`alpha`
 * are opt-in via {@link UpdateOptions.channel}.
 */
export class RuntimeUpdater {
  private readonly registry: string
  private readonly fallbackRegistry: string

  constructor(
    private readonly options: {
      /** Directory that holds versioned runtimes plus the `current` link. */
      baseDir: string
      /** Version shipped inside the installer, used as the rollback target. */
      bundledDir: string
      /** Currently running version, read from the runtime's package.json. */
      currentVersion: string
      /** dist-tag to follow; default `latest`. */
      channel?: string
      registry?: string
    },
  ) {
    this.registry = options.registry ?? DEFAULT_REGISTRY
    this.fallbackRegistry = FALLBACK_REGISTRY
  }

  /** The dist-tag this updater follows. */
  get channel(): string {
    return this.options.channel ?? 'latest'
  }

  /** Read the dsh version out of a runtime directory. */
  static readVersion(runtimeDir: string): string | undefined {
    try {
      const manifest = JSON.parse(
        readFileSync(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
      ) as { version?: string }
      return manifest.version
    } catch {
      return undefined
    }
  }

  /**
   * Fetch the newest version for the configured channel.
   * @returns the published version and the registry that answered.
   */
  async check(): Promise<UpdateCheck> {
    const channel = this.options.channel ?? 'latest'
    const attempts = [this.registry, this.fallbackRegistry]
    let lastError: unknown
    for (const registry of attempts) {
      try {
        const url = `${registry}/${PACKAGE_NAME.replace('/', '%2F')}`
        const response = await fetch(url, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = (await response.json()) as { 'dist-tags'?: Record<string, string> }
        const version = body['dist-tags']?.[channel]
        if (version === undefined) throw new Error(`no dist-tag ${JSON.stringify(channel)}`)
        return {
          current: this.options.currentVersion,
          latest: { version, registry },
          newer: compareVersions(version, this.options.currentVersion) > 0,
        }
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`dsh-desktop: could not reach a registry: ${String(lastError)}`)
  }

  /**
   * Install a version into `baseDir/<version>` and activate it.
   *
   * Uses npm's own recursive resolver (spawned from Electron's bundled npm when
   * available). Reimplementing semver resolution and peer hoisting is not worth
   * the risk: a wrong tree produces an app that boots but misbehaves.
   *
   * @param version - the version to install.
   * @param registry - registry to install from.
   * @param npmCli - absolute path of npm's CLI entry (`npm-cli.js`).
   * @param onProgress - receives human-readable progress lines.
   * @returns the install result.
   */
  async install(
    version: string,
    registry: string,
    npmCli: string,
    onProgress: (line: string) => void = () => {},
  ): Promise<UpdateResult> {
    const { baseDir, currentVersion } = this.options
    const target = join(baseDir, version)

    if (existsSync(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
      onProgress(`runtime ${version} already downloaded; activating`)
    } else {
      // Install into a temp sibling, then rename: an interrupted download never
      // leaves a half-written directory that looks usable.
      const staging = join(baseDir, `.staging-${version}-${Date.now()}`)
      mkdirSync(staging, { recursive: true })
      writeFileSync(
        join(staging, 'package.json'),
        JSON.stringify({ name: 'dsh-desktop-runtime', private: true, version: '0.0.0' }, null, 2) + '\n',
      )
      onProgress(`installing ${PACKAGE_NAME}@${version} from ${registry}`)
      try {
        await runNpm(
          npmCli,
          ['install', `${PACKAGE_NAME}@${version}`, '--prefix', staging, '--registry', registry, '--no-audit', '--no-fund', '--loglevel', 'error'],
          onProgress,
        )
        if (!existsSync(join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
          throw new Error('install produced no @deepseek-ai/dsh package')
        }
        // Carry the pinned Node into every version directory. Without this, an
        // activated update would fall back to Electron's own Node, which is older
        // than the harness requires, and the app would fail to boot.
        this.copyToolchain(staging)
        writeFileSync(
          join(staging, 'runtime.json'),
          JSON.stringify({ package: PACKAGE_NAME, version, installedAt: new Date().toISOString(), registry }, null, 2) + '\n',
        )
        rmSync(target, { recursive: true, force: true })
        renameSync(staging, target)
      } catch (error) {
        rmSync(staging, { recursive: true, force: true })
        return {
          updated: false,
          fromVersion: currentVersion,
          toVersion: version,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }

    this.activate(version)
    onProgress(`runtime ${version} activated; restart to apply`)
    return { updated: true, fromVersion: currentVersion, toVersion: version, directory: target }
  }

  /**
   * Copy the pinned toolchain (currently the Node runtime) into a version
   * directory so an activated update is self-sufficient.
   * @param target - the version directory being staged.
   */
  private copyToolchain(target: string): void {
    for (const entry of ['node']) {
      const source = join(this.options.bundledDir, entry)
      if (!existsSync(source)) continue
      cpSync(source, join(target, entry), { recursive: true, dereference: false })
    }
  }

  /**
   * Point `baseDir/current` at a version directory.
   *
   * The boot path follows `current`, so switching versions is one link swap and
   * rolling back is one unlink.
   */
  activate(version: string): void {
    const link = join(this.options.baseDir, 'current')
    rmSync(link, { recursive: true, force: true })
    symlinkSync(join(this.options.baseDir, version), link, 'junction')
  }

  /** Remove the `current` link so the app falls back to the bundled runtime. */
  rollback(): void {
    rmSync(join(this.options.baseDir, 'current'), { recursive: true, force: true })
  }

  /**
   * Make the bundled runtime available as a rollback target by copying it once.
   * @returns the directory that can now be activated to roll back.
   */
  seedBundled(): string {
    const version = this.options.currentVersion
    const target = join(this.options.baseDir, version)
    if (!existsSync(target) && existsSync(this.options.bundledDir)) {
      mkdirSync(this.options.baseDir, { recursive: true })
      cpSync(this.options.bundledDir, target, { recursive: true, dereference: false })
    }
    return target
  }
}

/** Run npm, forwarding output lines to `onProgress`. */
function runNpm(npmCli: string, args: string[], onProgress: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/u)) {
        if (line.trim() !== '') onProgress(line)
      }
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm exited with code ${String(code)}`))
    })
  })
}

/**
 * Locate an npm CLI entry to drive installs with.
 *
 * Preference order: the npm Electron ships inside its own asar (so an end user
 * with no Node toolchain still gets runtime updates), then a system npm.
 * @param resourcesPath - Electron's `process.resourcesPath`.
 * @returns the absolute path of `npm-cli.js`, or undefined when unavailable.
 */
export function locateNpmCli(resourcesPath: string): string | undefined {
  const candidates = [
    join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(resourcesPath, 'app', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(resourcesPath, 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
