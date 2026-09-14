// 打印某个 run/job 日志里包含指定文本的行及其前后 N 行上下文。
//
//   node scripts/ci-context.mjs <runId> <jobNameSubstring> <查找文本> [前后行数]
import { execFileSync } from 'node:child_process'

const [, , runId, filter, needle, radius = '12'] = process.argv
if (!runId || !filter || !needle) {
  console.error('usage: node scripts/ci-context.mjs <runId> <jobName> <text> [radius]')
  process.exit(1)
}

const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
  .split('\n')
  .find((l) => l.startsWith('password='))
  .slice('password='.length)
  .trim()

const repo = 'pucj0/deepseek-harness-desktop'
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-desktop-ci-context',
}

const jobs = await (
  await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs`, { headers })
).json()
const job = jobs.jobs.find((j) => j.name.includes(filter))
if (!job) {
  console.error(`没有匹配 "${filter}" 的任务`)
  process.exit(1)
}

const text = await (
  await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`, {
    headers: { ...headers, accept: '*/*' },
  })
).text()

const lines = text.split('\n').map((l) => l.replace(/^\S+Z\s?/, ''))
const n = Number(radius)
let printed = 0
for (let i = 0; i < lines.length; i += 1) {
  if (!lines[i].includes(needle)) continue
  printed += 1
  console.log(`──── 第 ${i + 1} 行 ────`)
  console.log(lines.slice(Math.max(0, i - n), i + n + 1).join('\n'))
  if (printed >= 3) break
}
if (printed === 0) console.log(`没有包含 "${needle}" 的行`)
