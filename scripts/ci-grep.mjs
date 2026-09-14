// 在某个 run 的某个任务日志里做正则检索（替代不存在的远程 grep）。
//
//   node scripts/ci-grep.mjs <runId> <jobNameSubstring> <正则>
import { execFileSync } from 'node:child_process'

const [, , runId, filter, pattern] = process.argv
if (!runId || !filter || !pattern) {
  console.error('usage: node scripts/ci-grep.mjs <runId> <jobNameSubstring> <regex>')
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
  'user-agent': 'dsh-desktop-ci-grep',
}

const jobs = await (
  await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs`, { headers })
).json()
const job = jobs.jobs.find((j) => j.name.includes(filter))
if (!job) {
  console.error(`没有匹配 "${filter}" 的任务`)
  process.exit(1)
}

const response = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`, {
  headers: { ...headers, accept: '*/*' },
})
const text = await response.text()
const regex = new RegExp(pattern, 'i')
const matches = text
  .split('\n')
  .map((l) => l.replace(/^\S+Z\s?/, ''))
  .filter((l) => regex.test(l))

console.log(`### ${job.name}: 匹配 ${matches.length} 行`)
for (const line of matches.slice(-40)) console.log(line)
