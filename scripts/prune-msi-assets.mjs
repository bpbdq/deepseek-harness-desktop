// 从已发布的 Release 里移除 .msi 附件。
//
//   node scripts/prune-msi-assets.mjs --dry-run
//   node scripts/prune-msi-assets.mjs
//
// 为什么需要：CI 不再构建 MSI，但此前发布的各版本仍带着 .msi 附件。它们会一直留在
// Releases 页面，让人以为 MSI 仍是受支持的产物（而它安装界面是英文、构建还受路径长度
// 限制）。只删附件，不动标签、不动其它产物、不改发布时间。
const dryRun = process.argv.includes('--dry-run')
const REPO = 'pucj0/deepseek-harness-desktop'

const { execFileSync } = await import('node:child_process')
const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
  .split('\n')
  .find((line) => line.startsWith('password='))
  .slice('password='.length)
  .trim()

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-prune-msi',
}

const releases = await (await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, { headers })).json()

let removed = 0
for (const release of releases) {
  const msi = release.assets.filter((asset) => asset.name.endsWith('.msi'))
  if (msi.length === 0) continue
  for (const asset of msi) {
    if (dryRun) {
      console.log(`${release.tag_name}: 将删除 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）`)
      removed += 1
      continue
    }
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, {
      method: 'DELETE',
      headers,
    })
    const ok = response.status === 204
    if (ok) removed += 1
    console.log(`${release.tag_name}: ${asset.name} -> ${ok ? '已删除' : `失败(${response.status})`}`)
  }
}

console.log('')
console.log(dryRun ? `[dry-run] 将删除 ${removed} 个附件` : `共删除 ${removed} 个附件`)
