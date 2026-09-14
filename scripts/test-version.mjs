// 验证版本递增规则与打包脚本的自动递增行为。
//
//   node scripts/test-version.mjs
//
// 覆盖三件事：
//   1. 递增规则的边界（1.0.8→1.0.9→1.1.0，以及 1.1.9→1.2.0）
//   2. bumpVersion 会同步 package.json 与 package-lock.json
//   3. 节流窗口内重复调用不再递增，--force 可绕过
//
// 用真的文件而不是 mock：版本号写错会直接导致 CI 的 npm ci 失败，值得用真实路径验证。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { next, parse } from './version.mjs'

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

console.log('1) 递增规则边界')
check('1.0.0 ->', next('1.0.0'), '1.0.1')
check('1.0.8 ->', next('1.0.8'), '1.0.9')
check('1.0.9 ->', next('1.0.9'), '1.1.0')
check('1.1.0 ->', next('1.1.0'), '1.1.1')
check('1.1.9 ->', next('1.1.9'), '1.2.0')

console.log('2) 非法版本号会被拒绝')
for (const bad of ['1.0', 'v1.0.0', '1.0.0-rc.1', '']) {
  let threw = false
  try {
    parse(bad)
  } catch {
    threw = true
  }
  check(`拒绝 ${JSON.stringify(bad)}`, threw, true)
}

// ---- 3. 用临时目录验证落盘行为 ---------------------------------------------
console.log('3) bumpVersion 的落盘与节流')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-version-'))
const original = process.cwd()

try {
  // 造一个最小工程：package.json + package-lock.json
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({ name: 'scratch', version: '1.0.0' }, null, 2) + '\n',
  )
  writeFileSync(
    join(scratch, 'package-lock.json'),
    JSON.stringify({ name: 'scratch', version: '1.0.0', lockfileVersion: 3, packages: { '': { version: '1.0.0' } } }, null, 2) + '\n',
  )

  // version.mjs 用 import.meta.dirname 定位工程根，因此必须把脚本本身也复制过去，
  // 否则它会去改真实工程。这是刻意为之：测试绝不能碰真版本号。
  const scriptsDir = join(scratch, 'scripts')
  const { mkdirSync, copyFileSync } = await import('node:fs')
  mkdirSync(scriptsDir, { recursive: true })
  copyFileSync(join(original, 'scripts', 'version.mjs'), join(scriptsDir, 'version.mjs'))

  const mod = await import(`file://${join(scriptsDir, 'version.mjs').replace(/\\/gu, '/')}`)

  const first = mod.bumpVersion({ quiet: true })
  check('首次递增 bumped', first.bumped, true)
  check('首次递增 to', first.to, '1.0.1')

  const after = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'))
  check('package.json 已更新', after.version, '1.0.1')

  const lock = JSON.parse(readFileSync(join(scratch, 'package-lock.json'), 'utf8'))
  check('package-lock 顶层已同步', lock.version, '1.0.1')
  check('package-lock packages[""] 已同步', lock.packages[''].version, '1.0.1')

  const second = mod.bumpVersion({ quiet: true })
  check('节流窗口内不再递增', second.bumped, false)
  check('节流后版本不变', mod.readVersion(), '1.0.1')

  const forced = mod.bumpVersion({ force: true, quiet: true })
  check('--force 可绕过节流', forced.bumped, true)
  check('强制递增后版本', mod.readVersion(), '1.0.2')

  check('节流戳已写出', existsSync(join(scratch, '.last-bump')), true)
} finally {
  process.chdir(original)
  rmSync(scratch, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
