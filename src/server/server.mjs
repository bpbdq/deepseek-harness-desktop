/**
 * dsh-desktop server entry point.
 *
 * Runs as a plain Node process (spawned by the Electron main process with
 * ELECTRON_RUN_AS_NODE=1). Responsibilities, in order:
 *
 *   1. own the Harness home (DSH_HOME) and workspace root
 *   2. materialize the reserved "desktop" profile (dsh-base + dsh-web-app)
 *   3. run the dsh boot chain using ONLY public @deepseek-ai/dsh-app-boot APIs
 *   4. announce the Web UI URL (with launch token) to the parent over stdout
 *
 * Deliberately does NOT go through the `dsh` CLI: `lib/bin.js` refuses the
 * "desktop" profile name by design, because this application is the owner of
 * that profile. `loadProfileDirectory()` is the public entry point meant for
 * exactly this ("application-owned profiles whose package project and lifecycle
 * belong to that application").
 *
 * Contract with the parent process (src/main/dsh-server.ts):
 *   - `dsh web: <url>?token=<token>` is printed by dsh-web-app itself
 *   - `[dsh-desktop] ready` is printed by us immediately afterwards
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  boot,
  healProfilesModuleFallback,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadProfileDirectory,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'

const BIN_NAME = 'dsh-desktop'
const PROFILE_NAME = 'desktop'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** The bundles the desktop profile composes. Same pair as the shipped `web` profile. */
const DESKTOP_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

const PROFILE_ROOT_CONFIG = `# dsh-desktop profile root — an empty entry list.
#
# The tree composes as patch layers: each bundle in package.json's
# dsh.profile.bundles, then cordis.patch.yml, then the home-level patch.
# Edit cordis.patch.yml, not this file.
[]
`

const PROFILE_PATCH_TEMPLATE = `# dsh-desktop patch layer, applied after every bundle layer.
#
# A top-level YAML array of loader patch entries (id-targeted config overrides,
# disables, and insert lists; \`!!js\` expressions allowed). This file is watched
# and hot-reloaded while the app runs.
[]
`

/**
 * Parse this server's own arguments.
 * @param argv - arguments after the script path.
 * @returns the resolved options.
 */
function parseArgs(argv) {
  const options = {
    dshHome: process.env.DSH_HOME,
    installAnchor: undefined,
    workspace: process.cwd(),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) break
    if (flag === '--dsh-home') options.dshHome = value
    else if (flag === '--install-anchor') options.installAnchor = value
    else if (flag === '--workspace') options.workspace = value
    else continue
    index += 1
  }
  if (options.dshHome === undefined || options.dshHome === '') {
    throw new Error(`${BIN_NAME}: --dsh-home (or DSH_HOME) is required`)
  }
  if (options.installAnchor === undefined) {
    throw new Error(`${BIN_NAME}: --install-anchor is required`)
  }
  return options
}

/**
 * Create the desktop profile on first run.
 *
 * The profile is application-owned: its package project and lifecycle belong to
 * this app, so it is never resolved through the shipped profile templates and
 * never collides with a `dsh --profile desktop` invocation (which the CLI refuses).
 * @param home - the Harness home.
 * @returns the absolute profile directory.
 */
function ensureProfile(home) {
  const dir = join(home, 'profiles', PROFILE_NAME)
  mkdirSync(dir, { recursive: true })

  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          name: 'dsh-profile-desktop',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: DESKTOP_BUNDLES, patchReload: 'live' } },
        },
        null,
        2,
      ) + '\n',
    )
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)

  // The Loader needs a real include root to anchor `baseUrl` at the profile
  // directory; it is always rewritten because tree write-back can bake composed
  // rows into it, which would duplicate every bundle insert on the next boot.
  writeFileSync(join(dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return dir
}

/** How long to wait for the web server to become addressable. */
const READY_POLL_TIMEOUT_MS = 30_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Print the desktop readiness signal once the web surface is actually addressable.
 *
 * dsh-web-app prints its `dsh web: <url>` line only after the loader settles and
 * both the `webServer` and `connection` services exist, so that line is the real
 * readiness boundary. Waiting for it here means the parent never navigates a
 * BrowserWindow at a port that is not listening yet.
 * @param ctx - the settled boot context.
 * @param port - the observed listen port.
 */
async function announceWhenAddressable(ctx, port) {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (ctx.get('connection') !== undefined && ctx.get('webServer')?.port === port) {
      console.log('[dsh-desktop] ready')
      return
    }
    await sleep(50)
  }
  console.error(`[dsh-desktop] warning: web surface did not become addressable within ${READY_POLL_TIMEOUT_MS}ms`)
  console.log('[dsh-desktop] ready')
}

/**
 * 启动阶段计时。
 *
 * 加它的原因：实测从进程启动到出现 URL 行要 11 秒以上，而内置 Node 冷启动只有
 * 88ms、加载 host 半边只有 131ms——时间全在服务端启动里，但"服务端启动"是个
 * 黑盒。把各阶段打出来，优化才有依据，而不是靠猜。
 *
 * 只在 DSH_DESKTOP_TIMING=1 时输出，避免污染正常日志。
 */
const TIMING = process.env.DSH_DESKTOP_TIMING === '1'
const t0 = Date.now()
let lastMark = t0
function mark(label) {
  if (!TIMING) return
  const now = Date.now()
  console.error(`[timing] ${String(now - lastMark).padStart(6)} ms  (+${String(now - t0).padStart(6)})  ${label}`)
  lastMark = now
}

/**
 * Boot the desktop profile and never resolve while the app is alive.
 * @returns a promise that settles only if boot fails.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const home = resolve(options.dshHome)
  const workspace = resolve(options.workspace)
  const installAnchor = resolve(options.installAnchor)
  mark('参数解析')

  mkdirSync(workspace, { recursive: true })
  process.chdir(workspace)

  const profileDir = ensureProfile(home)
  const profile = loadProfileDirectory(BIN_NAME, profileDir, installAnchor)
  mark(`profile 装载（${profile.layers.length} 个 bundle 层）`)

  // Link the installation's dependency closure into $DSH_HOME/profiles/node_modules
  // and reconcile the profile-local links. This is what makes the bundled runtime
  // self-sufficient; it also means a newly swapped runtime needs no reinstall.
  await healProfilesModuleFallback({ installAnchor, profile, home })
  mark('模块回退链接')

  const patches = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    ...(loadOptionalPatches(BIN_NAME, join(home, PROFILE_PATCH_FILENAME)) ?? []),
  ]
  mark(`patch 合成（${patches.length} 条）`)

  const environment = loadLayeredEnv(BIN_NAME)
  installFailLoud(BIN_NAME, process, () => {})
  mark('环境快照')

  const ctx = await boot(BIN_NAME, join(profile.dir, PROFILE_ROOT_FILENAME), patches, (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    provideCmdline(hostCtx, {
      // The desktop shell owns its own window and port: never open a browser,
      // and let the OS assign a free port so several instances cannot collide.
      args: ['--no-open', '--port', '0'],
      exit: (code) => process.exit(code),
      ready: { onReady: () => () => {} },
    })
  })
  mark('boot 插件树')

  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error(`${BIN_NAME}: web server did not start`)

  await announceWhenAddressable(ctx, port)
  mark('等待 web 可访问')

  // Keep the process alive; the mounted plugins own process lifetime.
  await new Promise(() => {})
}

main().catch((error) => {
  console.error(`[dsh-desktop] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
