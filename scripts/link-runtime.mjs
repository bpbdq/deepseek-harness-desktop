// Dev-only convenience: make `import '@deepseek-ai/dsh-app-boot'` resolvable from
// this repo by linking node_modules/@deepseek-ai/<pkg> to the staged runtime.
//
// Why this is needed:
//   * the staged runtime is a *nested* install (runtime/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*)
//   * Node's resolution walks `node_modules` upward, so the repo root cannot see it
//   * a single `@deepseek-ai/dsh` link is NOT enough -- npm may hoist siblings to
//     runtime/node_modules, and `dsh-app-boot` imports its own peers as external
//     packages, not by relative path.
//
// In the packaged app the spawn target lives inside resources/runtime, so this
// helper is a development aid only.
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SCOPE_DIR = join(ROOT, 'node_modules', '@deepseek-ai')

/**
 * Directories that can contain @deepseek-ai packages.
 * Order matters: later sources win, so the dsh-internal tree (which carries the
 * private packages the CLI bundles, e.g. dsh-app-boot) is linked last and overrides
 * anything npm hoisted to runtime/node_modules.
 */
function candidateSources(runtime) {
  return [
    join(runtime, 'node_modules', '@deepseek-ai'),
    join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
  ]
}

const runtime = join(ROOT, 'runtime')
if (!existsSync(runtime)) {
  console.log('[link-runtime] no runtime/ staged yet; skipping (run: npm run stage:runtime)')
  process.exit(0)
}

mkdirSync(SCOPE_DIR, { recursive: true })
let linked = 0
for (const source of candidateSources(runtime)) {
  if (!existsSync(source)) continue
  for (const name of readdirSync(source)) {
    const target = join(source, name)
    const link = join(SCOPE_DIR, name)
    let isDir = false
    try {
      isDir = statSync(target).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    rmSync(link, { recursive: true, force: true })
    try {
      symlinkSync(target, link, 'junction')
      linked++
    } catch (error) {
      console.warn(`[link-runtime] skipped ${name}: ${error.message}`)
    }
  }
}
console.log(`[link-runtime] linked ${linked} @deepseek-ai package(s) into node_modules/@deepseek-ai`)
