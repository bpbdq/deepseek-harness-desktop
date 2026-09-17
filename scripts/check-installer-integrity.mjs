// 校验本地下载的安装包与 GitHub Release 上的产物是否逐字节一致。
//
//   node scripts/check-installer-integrity.mjs
//
// 背景：静默安装报 0xC0000005（访问冲突）。在归因到环境之前，必须先排除"下载的安装包
// 本身损坏"——用发布产物的 sha256 直接比对，比凭体积判断可靠。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const targets = [
  { tag: 'v1.2.6', file: join(tmpdir(), 'dsh-1.2.6-setup.exe') },
  { tag: 'v1.2.8', file: join(tmpdir(), 'dsh-1.2.8-setup.exe') },
]

const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
  .split('\n')
  .find((line) => line.startsWith('password='))
  .slice('password='.length)
  .trim()

const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh' }
const releases = await (await fetch('https://api.github.com/repos/pucj0/deepseek-harness-desktop/releases?per_page=20', { headers })).json()

for (const { tag, file } of targets) {
  const release = releases.find((r) => r.tag_name === tag)
  if (release === undefined) {
    console.log(`${tag}: 找不到该 Release`)
    continue
  }
  const asset = release.assets.find((a) => a.name === 'dsh-desktop-x64.exe')
  let local
  try {
    local = createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    console.log(`${tag}: 本地文件不存在（${file}）`)
    continue
  }
  const remote = String(asset.digest ?? '').replace('sha256:', '')
  const same = remote === '' ? '未知（API 未提供 digest）' : String(local === remote)
  console.log(`${tag}: 本地 ${local.slice(0, 20)}…  远端 ${remote === '' ? '(无)' : remote.slice(0, 20) + '…'}  一致=${same}`)
}
