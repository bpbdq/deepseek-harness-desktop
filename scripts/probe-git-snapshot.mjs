// 验证"用 git 自身对象库给工作区拍快照"的机制是否可行。
//
//   node scripts/probe-git-snapshot.mjs <仓库路径>
//
// 目的：确认能只读地拿到工作区当前状态的树对象 SHA，并据此产生差异。做法是给 git 指定
// 一个**临时 index 文件**，这样既能把未跟踪文件纳入快照，又完全不碰用户真实的 index、
// stash 列表与 HEAD。
//
// 需要它是因为"每轮修改审查"要有基线：本轮开始时的状态。而基线必须是廉价的、只读的、
// 且能覆盖未跟踪文件——用户往往在改到一半时才开始一轮任务。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = process.argv[2] ?? 'F:\\code\\dshDesktop'

/** 用临时 index 拍一张工作区快照，返回树对象 SHA。 */
function snapshot(repoPath) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-snap-'))
  const indexPath = join(scratch, 'index')
  const env = { ...process.env, GIT_INDEX_FILE: indexPath }
  try {
    // 从 HEAD 初始化临时 index（没有 HEAD 时为空仓，交给 git 自行处理）。
    try {
      execFileSync('git', ['-C', repoPath, 'read-tree', 'HEAD'], { env, stdio: 'ignore' })
    } catch {
      // 空仓库：没有 HEAD 可读，从空 index 开始。
    }
    // -A 让已跟踪改动、新增、删除都进 index；未跟踪文件按 .gitignore 规则纳入。
    execFileSync('git', ['-C', repoPath, 'add', '-A'], { env, stdio: 'ignore' })
    return execFileSync('git', ['-C', repoPath, 'write-tree'], { env, encoding: 'utf8' }).trim()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log(`仓库: ${repo}`)
console.log('')

// 1) 快照应稳定：同一状态拍两次得到同一个 SHA
const first = snapshot(repo)
const second = snapshot(repo)
console.log(`快照 SHA: ${first}`)
console.log(`  两次一致（稳定）: ${first === second}`)

// 2) 确认没有污染用户状态
const statusAfter = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
const stashAfter = execFileSync('git', ['-C', repo, 'stash', 'list'], { encoding: 'utf8' })
console.log(`  status 未被污染: ${statusAfter.split('\n').filter((l) => l.trim() !== '').length} 条改动（与快照前应一致）`)
console.log(`  stash 列表未被污染: ${stashAfter.trim() === '' ? '空' : stashAfter.trim().split('\n').length + ' 条'}`)

// 3) 造一处改动后，快照应变化，且能拿到差异
const target = join(repo, '.snapshot-probe.tmp')
try {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(target, 'probe\n')
  const third = snapshot(repo)
  console.log('')
  console.log(`新增一个未跟踪文件后: ${third}`)
  console.log(`  快照发生了变化: ${third !== first}`)

  // 4) 由两次快照得到差异（这就是审查面板要展示的内容）
  const diff = execFileSync('git', ['-C', repo, 'diff', '--stat', first, third], { encoding: 'utf8' })
  console.log('  两次快照之间的差异:')
  for (const line of diff.trim().split('\n').slice(0, 6)) console.log(`    ${line}`)

  const names = execFileSync('git', ['-C', repo, 'diff', '--name-status', first, third], { encoding: 'utf8' })
  console.log('  变更文件:')
  for (const line of names.trim().split('\n').slice(0, 6)) console.log(`    ${line}`)
} finally {
  rmSync(target, { force: true })
  // 该文件已从磁盘删除；快照机制不写 index，所以无需清理 git 状态。
}
