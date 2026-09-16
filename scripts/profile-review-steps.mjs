// 分解 review 快照各步骤的耗时，找出 4 秒卡在哪一步。
//
//   node scripts/profile-review-steps.mjs [仓库路径]
//
// 背景：常驻索引并没有把轮询降到预期（实测每次仍约 4.3 秒）。与其猜，不如逐步计时。
// 这个脚本只读，用独立临时 index，不改动仓库。
import { execFile } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.argv[2] ?? 'E:\\workspace\\mmsm-amis'
const scratch = join(process.env.TEMP ?? '/tmp', `dsh-prof-${process.pid}`)
rmSync(scratch, { recursive: true, force: true })

function git(args, env) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workspace, ...args],
      { timeout: 240000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(String(stderr).trim() || error.message))
        else resolve(String(stdout))
      },
    )
  })
}

/** 计时一次调用。 */
async function timed(label, fn) {
  const started = Date.now()
  const value = await fn()
  console.log(`  ${label.padEnd(34)} ${((Date.now() - started) / 1000).toFixed(2)}s`)
  return value
}

const indexPath = join(scratch, 'index')
const env = { GIT_INDEX_FILE: indexPath }
const { mkdirSync } = await import('node:fs')
mkdirSync(scratch, { recursive: true })

console.log(`仓库: ${workspace}`)

// 基线：从零构建一次
console.log('\n[基线构建]')
await timed('read-tree HEAD', () => git(['read-tree', 'HEAD'], env).catch(() => undefined))
await timed('add -A', () => git(['add', '-A'], env))
await timed('write-tree', () => git(['write-tree'], env))

// 轮询：索引已存在，测各步骤
console.log('\n[轮询（索引已热），第 1 轮]')
await timed('add -A', () => git(['add', '-A'], env))
await timed('write-tree', () => git(['write-tree'], env))

console.log('\n[轮询（索引已热），第 2 轮]')
await timed('add -A', () => git(['add', '-A'], env))
await timed('write-tree', () => git(['write-tree'], env))

// 对照：不带 add 的只读查询
console.log('\n[对照：只读查询]')
await timed('status --porcelain', () => git(['status', '--porcelain']))
await timed('diff-index --name-only HEAD', () => git(['diff-index', '--name-only', 'HEAD'], env))
await timed('diff --numstat 基线 当前', async () => {
  const current = (await git(['write-tree'], env)).trim()
  return git(['diff', '--numstat', 'HEAD', current])
})

rmSync(scratch, { recursive: true, force: true })
