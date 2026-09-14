// 用已存储的 git 凭据调用 GitHub API 拉取 Actions 日志。
//
//   node scripts/ci-logs.mjs <runId> [jobNameSubstring] [输出文件]
//
// 存在的理由：CI 失败时 API 的 jobs 接口只给"哪一步失败"，不给原因。日志需要
// 管理员权限（对自有仓库，存储的凭据就有）。token 从 git credential 读入内存，
// 既不作为命令行参数（会进进程列表），也不打印到输出。
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [, , runId, filter = '', outFile] = process.argv
if (!runId) {
  console.error('usage: node scripts/ci-logs.mjs <runId> [jobNameSubstring] [outFile]')
  process.exit(1)
}

/** 从 git 的凭据助手取 token。输入走 stdin，避免出现在进程列表里。 */
function githubToken() {
  const input = 'protocol=https\nhost=github.com\n\n'
  const out = execFileSync('git', ['credential', 'fill'], { input, encoding: 'utf8' })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (!line) throw new Error('git 凭据里没有 github.com 的 token')
  return line.slice('password='.length).trim()
}

const token = githubToken()

/** 带鉴权的 GET。 */
async function api(url, accept = 'application/vnd.github+json') {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept, 'user-agent': 'dsh-desktop-ci-logs' },
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return response
}

const repo = 'pucj0/deepseek-harness-desktop'

const jobs = await (await api(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs`)).json()
const targets = jobs.jobs.filter((j) => filter === '' || j.name.includes(filter))
if (targets.length === 0) {
  console.error(`没有匹配 "${filter}" 的任务。可用: ${jobs.jobs.map((j) => j.name).join(' | ')}`)
  process.exit(1)
}

let collected = ''
for (const job of targets) {
  console.log(`──── ${job.name} (${job.conclusion}) ────`)
  const response = await api(`https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`, '*/*')
  const text = await response.text()
  collected += `\n===== ${job.name} =====\n${text}\n`

  // 只打印失败步骤附近的上下文，避免几千行刷屏。
  const lines = text.split('\n')
  const failIndex = lines.findIndex((l) => /error|failed|⨯/i.test(l))
  if (failIndex < 0) {
    console.log('（未找到明显的错误行，打印最后 30 行）')
    console.log(lines.slice(-30).join('\n'))
  } else {
    const start = Math.max(0, failIndex - 12)
    console.log(`（错误出现在第 ${failIndex + 1} 行附近，打印上下文）`)
    console.log(lines.slice(start, failIndex + 45).join('\n'))
  }
}

if (outFile) {
  writeFileSync(outFile, collected, 'utf8')
  console.log(`\n完整日志已写入 ${outFile}`)
}
