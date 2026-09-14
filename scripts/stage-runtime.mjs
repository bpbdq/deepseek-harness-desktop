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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const RUNTIME = join(ROOT, 'runtime')
const PKG = '@deepseek-ai/dsh'

const requested = process.argv[2] ?? 'latest'
const registry = process.env.DSH_STAGE_REGISTRY ?? 'https://registry.npmmirror.com'

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
  { stdio: 'inherit' },
)

const require = createRequire(join(RUNTIME, 'package.json'))
const anchor = require.resolve(`${PKG}/package.json`)
const version = JSON.parse(readFileSync(anchor, 'utf8')).version

// Record what was staged: the app reads this to know the in-box baseline version.
writeFileSync(
  join(RUNTIME, 'runtime.json'),
  JSON.stringify({ package: PKG, version, stagedAt: new Date().toISOString(), registry }, null, 2) + '\n',
)

console.log(`[stage-runtime] staged ${PKG}@${version} in ${((Date.now() - start) / 1000).toFixed(1)}s`)
console.log(`[stage-runtime] anchor = ${anchor}`)
