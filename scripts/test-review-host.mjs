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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = mkdtempSync(join(tmpdir(), 'dsh-review-'))
const runtime = join(process.cwd(), 'runtime')
// 独立的临时 HOME：与开发实例的 .dev-home 隔离。
// 早先共用 .dev-home，而测试会往 storages/workspace.json 写记录，于是跑完测试
// 开发实例就因"存储记录结构不符"起不来（这个坑重复了三次）。
const home = mkdtempSync(join(tmpdir(), 'dsh-test-home-'))
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

  // ---- 6. 还原（唯一的写操作，必须重点验证）--------------------------------
  console.log('')
  console.log('--- 还原 ---')

  // 6a. 越界路径必须被拒
  for (const bad of ['/etc/passwd', '../outside.txt', 'a/../../b.txt', '']) {
    res = await call('/dsh-desktop/review/revert', { workspace, sessionId: session, scope: 'workspace', paths: [bad] })
    check(`6a) 拒绝不安全路径 ${JSON.stringify(bad)}`, res.status, 400)
  }

  // 6b. 空路径列表必须被拒
  res = await call('/dsh-desktop/review/revert', { workspace, sessionId: session, scope: 'workspace', paths: [] })
  check('6b) 拒绝空路径列表', res.status, 400)

  // 6c. 还原一个已修改的文件到 HEAD，内容应恢复原样
  res = await call('/dsh-desktop/review/revert', {
    workspace,
    sessionId: session,
    scope: 'workspace',
    paths: ['modify.txt'],
  })
  check('6c) 还原修改文件 -> 200', res.status, 200)
  check('   文件内容已恢复', readFileSync(join(repo, 'modify.txt'), 'utf8').trim(), 'before')

  // 6d. 还原不应改动 HEAD 与索引（只动工作区）
  check('   索引未被暂存（status 仍显示已修改以外的状态）', run(['diff', '--cached', '--name-only'], repo).trim(), '')

  // 6e. 还原后该文件不再出现在"工作区改动"里
  res = await call('/dsh-desktop/review/workspace', { workspace, sessionId: session })
  json = await res.json()
  const afterRevert = new Map((json.files ?? []).map((f) => [f.path, f]))
  check('6e) 还原后的文件从列表消失', afterRevert.has('modify.txt'), 'false')
  check('   其它改动仍在列表里', afterRevert.has('added.txt'), 'true')

  // ---- 7. 提交历史 ---------------------------------------------------------
  console.log('')
  console.log('--- 提交历史 ---')
  res = await call('/dsh-desktop/review/history', { workspace, sessionId: session, limit: 5 })
  json = await res.json()
  check('7) 取历史成功', res.status, 200)
  check('   返回分支名', typeof json.branch === 'string' && json.branch !== '', 'true')
  check('   返回提交条数上限生效', (json.commits ?? []).length <= 5, 'true')
  const first = (json.commits ?? [])[0]
  check('   提交含短哈希', typeof first?.short === 'string' && first.short.length > 0, 'true')
  check('   提交含日期与作者', typeof first?.date === 'string' && typeof first?.author === 'string', 'true')
  check('   提交含标题', typeof first?.subject === 'string' && first.subject.length > 0, 'true')
  console.log(`       最新提交: ${first?.short} ${first?.date} ${first?.subject}`)

  // 未登记的工作区同样要被拒——历史与改动走同一条安全边界。
  const otherRepo = mkdtempSync(join(tmpdir(), 'dsh-review-hist-'))
  res = await call('/dsh-desktop/review/history', { workspace: otherRepo, sessionId: session })
  check('7b) 未登记工作区取历史 -> 400', res.status, 400)
  rmSync(otherRepo, { recursive: true, force: true })

  // ---- 8. 未跟踪的新文件必须出现在"工作区改动"里 ---------------------------
  //
  // 需求反馈："项目级 git 记录里 AI 新增的文件没显示"。未跟踪文件在 git status 里是
  // `??`，若 diff 只比 HEAD 与树、而树里没有它，就会漏掉——所以这条必须固化。
  console.log('')
  console.log('--- 未跟踪的新文件 ---')
  writeFileSync(join(repo, 'created-by-agent.txt'), 'agent made this\n')
  res = await call('/dsh-desktop/review/workspace', { workspace, sessionId: session })
  json = await res.json()
  const untracked = new Map((json.files ?? []).map((f) => [f.path, f]))
  check('8) 未跟踪的新文件出现在列表里', untracked.has('created-by-agent.txt'), 'true')
  check('   状态为新增（A）', (untracked.get('created-by-agent.txt')?.status ?? '').startsWith('A'), 'true')
  check('   差异里有它的内容', (json.diff ?? '').includes('agent made this'), 'true')

  // 还原也应能作用于未跟踪文件（把新建的文件撤回）。
  res = await call('/dsh-desktop/review/revert', {
    workspace,
    sessionId: session,
    scope: 'workspace',
    paths: ['created-by-agent.txt'],
  })
  check('   可还原未跟踪的新文件 -> 200', res.status, 200)
  check('   还原后该文件从列表消失', (await (await call('/dsh-desktop/review/workspace', { workspace, sessionId: session })).json()).files.some((f) => f.path === 'created-by-agent.txt'), 'false')

  // ---- 9. 宿主必须告诉客户端"当前是哪个工作区" ---------------------------
  //
  // 需求反馈："项目改动面板要自动识别当前项目空间，不要手动选，现在识别不准确"。
  // 根因：项目级面板挂在全局覆盖层上，拿不到 `useSessions`，于是退到候选列表第一项——
  // 恰好是另一个项目。现在由宿主返回 `process.cwd()`（进程启动时已 chdir 到工作区），
  // 因此这里断言它确实等于本测试的仓库。
  console.log('')
  console.log('--- 当前工作区 ---')
  res = await call('/dsh-desktop/review/roots', {})
  json = await res.json()
  check('9) /roots 返回候选列表', Array.isArray(json.roots) && json.roots.length > 0, 'true')
  check('   候选里含本测试仓库', (json.roots ?? []).some((r) => r.toLowerCase() === repo.toLowerCase()), 'true')
  check('   返回了 current', typeof json.current === 'string' && json.current !== '', 'true')
  check('   current 就是本测试仓库', (json.current ?? '').toLowerCase(), repo.toLowerCase())

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
