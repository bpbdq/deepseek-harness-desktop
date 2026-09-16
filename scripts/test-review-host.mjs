// 端到端验证 review 插件的宿主路由：基线快照与整轮差异。
//
//   node scripts/test-review-host.mjs
//
// 用一次性临时仓库：测试会真的执行 git 的 read-tree/add/write-tree，绝不能拿真实仓库当
// 试验场（虽然机制是只读的，但"只读"本身也需要被验证，而不是假定）。
//
// 覆盖：
//   1. 未记基线时取差异 -> noBaseline
//   2. 记基线 -> 返回树对象 SHA
//   3. 改动工作区（修改 + 新增 + 删除）后取差异 -> 三类变更都被列出，且带行数
//   4. 未登记的工作区 -> 400
//   5. 整个过程不污染用户状态：status 与 stash 列表不变
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = mkdtempSync(join(tmpdir(), 'dsh-review-'))
const runtime = join(process.cwd(), 'runtime')
const home = join(process.cwd(), '.dev-home', 'home')
rmSync(home, { recursive: true, force: true })

const run = (args, cwd) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

let child

try {
  // ---- 造仓库 --------------------------------------------------------------
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  run(['config', 'user.email', 'test@example.com'], repo)
  run(['config', 'user.name', 'test'], repo)
  writeFileSync(join(repo, 'keep.txt'), 'keep\n')
  writeFileSync(join(repo, 'modify.txt'), 'before\n')
  writeFileSync(join(repo, 'remove.txt'), 'bye\n')
  run(['add', '.'], repo)
  run(['commit', '-q', '-m', 'init'], repo)

  console.log('临时仓库:', repo)
  console.log('')

  // ---- 起服务端 ------------------------------------------------------------
  child = spawn(
    join(runtime, 'node', 'node.exe'),
    [
      join(runtime, 'server.mjs'),
      '--dsh-home',
      home,
      '--install-anchor',
      join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      '--workspace',
      repo,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let out = ''
  child.stdout.on('data', (d) => {
    out += d
  })
  child.stderr.on('data', (d) => {
    out += d
  })

  let base
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500))
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(out)
    if (m !== null) {
      base = m[1]
      break
    }
  }
  if (base === undefined) {
    // 把服务端输出打出来：起不来的原因几乎总在里面，而不是在测试代码里。
    console.error('服务端未就绪，其输出尾部：')
    console.error(out.split('\n').filter((l) => l.trim() !== '').slice(-15).join('\n'))
    throw new Error('服务端未就绪')
  }

  // 服务端就绪后登记这个临时仓库
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
        tables: { workspaces: { w1: { path: repo } } },
      },
      null,
      2,
    ) + '\n',
  )

  const call = (route, body) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const session = 'test-session'
  const workspace = repo

  // ---- 1. 无基线 -----------------------------------------------------------
  let res = await call('/dsh-desktop/review/changes', { workspace, sessionId: session })
  let json = await res.json()
  check('1) 无基线时返回 noBaseline', json.noBaseline, 'true')

  // ---- 2. 记基线 -----------------------------------------------------------
  const statusBefore = run(['status', '--porcelain'], repo)
  const stashBefore = run(['stash', 'list'], repo)

  res = await call('/dsh-desktop/review/baseline', { workspace, sessionId: session })
  json = await res.json()
  check('2) 记基线成功', res.status, 200)
  check('   返回树对象 SHA（40 位十六进制）', /^[0-9a-f]{40}$/u.test(json.revision ?? ''), 'true')

  // ---- 3. 改动工作区后取差异 -----------------------------------------------
  writeFileSync(join(repo, 'modify.txt'), 'before\nafter-1\nafter-2\n')
  writeFileSync(join(repo, 'added.txt'), 'new file\n')
  rmSync(join(repo, 'remove.txt'))

  res = await call('/dsh-desktop/review/changes', { workspace, sessionId: session })
  json = await res.json()
  check('3) 取差异成功', res.status, 200)

  const byPath = new Map((json.files ?? []).map((f) => [f.path, f]))
  check('   列出被修改的文件', byPath.has('modify.txt'), 'true')
  check('   列出新增的文件', byPath.has('added.txt'), 'true')
  check('   列出删除的文件', byPath.has('remove.txt'), 'true')
  check('   未改动的文件不在列表里', byPath.has('keep.txt'), 'false')
  check('   修改文件带新增行数', byPath.get('modify.txt')?.added, 2)
  check('   差异文本非空', (json.diff ?? '').length > 0, 'true')
  check('   差异里含新增行标记', (json.diff ?? '').includes('+after-1'), 'true')

  // ---- 5. 未污染用户状态 ---------------------------------------------------
  const statusAfter = run(['status', '--porcelain'], repo)
  const stashAfter = run(['stash', 'list'], repo)
  check('5) status 未被污染（除本次改动外无新增条目）', statusAfter.split('\n').filter((l) => l.trim() !== '').length, 3)
  check('   stash 列表仍为空', stashAfter.trim(), stashBefore.trim())

  // ---- 4. 未登记的工作区 ---------------------------------------------------
  const other = mkdtempSync(join(tmpdir(), 'dsh-review-other-'))
  res = await call('/dsh-desktop/review/changes', { workspace: other, sessionId: session })
  check('4) 未登记工作区 -> 400', res.status, 400)
  rmSync(other, { recursive: true, force: true })
} catch (error) {
  failures += 1
  console.error('测试异常:', String(error.message).slice(0, 400))
} finally {
  child?.kill()
  await new Promise((r) => setTimeout(r, 1200))
  try {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    // 子进程仍占用时删不掉，不影响结论。
  }
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
