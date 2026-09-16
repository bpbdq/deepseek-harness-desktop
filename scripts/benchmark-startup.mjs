// Build first. Run with a staged runtime archive and an explicit pre-change ref:
// node scripts/benchmark-startup.mjs --archive=.probe-home/startup-benchmark/runtime.br --baseline=<git-ref>
// A diagnostic archive can be built with compress-runtime.mjs --quality=4 --output=...
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { ensureRuntimeUnpacked } from '../dist/main/runtime-unpack.js'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = resolve(import.meta.dirname, '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const baselineRef = option('baseline') ?? 'HEAD'
const archive = resolve(option('archive') ?? join(root, 'build/runtime.br'))
const rounds = Number(option('rounds') ?? 2)
assertInputs()
mkdirSync(join(root, '.probe-home'), { recursive: true })
const scratch = mkdtempSync(join(root, '.probe-home', 'startup-benchmark-'))
const baseline = path => execFileSync('git', ['show', `${baselineRef}:${path}`], { cwd: root, encoding: 'utf8', windowsHide: true })
const baselineModule = join(scratch, 'baseline-unpack.cjs')
writeFileSync(baselineModule, ts.transpileModule(baseline('src/main/runtime-unpack.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)
const variants = [
  { name: 'before', unpack: require(baselineModule).ensureRuntimeUnpacked, entry: baseline('src/server/server.mjs') },
  { name: 'after', unpack: ensureRuntimeUnpacked, entry: readFileSync(join(root, 'src/server/server.mjs'), 'utf8') },
]
const results = []
const originalStat = statSync(archive)
console.log(JSON.stringify({ baseline: baselineRef, archive, rounds, scope: 'unpack + server readiness; excludes Electron/renderer', manifest: JSON.parse(readFileSync(join(resolve(archive, '..'), 'runtime.json'), 'utf8')) }))

function assertInputs() {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('rounds must be 1..10')
  statSync(archive)
}
async function boot(runtime, home, variant) {
  const started = performance.now()
  const workspace = join(home, 'workspace'); mkdirSync(workspace, { recursive: true })
  const entry = join(runtime, 'server.mjs')
  writeFileSync(entry, variant.entry)
  writeFileSync(join(runtime, 'client-module-cache.mjs'), readFileSync(join(root, 'src/server/client-module-cache.mjs')))
  const env = { ...process.env, DSH_HOME: join(home, 'home'), DSH_DESKTOP: '1', DSH_DESKTOP_TIMING: '1' }
  delete env.NODE_COMPILE_CACHE; delete env.DSH_DESKTOP_DISABLE_STARTUP_CACHE; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node'), [
    entry, '--dsh-home', env.DSH_HOME, '--install-anchor', join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), '--workspace', workspace,
  ], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  try {
    return await new Promise((resolveBoot, rejectBoot) => {
      const timeout = setTimeout(() => rejectBoot(new Error(`server timed out: ${stderr.slice(-2000)}`)), 60000)
      child.once('error', error => { clearTimeout(timeout); rejectBoot(error) })
      child.once('exit', code => { clearTimeout(timeout); rejectBoot(new Error(`server exited ${code}: ${stderr.slice(-2000)}`)) })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.stdout.on('data', chunk => {
        stdout += chunk
        if (stdout.includes('[dsh-desktop] ready')) {
          clearTimeout(timeout)
          resolveBoot({ serverMs: Math.round(performance.now() - started), cacheEnabled: stderr.includes('[startup-cache] enabled'), timing: stderr.split(/\r?\n/u).filter(line => line.includes('[timing]')) })
        }
      })
    })
  } finally {
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 3000)
    await exited; clearTimeout(force)
  }
}
try {
  for (let round = 1; round <= rounds; round++) {
    const order = round % 2 === 1 ? variants : [...variants].reverse()
    for (const phase of ['fresh', 'warm', 'timestamp-change']) {
      if (phase === 'timestamp-change') utimesSync(archive, originalStat.atime, new Date(Date.now() + round * 20000))
      for (const variant of order) {
        const home = join(scratch, `${variant.name}-${round}`)
        const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable()
        const start = performance.now()
        const extracted = await variant.unpack(archive, home)
        const unpackMs = Math.round(performance.now() - start)
        delay.disable()
        const booted = await boot(join(extracted.dir, 'runtime'), home, variant)
        const result = { round, phase, variant: variant.name, unpackMs, ...booted, totalMs: unpackMs + booted.serverMs, unpacked: extracted.unpacked, maxMainLoopDelayMs: Math.round(delay.max / 1e6) }
        results.push(result); console.log(JSON.stringify(result))
      }
    }
  }
  for (const phase of ['fresh', 'warm', 'timestamp-change']) {
    const median = values => { const sorted = values.sort((a, b) => a - b); return sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 }
    const before = median(results.filter(r => r.phase === phase && r.variant === 'before').map(r => r.totalMs))
    const after = median(results.filter(r => r.phase === phase && r.variant === 'after').map(r => r.totalMs))
    console.log(JSON.stringify({ summary: phase, beforeMs: before, afterMs: after, reductionPercent: Math.round((1 - after / before) * 100) }))
  }
} finally {
  utimesSync(archive, originalStat.atime, originalStat.mtime)
  if (!resolve(scratch).startsWith(join(root, '.probe-home') + sep)) throw new Error('Unsafe cleanup path')
  rmSync(scratch, { recursive: true, force: true })
}
