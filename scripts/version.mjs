// 版本号管理。
//
// CLI：
//   node scripts/version.mjs                 显示当前版本与下一个版本
//   node scripts/version.mjs next            递增（1.0.0→1.0.1→…→1.0.9→1.1.0）
//   node scripts/version.mjs list            列出发布序列
//   node scripts/version.mjs 1.0.3           显式设置
//
// 也被 build.mjs 以模块方式引入（`bumpVersion` / `readVersion`），所以本文件在
// 被 import 时**不能有副作用**——CLI 入口用 `import.meta.main` 守卫。
//
// 版本只写在 package.json 里；electron-builder 从那里读取，产物目录名也用它。
// 用 Node 而非批处理做这件事，是因为 cmd 解析中文与带引号的 JSON 都不可靠。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const MANIFEST = resolve(ROOT, 'package.json')
const LOCKFILE = resolve(ROOT, 'package-lock.json')

/** 计划发布序列：补丁号到 9 之后进位到次版本。 */
const PATCH_LIMIT = 9

/**
 * 递增节流窗口（毫秒）。
 *
 * 为什么需要：打包脚本现在默认每次 +1，而一次完整打包会因为镜像、阶段脚本等
 * 原因被反复重跑。没有这个闸门时，调试期间每跑一次 build.bat 就吃掉一个版本号。
 * 同一窗口内的重复调用返回"未递增"，版本号因此不会被无意义地消耗。
 *
 * 需要强制递增时用 `node scripts/version.mjs next --force`，不再受此限制。
 */
const BUMP_THROTTLE_MS = 5 * 60 * 1000

/** 记录上一次自动递增时刻的文件（仅用于节流，不参与构建）。 */
const BUMP_STAMP = resolve(ROOT, '.last-bump')

/** 读取 package.json 的版本号。 */
export function readVersion() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  if (typeof manifest.version !== 'string') throw new Error('package.json 里没有 version 字段')
  return manifest.version
}

/** 递增序列的纯函数版本，便于无需落盘地验证规则。 */
export function sequenceFrom(start, count = 4) {
  const out = []
  let version = start
  for (let index = 0; index < count; index += 1) {
    out.push(version)
    version = next(version)
  }
  return out
}

/**
 * 写入版本号，保留其余字段。
 *
 * 同时同步 package-lock.json 的顶层 version：两者不一致时，`npm ci` 会抱怨
 * 甚至拒绝执行，而 CI 用的正是 `npm ci`。锁文件缺失就跳过（还没有依赖时正常）。
 * @param version - 目标版本号。
 * @returns 实际被更新的文件列表。
 */
export function writeVersion(version) {
  const updated = []

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  manifest.version = version
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  updated.push('package.json')

  if (existsSync(LOCKFILE)) {
    try {
      const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'))
      // 锁文件里只有根包的 version 跟随 package.json；依赖条目的 version 是
      // 各自包的版本，绝不能动。两个字段都要改（v2/v3 锁文件两份都有）。
      if (lock.version !== version) {
        lock.version = version
        if (lock.packages?.[''] !== undefined) lock.packages[''].version = version
        writeFileSync(LOCKFILE, JSON.stringify(lock, null, 2) + '\n')
        updated.push('package-lock.json')
      }
    } catch (error) {
      // 锁文件坏了就让 npm 自己修，这里不阻断版本变更。
      console.warn(`[version] 警告: 无法更新 package-lock.json (${error.message})`)
    }
  }

  return updated
}

/** 解析 X.Y.Z，返回三段数字。 */
export function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  if (match === null) throw new Error(`版本号 "${version}" 不是 X.Y.Z 形式`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** 按本项目的发布规则算出下一个版本。 */
export function next(version) {
  const { major, minor, patch } = parse(version)
  if (patch >= PATCH_LIMIT) return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** 列出 1.0.0 起的序列。 */
export function sequence() {
  const out = []
  let version = '1.0.0'
  for (let index = 0; index < 12; index += 1) {
    out.push(version)
    version = next(version)
  }
  return out
}

/**
 * 判断当前是否处于节流窗口内（即刚刚递增过）。
 * @returns 距离上次递增已过的毫秒数；未记录过时为 undefined。
 */
function msSinceLastBump() {
  try {
    const stamp = Number(readFileSync(BUMP_STAMP, 'utf8').trim())
    if (!Number.isFinite(stamp)) return undefined
    return Date.now() - stamp
  } catch {
    return undefined
  }
}

/**
 * 递增版本（打包脚本的默认行为）。
 *
 * @param options - `force` 忽略节流窗口；`quiet` 不打印。
 * @returns `from`/`to` 与是否真的递增了（`bumped`）。
 */
export function bumpVersion(options = {}) {
  const { force = false, quiet = false } = options
  const current = readVersion()

  if (!force) {
    const elapsed = msSinceLastBump()
    if (elapsed !== undefined && elapsed >= 0 && elapsed < BUMP_THROTTLE_MS) {
      const left = Math.ceil((BUMP_THROTTLE_MS - elapsed) / 1000)
      if (!quiet) {
        console.log(
          `[version] 版本仍为 ${current}（${Math.round(elapsed / 1000)} 秒前刚递增过，` +
            `${left} 秒内重复打包不再递增；需要强制请用 --force）`,
        )
      }
      return { bumped: false, from: current, to: current }
    }
  }

  const target = next(current)
  writeVersion(target)
  try {
    writeFileSync(BUMP_STAMP, `${Date.now()}\n`)
  } catch {
    // 节流戳写不了不影响版本本身。
  }
  if (!quiet) console.log(`[version] ${current} -> ${target}`)
  return { bumped: true, from: current, to: target }
}

// ---- CLI 入口：只在直接运行时执行 ------------------------------------------
if (import.meta.main) {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const action = args.find((token) => !token.startsWith('-'))
  const current = readVersion()

  if (action === undefined || action === 'show') {
    console.log(`当前版本: ${current}`)
    console.log(`下一个版本: ${next(current)}`)
    console.log('')
    console.log('  node scripts/version.mjs next            递增到下一个版本')
    console.log('  node scripts/version.mjs next --force    忽略节流，强制递增')
    console.log('  node scripts/version.mjs 1.0.3           显式设置')
    console.log('  node scripts/version.mjs list            列出发布序列')
  } else if (action === 'list') {
    console.log('计划发布序列（1.0.0 → 1.0.9 → 1.1.0）:')
    const all = sequence()
    console.log('  ' + all.slice(0, 5).join('   '))
    console.log('  ' + all.slice(5, 10).join('   '))
    console.log('  ' + all.slice(10, 12).join('   '))
  } else if (action === 'next') {
    const result = bumpVersion({ force })
    if (result.bumped) {
      console.log('接着运行: build.bat')
    } else {
      console.log('当前版本未变；需要强制递增请加 --force')
    }
  } else {
    parse(action) // 校验格式，失败则抛错
    const updated = writeVersion(action)
    console.log(`${current}  ->  ${action}`)
    console.log(`已更新: ${updated.join(', ')}`)
    console.log('接着运行: build.bat')
  }
}
