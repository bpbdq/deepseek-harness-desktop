// 移除一个文本文件的 UTF-8 BOM。
//
//   node scripts/_strip-bom.cjs <文件>
//
// 存在理由：PowerShell 的 `Set-Content -Encoding utf8` 会写入 BOM，而 YAML/JSON
// 解析器遇到 BOM 会在首行报错。这个工具让修正是可复现的一步，而不是靠手改。
//
// 用 CommonJS：文件名是 .cjs，node 据此按 CJS 解析，import 语法会直接报错。
const fs = require('node:fs')

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/_strip-bom.cjs <file>')
  process.exit(1)
}

const text = fs.readFileSync(file, 'utf8')
if (text.charCodeAt(0) !== 0xfeff) {
  console.log('没有 BOM，无需处理')
  process.exit(0)
}

fs.writeFileSync(file, text.slice(1), 'utf8')
const bytes = fs.readFileSync(file)
console.log(`已移除 BOM，现在前 3 字节: ${[...bytes.slice(0, 3)].join(',')}`)
