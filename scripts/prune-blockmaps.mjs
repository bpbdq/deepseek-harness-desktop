// 从已发布的 Release 里删除 .blockmap 附件，保留其余一切。
//
//   node scripts/prune-blockmaps.mjs          删除
//   node scripts/prune-blockmaps.mjs --dry-run 只列出将要删除的
//
// 为什么要单独做这件事：附件已上传后，构建流程的排除规则管不到历史 Release。
// 逐个删除比删掉整个 Release 再重传温和得多——版本、发布时间、说明、下载计数
// 都保留下来，只有那 5 个索引文件消失。
import { execFileSync } from 'node:child_process'

const dryRun = process.argv.includes('--dry-run')
const REPO = 'pucj0/deepseek-harness-desktop'

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
  'user-agent': 'dsh-desktop-prune',
}

const releases = await (await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, { headers })).json()

let removed = 0
for (const release of releases) {
  const blockmaps = release.assets.filter((asset) => asset.name.endsWith('.blockmap'))
  if (blockmaps.length === 0) {
    console.log(`${release.tag_name}: 无 blockmap`)
    continue
  }
  console.log(`${release.tag_name}: ${blockmaps.length} 个 blockmap`)
  if (dryRun) {
    for (const asset of blockmaps) console.log(`  [dry-run] 将删除 ${asset.name}`)
    continue
  }
  for (const asset of blockmaps) {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, {
      method: 'DELETE',
      headers,
    })
    const ok = response.status === 204
    if (ok) removed += 1
    console.log(`  ${ok ? '已删除' : `失败(${response.status})`}  ${asset.name}`)
  }
}

console.log('')
console.log(dryRun ? `[dry-run] 共将删除 ${releases.reduce((n, r) => n + r.assets.filter((a) => a.name.endsWith('.blockmap')).length, 0)} 个` : `共删除 ${removed} 个`)
