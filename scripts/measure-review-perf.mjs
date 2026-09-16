// 在**真实的大仓库**上实测审查路由：不仅验证正确性，也验证延迟。
//
//   node scripts/measure-review-perf.mjs [仓库路径]
//
// 背景：最初的实现每次轮询都对整个工作区做 `git add -A`，而用户仓库里有一个
// 37.7 MB / 6635 个文件的未跟踪目录，实测单次 92 秒——远超超时，且客户端每 4 秒轮询，
// 会彻底堵死。改成"只哈希变化路径"后需要实测确认延迟回到可用范围。
//
// 这个脚本只读：它用独立的临时 index，不改动仓库状态。
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.argv[2] ?? 'E:\\workspace\\mmsm-amis'

/** 与 host 实现一致的临时 index 方案。 */
function indexFor(label) {
  return join(process.env.TEMP ?? '/tmp', `dsh-perf-${label}-${process.pid}.index`)
}

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

console.log(`仓库: ${workspace}`)
console.log('')

// 整树遍历（旧实现）
let started = Date.now()
const fullIndex = { GIT_INDEX_FILE: indexFor('full') }
await git(['read-tree', 'HEAD'], fullIndex).catch(() => undefined)
await git(['add', '-A'], fullIndex)
const fullTree = (await git(['write-tree'], fullIndex)).trim()
const fullMs = Date.now() - started
console.log(`整树遍历（旧实现，仅基线用一次）: ${(fullMs / 1000).toFixed(1)}s  tree=${fullTree.slice(0, 8)}`)

// 收窄路径（新实现）
started = Date.now()
const partialIndex = { GIT_INDEX_FILE: indexFor('partial') }
await git(['read-tree', 'HEAD'], partialIndex).catch(() => undefined)
const nameStatus = await git(['diff-index', '--name-only', '--no-renames', 'HEAD'], fullIndex)
const tracked = nameStatus.split('\n').map((l) => l.trim()).filter((l) => l !== '')
const statusOut = await git(['status', '--porcelain', '--untracked-files=all'])
const untracked = statusOut
  .split('\n')
  .filter((l) => l.startsWith('??'))
  .map((l) => l.slice(3).trim())
const paths = [...new Set([...tracked, ...untracked])]
const { writeFileSync, rmSync } = await import('node:fs')
const listPath = `${indexFor('partial')}.paths`
writeFileSync(listPath, paths.join('\0'), 'utf8')
try {
  await git(['add', '-A', '--pathspec-from-file', listPath], partialIndex)
} finally {
  rmSync(listPath, { force: true })
}
const partialTree = (await git(['write-tree'], partialIndex)).trim()
const partialMs = Date.now() - started

console.log(`收窄路径（新实现，每次轮询）: ${(partialMs / 1000).toFixed(2)}s`)
console.log(`  纳入路径 ${paths.length} 条（已跟踪改动 ${tracked.length}、未跟踪 ${untracked.length}）`)
console.log('')
console.log(`结论：轮询从 ${(fullMs / 1000).toFixed(1)}s 降到 ${(partialMs / 1000).toFixed(2)}s（约 ${Math.round(fullMs / Math.max(partialMs, 1))} 倍）`)

// 两棵树应能比对出差异
const names = await git(['diff', '--name-status', fullTree, partialTree])
const lines = names.split('\n').filter((l) => l.trim() !== '')
console.log(`两棵树之间的差异条目: ${lines.length}`)
for (const line of lines.slice(0, 8)) console.log(`  ${line}`)

rmSync(indexFor('full'), { force: true })
rmSync(indexFor('partial'), { force: true })
