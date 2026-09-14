// 计算把 win-unpacked 树放进不同构建根后，最长路径是多少。
//
//   node scripts/check-path-length.mjs [runtime 目录]
//
// 存在的理由：MSI 的 WiX 链接器受 Windows MAX_PATH(260) 限制，而运行时树里
// @opentelemetry 嵌套很深。构建根一长就越线，而报错只说"找不到文件"
// (LGHT0103)，完全看不出是路径长度问题——上一版脚本就因此把结论算错了。
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const runtimeRelative = process.argv[2] ?? 'runtime'
const runtimeAbs = join(process.cwd(), runtimeRelative)

/** win-unpacked 下、resources 之前的固定部分。 */
const BEFORE_RESOURCES = 'release\\1.0.0\\win-unpacked\\'
/** runtime 树在 resources 下的位置。 */
const AFTER_RESOURCES = 'resources\\'

const files = []
function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile()) files.push(path)
  }
}
walk(runtimeAbs)

// 相对 runtimeAbs 的路径，就是最终路径里 runtime/ 之后的部分。
const rels = files.map((f) => relative(runtimeAbs, f))
let longest = ''
for (const rel of rels) if (rel.length > longest.length) longest = rel

console.log(`扫描 ${files.length} 个文件`)
console.log(`最长相对路径（runtime/ 之后）: ${longest.length} 字符`)
console.log(`  ${longest}`)
console.log('')

/** Windows 上被认为是"安全"的上限；到达 260 时 Win32 API 会拒绝。 */
const MAX_PATH = 260

const roots = {
  '本地 F:\\code\\dshDesktop': 'F:\\code\\dshDesktop\\',
  'CI   D:\\a\\deepseek-harness-desktop\\deepseek-harness-desktop':
    'D:\\a\\deepseek-harness-desktop\\deepseek-harness-desktop\\',
  'CI 短路径 C:\\b': 'C:\\b\\',
}

for (const [label, root] of Object.entries(roots)) {
  const total = root.length + BEFORE_RESOURCES.length + AFTER_RESOURCES.length + runtimeRelative.length + 1 + longest.length
  const verdict = total >= MAX_PATH ? `【${total - MAX_PATH} 字符越线】` : `ok（余量 ${MAX_PATH - total}）`
  console.log(`${label}`)
  console.log(`  ${root.length} + ${BEFORE_RESOURCES.length} + ${AFTER_RESOURCES.length} + ${runtimeRelative.length} + 1 + ${longest.length} = ${total}`)
  console.log(`  ${verdict}`)
}
