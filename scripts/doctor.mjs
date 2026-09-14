// 诊断：检查某个 Harness home 的模块回退链接是否指向存在的位置。
//
//   node scripts/doctor.mjs [dshHome]
//
// 背景：dsh 在 `$DSH_HOME/profiles/node_modules` 下建立指向安装目录的目录链接。
// 它判断"链接是否已是最新"靠比较 **链接目标字符串**（readlink === entry.packageDir），
// 因此当安装目录整体移动后（例如从 D:\Program Files 换到 %LOCALAPPDATA%），旧链接
// 仍会被判定为"最新"而不重建，结果就是所有 @deepseek-ai/* 都解析失败。
//
// 这个脚本只读地找出这类悬空链接。修复方式见脚本末尾的提示。
import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const home = resolve(process.argv[2] ?? process.env.DSH_HOME ?? join(process.env.APPDATA ?? '', 'dsh-desktop', 'home'))
const profilesModules = join(home, 'profiles', 'node_modules')

console.log(`[doctor] DSH_HOME          = ${home}`)
console.log(`[doctor] profiles/node_modules = ${profilesModules}`)
console.log(`[doctor] 该目录存在: ${existsSync(profilesModules)}`)

if (!existsSync(profilesModules)) {
  console.log('[doctor] 没有该目录：说明还没有任何 profile 启动过。')
  process.exit(0)
}

/** 递归读取一个 scope 目录下的链接，检查目标是否存在。 */
function scanScope(dir, label) {
  let ok = 0
  let broken = 0
  const brokenSamples = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    console.log(`[doctor] 无法读取 ${label}: ${error.message}`)
    return { ok, broken, brokenSamples }
  }

  for (const entry of entries) {
    const path = join(dir, entry.name)
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    if (!stat.isSymbolicLink()) continue

    let target
    try {
      target = readlinkSync(path)
    } catch {
      continue
    }
    // 相对链接相对于链接自身所在目录解析。
    const absolute = target.startsWith('\\\\') || /^[A-Za-z]:/u.test(target) ? target : resolve(dir, target)
    if (existsSync(absolute)) ok += 1
    else {
      broken += 1
      if (brokenSamples.length < 8) brokenSamples.push(`${entry.name}  ->  ${target}`)
    }
  }
  console.log(`[doctor] ${label}: 有效 ${ok}，失效 ${broken}`)
  for (const sample of brokenSamples) console.log(`[doctor]     ✗ ${sample}`)
  return { ok, broken, brokenSamples }
}

const scope = join(profilesModules, '@deepseek-ai')
const result = existsSync(scope)
  ? scanScope(scope, 'profiles/node_modules/@deepseek-ai')
  : { ok: 0, broken: 0, brokenSamples: [] }

if (!existsSync(scope)) {
  console.log('[doctor] @deepseek-ai scope 不存在：回退机制没有建立任何链接。')
}

console.log('')
if (result.broken > 0) {
  console.log(`[doctor] 结论: 发现 ${result.broken} 个失效链接，这就是 "Cannot find package" 的原因。`)
  console.log('[doctor] 修复: 删除整个 profiles 目录下的 node_modules 后重启应用，')
  console.log('         dsh 会在下次启动时重建全部链接：')
  console.log(`          Remove-Item -Recurse -Force "${profilesModules}"`)
} else if (result.ok > 0) {
  console.log(`[doctor] 结论: ${result.ok} 个链接全部有效，模块回退正常。`)
} else {
  console.log('[doctor] 结论: 没有找到任何链接，回退机制未生效。')
}
