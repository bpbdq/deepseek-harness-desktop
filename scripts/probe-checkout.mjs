// 复现 gitbar host 侧的校验与切换逻辑，用于定位"切不过去"。
//
//   node scripts/probe-checkout.mjs <工作区> [分支名]
//
// 不猜：把 index.js 里同一套正则与 git 调用原样跑一遍，看它到底卡在哪一步。
// 只做**只读**检查；末尾的切换请求默认不执行（加 --apply 才真的切）。
import { execFile } from 'node:child_process'

const workspace = process.argv[2] ?? 'E:\\workspace\\mmsm-amis'
const requested = process.argv[3]
const apply = process.argv.includes('--apply')

/** 与 plugins/dsh-client-ui-gitbar/lib/index.js 完全一致的约束。 */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/u
const GIT_TIMEOUT_MS = 8000

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${String(stderr).trim() || error.message} (code=${error.code})`))
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

console.log('工作区:', workspace)
console.log('')

// 1) 分支列表
const format = '%(refname)\t%(HEAD)'
const [localRaw, remoteRaw] = await Promise.all([
  git(['for-each-ref', '--format=' + format, 'refs/heads/'], workspace),
  git(['for-each-ref', '--format=' + format, 'refs/remotes/'], workspace),
])

const parse = (raw, prefix, isRemote) =>
  raw
    .split('\n')
    .map((line) => line.split('\t'))
    .map(([refname, head]) => ({ name: (refname ?? '').slice(prefix.length).trim(), head: (head ?? '').trim() }))
    .filter((entry) => entry.name !== '' && !entry.name.endsWith('/HEAD'))
    .map((entry) => ({ name: entry.name, isRemote, current: entry.head === '*' }))

const branches = [...parse(localRaw, 'refs/heads/', false), ...parse(remoteRaw, 'refs/remotes/', true)]
console.log(`分支 ${branches.length} 个`)

// 2) 逐个跑校验，找出被拒绝的名字
const rejected = branches.filter((b) => !BRANCH_PATTERN.test(b.name))
console.log(`被正则拒绝的: ${rejected.length === 0 ? '无' : rejected.map((b) => `${b.name}(长度${b.name.length})`).join(', ')}`)
console.log('')

if (requested !== undefined) {
  const target = branches.find((b) => b.name === requested)
  console.log(`目标分支 "${requested}": ${target === undefined ? '不在列表里' : `存在（${target.isRemote ? '远程' : '本地'}）`}`)
  console.log(`  正则通过: ${BRANCH_PATTERN.test(requested)}`)
  if (!BRANCH_PATTERN.test(requested)) {
    console.log(`  → 会被 host 以 400 invalid branch name 拒绝`)
  }
  if (apply && BRANCH_PATTERN.test(requested)) {
    console.log('  执行 git checkout …')
    try {
      // 与 host 侧一致：不加 --force，也不自动 stash。
      await git(['checkout', requested], workspace)
      console.log('  ✓ 切换成功')
    } catch (error) {
      console.log(`  ✗ 失败: ${String(error.message).slice(0, 300)}`)
    }
  }
}

// 3) 当前状态，便于对照
const status = await git(['status', '--porcelain=v2', '--branch'], workspace)
const head = status.split('\n').find((l) => l.startsWith('# branch.head '))
console.log('')
console.log('当前分支:', head === undefined ? '(未取到)' : head.slice('# branch.head '.length).trim())
