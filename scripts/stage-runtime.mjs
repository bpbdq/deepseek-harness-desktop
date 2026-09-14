// Build-machine helper: stage a self-contained @deepseek-ai/dsh installation into ./runtime.
//
// This is what gets shipped inside the installer (electron-builder copies ./runtime
// to resources/runtime), so an end user never needs node or npm.
//
// The staged tree doubles as the "install anchor" the dsh boot chain resolves its
// bundle packages from (resolveBundleDir probes the anchor's node_modules).
//
// Usage:
//   node scripts/stage-runtime.mjs                     # installs @deepseek-ai/dsh@latest
//   node scripts/stage-runtime.mjs 0.1.5-rc.2          # pin an exact version
//   node scripts/stage-runtime.mjs next                # follow a dist-tag (latest|next|alpha)
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const RUNTIME = join(ROOT, 'runtime')
const PKG = '@deepseek-ai/dsh'

const requested = process.argv[2] ?? 'latest'
const registry = process.env.DSH_STAGE_REGISTRY ?? 'https://registry.npmmirror.com'

/**
 * npm 自己的网络超时（毫秒）。
 *
 * 没有它，一个卡住的 registry 连接会耗尽整个 CI 步骤的预算，最后只留下一个
 * 莫名其妙的失败。设成有界值，让失败快而明确。
 */
const FETCH_TIMEOUT_MS = process.env.DSH_FETCH_TIMEOUT_MS ?? '300000'

const npmExecPath = process.env.npm_execpath
if (npmExecPath === undefined || !existsSync(npmExecPath)) {
  throw new Error('stage-runtime: run this through npm (npm run stage:runtime) so npm_execpath is available')
}

// A staged runtime is a real package so its node_modules is a valid resolution
// anchor for `packageDirFromAnchor` in dsh-app-boot.
mkdirSync(RUNTIME, { recursive: true })
writeFileSync(
  join(RUNTIME, 'package.json'),
  JSON.stringify({ name: 'dsh-desktop-runtime', private: true, version: '0.0.0' }, null, 2) + '\n',
)

const start = Date.now()
console.log(`[stage-runtime] installing ${PKG}@${requested} into runtime/ via ${registry}`)
execFileSync(
  process.execPath,
  [
    npmExecPath,
    'install',
    `${PKG}@${requested}`,
    '--prefix',
    RUNTIME,
    '--registry',
    registry,
    '--no-audit',
    '--no-fund',
    '--loglevel',
    'error',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_fetch_timeout: FETCH_TIMEOUT_MS,
      npm_config_fetch_retries: '3',
      npm_config_fetch_retry_maxtimeout: '60000',
    },
  },
)

const require = createRequire(join(RUNTIME, 'package.json'))
const anchor = require.resolve(`${PKG}/package.json`)
const version = JSON.parse(readFileSync(anchor, 'utf8')).version

/**
 * 把随包内置的客户端插件装进 runtime/node_modules。
 *
 * 为什么必须在这里做：插件的客户端半边要被 dsh 的模块系统发现，前提是 host 侧能
 * 从安装位置 resolve 到它的 `package.json`。而 `server.mjs` 会在启动时把它链进
 * profile 的 node_modules，因此先要让它存在于 runtime 的依赖树旁。
 *
 * 放在 npm install 之后是因为 npm 可能重建 node_modules 目录；放这里能保证插件不
 * 会被后续安装动作清掉。
 */
const bundledPluginsDir = join(ROOT, 'plugins')
const plugins = existsSync(bundledPluginsDir) ? readdirSync(bundledPluginsDir) : []
for (const plugin of plugins) {
  const source = join(bundledPluginsDir, plugin)
  if (!existsSync(join(source, 'package.json'))) continue
  const destination = join(RUNTIME, 'node_modules', plugin)
  rmSync(destination, { recursive: true, force: true })
  cpSync(source, destination, { recursive: true })
  console.log(`[stage-runtime] 内置插件 ${plugin} -> runtime/node_modules/`)
}

// Record what was staged: the app reads this to know the in-box baseline version.
writeFileSync(
  join(RUNTIME, 'runtime.json'),
  JSON.stringify(
    { package: PKG, version, stagedAt: new Date().toISOString(), registry, plugins },
    null,
    2,
  ) + '\n',
)

console.log(`[stage-runtime] staged ${PKG}@${version} in ${((Date.now() - start) / 1000).toFixed(1)}s`)
console.log(`[stage-runtime] anchor = ${anchor}`)
