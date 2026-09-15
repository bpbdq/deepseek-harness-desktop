// 演练 CI 里"收集安装包"的 find 逻辑。
//
//   node scripts/rehearse-collect.mjs
//
// CI 用的命令是：
//   find release -mindepth 2 -maxdepth 2 -type f \( -name '*.exe' -o … \) -exec cp {} dist/ \;
// 也就是**只取 release/<版本>/ 这一层的文件**，不递归进 win-unpacked。
// 这个脚本用 Node 复现同一语义，确认结果是"只有安装包、没有 node.exe 之类的
// 构建工具产物"——那正是上一轮 Release 里混进 OpenConsole.exe / rg.exe 的原因。
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const releaseDir = 'release'
const outDir = '.collect-rehearsal'

if (!existsSync(releaseDir)) {
  console.error('没有 release/ 目录，先本地打包一次')
  process.exit(1)
}

/** 与 CI 一致的扩展名白名单。 */
const PATTERNS = [
  /\.exe$/u,
  /\.msi$/u,
  /\.AppImage$/u,
  /\.deb$/u,
  /\.rpm$/u,
  /\.dmg$/u,
  /\.zip$/u,
  // 刻意不含 .blockmap：它是差分下载用的索引，对下载安装包的用户没有意义，
  // 列在 Release 里只是噪音。去掉也不影响 electron-updater（会退回全量下载）。
  /^latest.*\.yml$/u,
]

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

let collected = 0
let excluded = 0

// mindepth 2 / maxdepth 2：release/<版本>/<文件>，恰好两层。
for (const versionDir of readdirSync(releaseDir, { withFileTypes: true })) {
  if (!versionDir.isDirectory()) continue
  const versionPath = join(releaseDir, versionDir.name)

  for (const entry of readdirSync(versionPath, { withFileTypes: true })) {
    const path = join(versionPath, entry.name)
    if (entry.isDirectory()) {
      // 例如 win-unpacked、__msi-x64：maxdepth 2 会排除它们的内容。
      excluded += 1
      console.log(`  跳过目录（maxdepth 之外）: ${path}`)
      continue
    }
    if (!statSync(path).isFile()) continue

    if (PATTERNS.some((pattern) => pattern.test(entry.name))) {
      copyFileSync(path, join(outDir, entry.name))
      collected += 1
      console.log(`  收集: ${entry.name}`)
    } else {
      excluded += 1
      console.log(`  跳过（扩展名不符）: ${entry.name}`)
    }
  }
}

console.log('')
console.log(`收集 ${collected} 个，跳过 ${excluded} 个`)
console.log('检查是否混入构建工具产物:')
const collectedNames = existsSync(outDir) ? readdirSync(outDir) : []
const junk = collectedNames.filter((name) => /^(node|OpenConsole|rg)\.exe$/u.test(name))
if (junk.length > 0) {
  console.error(`  混入: ${junk.join(', ')}`)
  process.exit(1)
}
console.log('  没有混入（正确）')
