// 查询 GitHub Actions 运行状态与失败步骤。
//
//   node scripts/ci-status.mjs [运行数量]
//
// 存在的理由：CI 失败时先要快速看出"哪个任务、哪一步"，再决定是否拉日志。
// 用 Node 而不是 PowerShell：这台机器上 PowerShell 的执行策略会拦脚本，
// 而 Node 没有这个限制，也和 scripts/ci-logs.mjs 保持一致。
import { execFileSync } from 'node:child_process'

const count = Number(process.argv[2] ?? 3)
const repo = 'pucj0/deepseek-harness-desktop'

/** 从 git 的凭据助手取 token（输入走 stdin，不进程列表、不打印）。 */
function githubToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (!line) throw new Error('git 凭据里没有 github.com 的 token')
  return line.slice('password='.length).trim()
}

const headers = {
  authorization: `Bearer ${githubToken()}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-desktop-ci-status',
}

const get = async (url) => {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

const runs = await get(`https://api.github.com/repos/${repo}/actions/runs?per_page=${count}`)

for (const run of runs.workflow_runs) {
  const state = run.conclusion ?? run.status
  console.log(`=== run #${run.run_number}  ${run.head_sha.slice(0, 7)}  ${state} — ${run.display_title}`)
  try {
    const jobs = await get(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`)
    for (const job of jobs.jobs) {
      const jobState = job.conclusion ?? job.status
      const failed = job.steps.find((s) => s.conclusion === 'failure')
      console.log(
        `    ${String(jobState).padEnd(11)} ${job.name}${failed ? `  <- 失败步骤: ${failed.name}` : ''}`,
      )
    }
  } catch (error) {
    console.log(`    (jobs 未就绪: ${error.message})`)
  }
}
