// 实验：未跟踪的新文件是否会出现在"工作区改动"里。
//
//   node scripts/probe-untracked-in-diff.mjs
//
// 背景：AI 新建的文件在 git status 里是 `??`（未跟踪）。`git diff HEAD <tree>` 只比较
// HEAD 与树的差异，**未跟踪文件不在其中**——这就是"新增文件没显示"的候选根因。本脚本用
// 一次性临时仓库复现，并验证修法（先对未跟踪路径做 `git add -N`，再建树）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = mkdtempSync(join(tmpdir(), 'dsh-untracked-'))
const run = (args, env) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

try {
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.email', 't@example.com'])
  run(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'kept.txt'), 'kept\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'init'])

  // 模拟 AI 的动作：新建一个文件、改一个已跟踪文件。
  writeFileSync(join(repo, 'new-by-ai.txt'), 'created by the agent\n')
  writeFileSync(join(repo, 'kept.txt'), 'kept\nmodified\n')

  // 当前实现：直接 read-tree + add -A + write-tree，再 diff HEAD。
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-idx-'))
  const env = { GIT_INDEX_FILE: join(scratch, 'index') }
  run(['read-tree', 'HEAD'], env)
  run(['add', '-A'], env)
  const tree = run(['write-tree'], env).trim()
  const names = run(['diff', '--name-status', 'HEAD', tree])
  console.log('直接 add -A 建树后 diff HEAD：')
  for (const line of names.split('\n').filter((l) => l !== '')) console.log(`  ${line}`)

  // 关键问题：未跟踪文件在不在？
  const hasUntracked = names.includes('new-by-ai.txt')
  console.log(`\n含未跟踪的新文件: ${hasUntracked}`)
  console.log(`git status 视角: ${run(['status', '--porcelain']).split('\n').filter((l) => l !== '').join(' | ')}`)

  // 修法：对未跟踪路径做 add -N（intent-to-add），使其进入 diff 但不把内容写进索引。
  const env2 = { GIT_INDEX_FILE: join(scratch, 'index2') }
  run(['read-tree', 'HEAD'], env2)
  const untracked = run(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (untracked.length > 0) run(['add', '-N', '--', ...untracked], env2)
  run(['add', '-A'], env2)
  const tree2 = run(['write-tree'], env2).trim()
  const names2 = run(['diff', '--name-status', 'HEAD', tree2])
  console.log(`\n先 add -N 再建树（未跟踪 ${untracked.length} 个）：`)
  for (const line of names2.split('\n').filter((l) => l !== '')) console.log(`  ${line}`)
  console.log(`\n含未跟踪的新文件: ${names2.includes('new-by-ai.txt')}`)

  // 顺带确认 add -N 没有污染用户的索引。
  console.log(`\n用户索引仍为空（未被暂存）: ${run(['diff', '--cached', '--name-only']).trim() === ''}`)

  rmSync(scratch, { recursive: true, force: true })
} finally {
  rmSync(repo, { recursive: true, force: true })
}
