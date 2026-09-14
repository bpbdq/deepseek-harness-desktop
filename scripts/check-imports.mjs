// 检查 src/ 下所有相对 import 的目标文件是否存在。
//
//   node scripts/check-imports.mjs [目录，默认 src]
//
// 存在的理由：本地编译看的是**磁盘状态**，CI 看的是**提交内容**。两者不一致时
// （新文件没 git add、改了文件忘了提交），本地一路通过而 CI 挂在编译上。
// 这个项目已经因此连续两轮 CI 失败：
//   * src/main/{git,module-heal,project-info}.ts 从未入库
//   * src/main/tray.ts 的 TrayActions.projectInfo 未提交
// tsc 其实也会报，但它的报错容易被误读成环境问题；这里给出更直白的结论。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = process.argv[2] ?? 'src'

/** 递归收集目录下的 .ts 文件。 */
function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return collect(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

/** 一个相对说明符在 TS/ESM 下的几种可能落点。 */
const EXTENSIONS = ['.ts', '.mts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js']

const problems = []
for (const file of collect(root)) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const base = resolve(dirname(file), match[1])
    if (!EXTENSIONS.some((ext) => existsSync(base + ext))) {
      problems.push(`${file} -> ${match[1]}`)
    }
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} 个相对 import 找不到目标文件（很可能忘了提交）:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`相对 import 检查通过（${collect(root).length} 个文件）`)
