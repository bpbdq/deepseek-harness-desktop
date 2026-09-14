// 拉取某个 run 的某个任务的完整日志，并打印尾部若干行。
//
//   node scripts/ci-tail.mjs <runId> <jobNameSubstring> [行数]
import { execFileSync } from 'node:child_process'

const [, , runId, filter, tailCount = '45'] = process.argv
if (!runId || !filter) {
  console.error('usage: node scripts/ci-tail.mjs <runId> <jobNameSubstring> [lines]')
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
  'user-agent': 'dsh-desktop-ci-tail',
}

const jobs = await (
  await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs`, { headers })
).json()

const job = jobs.jobs.find((j) => j.name.includes(filter))
if (!job) {
  console.error(`没有匹配 "${filter}" 的任务。可用: ${jobs.jobs.map((j) => j.name).join(' | ')}`)
  process.exit(1)
}

console.log(`### ${job.name} : ${job.conclusion ?? job.status}`)
for (const step of job.steps) {
  if (step.conclusion !== 'success' && step.conclusion !== 'skipped') {
    console.log(`### 非成功步骤: ${step.conclusion ?? step.status}  ${step.name}`)
  }
}

const response = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`, {
  headers: { ...headers, accept: '*/*' },
})
if (!response.ok) {
  console.error(`日志拉取失败: ${response.status} ${response.statusText}`)
  process.exit(1)
}

const text = await response.text()
const lines = text.split('\n')
// 去掉每行前缀的时间戳，便于阅读。
const clean = lines.map((l) => l.replace(/^\S+Z\s?/, ''))
console.log(`### 日志共 ${lines.length} 行，尾部 ${tailCount} 行：`)
console.log(clean.slice(-Number(tailCount)).join('\n'))
