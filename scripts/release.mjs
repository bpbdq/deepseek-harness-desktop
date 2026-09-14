// 发布一个新版本：递增版本号、提交、打标签、推送，并触发 CI。
//
//   node scripts/release.mjs              按递增序列发下一个版本（1.0.0 → 1.0.1 → …）
//   node scripts/release.mjs 1.1.0        显式指定版本号
//   node scripts/release.mjs --dry-run    只打印将要发生的事，不改任何东西
//
// 存在的理由：手工发布踩过一次严重的坑——先 `version.mjs next`（得到 1.0.1），
// 却把标签打成了 `v1.1.0`。结果 CI 会构建出 1.0.1 的安装包、挂到名为 v1.1.0 的
// Release 上，而自动更新的 metadata 里写的版本号与标签不符，用户会收到"有新版本"
// 却永远装不上。这类"标签与内容不一致"的错误从外部看不出来，必须机器校验。
//
// 因此本脚本在打标签之前**强制**核对：
//   * package.json 的 version 与要打的标签一致
//   * package-lock.json 同步（否则 CI 的 npm ci 会失败）
//   * package.json 已提交（未提交时 CI 拿到的是旧版本号）
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { next, readVersion, writeVersion } from './version.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const explicit = args.find((token) => !token.startsWith('-'))

/** 跑一条 git 命令并返回输出。 */
function git(...argv) {
  return execFileSync('git', argv, { encoding: 'utf8' }).trim()
}

/** 按项目配置给 git 加上代理（推送需要）。 */
function gitWithProxy(...argv) {
  return execFileSync(
    'git',
    ['-c', 'http.proxy=http://127.0.0.1:7890', '-c', 'https.proxy=http://127.0.0.1:7890', ...argv],
    { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim()
}

const current = readVersion()
const target = explicit ?? next(current)

// 校验显式版本号格式；next() 已经保证格式。
if (explicit !== undefined && !/^\d+\.\d+\.\d+$/u.test(explicit)) {
  console.error(`版本号 "${explicit}" 不是 X.Y.Z 形式`)
  process.exit(1)
}

const tag = `v${target}`
console.log(`当前版本: ${current}`)
console.log(`目标版本: ${target}`)
console.log(`标签    : ${tag}`)

// 工作区必须干净：否则"提交了什么"说不清，标签与内容的一致性也无法保证。
const dirty = git('status', '--porcelain')
if (dirty !== '') {
  console.error('\n工作区不干净，先提交或撤销改动：')
  console.error(dirty)
  process.exit(1)
}

const existing = git('tag', '--list', tag)
if (existing !== '') {
  console.error(`\n标签 ${tag} 已存在。发布下一个版本请用：node scripts/release.mjs`)
  process.exit(1)
}

if (dryRun) {
  console.log('\n--dry-run：将执行以下步骤，但不做任何改动')
  console.log(`  1. 把 package.json / package-lock.json 的版本改为 ${target}`)
  console.log(`  2. git commit -m "release: ${target}"`)
  console.log(`  3. git tag -a ${tag}`)
  console.log('  4. push master 与标签（触发 CI 构建并发布 Release）')
  process.exit(0)
}

writeVersion(target)
const after = readVersion()
if (after !== target) {
  // 这一步几乎不可能失败，但"版本号写错"的代价很高，值一次断言。
  console.error(`写入失败：期望 ${target}，实际 ${after}`)
  process.exit(1)
}

git('add', 'package.json', 'package-lock.json')
git('commit', '-q', '-m', `release: ${target}`)

// 打标签**之前**再核对一次标签指向的提交里的版本号。
// 这是本脚本存在的核心理由：它挡住"标签与内容不一致"这类从外部看不出的错误。
const committedVersion = JSON.parse(git('show', 'HEAD:package.json')).version
if (committedVersion !== target) {
  console.error(`提交里的版本是 ${committedVersion}，与目标 ${target} 不一致，已中止`)
  process.exit(1)
}

git('tag', '-a', tag, '-m', `dsh-desktop ${target}`)
console.log('\n已提交并打标签，正在推送 …')
gitWithProxy('push', 'origin', 'master')
gitWithProxy('push', 'origin', tag)

console.log(`\n完成：${tag}（提交 ${git('rev-parse', '--short', 'HEAD')}）`)
console.log('CI 会构建三平台并直接发布 Release，可用以下命令查看进度：')
console.log('  node scripts/ci-status.mjs')
