// 验证索引一致性问题：未跟踪文件被写进临时索引后，"删除它"在两次快照之间看不出差异。
//
//   node scripts/probe-index-consistency.mjs
//
// 用户反馈"AI 新增的文件点还原还原不了"。服务端在独立仓库里能删掉文件，但列表不更新——
// 怀疑根因是 `git add -A` 会把**未跟踪文件也写进临时索引**：这样"当前树"里始终有这个
// 文件（只是索引里挂着、不是树里的提交对象），于是"删除它"在两棵树之间不产生 diff。
// 本脚本用带索引的两次快照复现。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = mkdtempSync(join(tmpdir(), 'dsh-idx-'))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-scratch-'))
const run = (args, env) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

/** 用给定的 add 参数建一棵树。 */
function tree(env, addArgs) {
  run(['read-tree', 'HEAD'], env)
  run(addArgs, env)
  return run(['write-tree'], env).trim()
}

try {
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  run(['config', 'user.email', 't@example.com'])
  run(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'kept.txt'), 'kept\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'init'])

  const envA = { GIT_INDEX_FILE: join(scratch, 'a.index') }
  const envB = { GIT_INDEX_FILE: join(scratch, 'b.index') }

  writeFileSync(join(repo, 'agent-created.txt'), 'made by the agent\n')

  // 现在实现：两次都用 add -A（含未跟踪）。
  const beforeA = tree(envA, 'add -A'.split(' '))
  // 删除该文件（模拟"还原"）。
  rmSync(join(repo, 'agent-created.txt'), { force: true })
  const afterA = tree(envB, 'add -A'.split(' '))

  console.log('用 add -A（含未跟踪）建两次树：')
  console.log(`  删除前树 ${beforeA.slice(0, 8)}`)
  console.log(`  删除后树 ${afterA.slice(0, 8)}`)
  const diffA = run(['diff', '--name-status', beforeA, afterA]).trim()
  console.log(`  两棵树之间的差异: ${diffA === '' ? '(空 —— 看不出删除)' : diffA}`)

  // 修法：只用已跟踪文件的改动。
  writeFileSync(join(repo, 'agent-created.txt'), 'made by the agent\n')
  const envC = { GIT_INDEX_FILE: join(scratch, 'c.index') }
  const envD = { GIT_INDEX_FILE: join(scratch, 'd.index') }
  const beforeC = tree(envC, ['add', '-A', '--untracked-files=no'])
  rmSync(join(repo, 'agent-created.txt'), { force: true })
  const afterC = tree(envD, ['add', '-A', '--untracked-files=no'])
  console.log('')
  console.log('用 add -A --untracked-files=no（只含已跟踪）建两次树：')
  const diffC = run(['diff', '--name-status', beforeC, afterC]).trim()
  console.log(`  两棵树之间的差异: ${diffC === '' ? '(空 —— 仍看不出删除)' : diffC}`)

  console.log('')
  console.log('结论：')
  console.log(`  含未跟踪时能看出删除: ${diffA !== ''}`)
  console.log(`  排除未跟踪后能看出删除: ${diffC !== ''}`)
  console.log(`  文件当前存在: ${existsSync(join(repo, 'agent-created.txt'))}`)
} finally {
  rmSync(repo, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
}
