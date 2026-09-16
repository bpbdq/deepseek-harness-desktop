// 对运行中的实例实测 review 路由的延迟，验证"常驻索引"确实把轮询成本降下来了。
//
//   node scripts/measure-review-live.mjs [工作区路径]
//
// 为什么要单独测：最初的实现每次轮询都整树重新哈希（实测约 4 秒，甚至更慢），而客户端
// 每 4 秒轮询一次——延迟等于轮询间隔就会把请求堆起来。改成复用常驻索引后，git 靠 stat
// 缓存跳过未变文件，这个脚本用来确认延迟真的落到了可用范围。
const workspace = process.argv[2] ?? 'E:\\workspace\\mmsm-amis'

/** 找到本应用的插件端口。 */
async function findPort() {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
  const ports = new Set()
  for (const line of out.split('\n')) {
    const match = /TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/u.exec(line)
    if (match !== null) ports.add(Number(match[1]))
  }
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, sessionId: 'probe' }),
        signal: AbortSignal.timeout(1500),
      })
      const payload = await response.json()
      // 只有我们的路由会返回这几个字段之一。
      if (payload.isRepo !== undefined || payload.noBaseline !== undefined || payload.code === 'workspaceNotAllowed') {
        return port
      }
    } catch {
      // 不是这个端口。
    }
  }
  return undefined
}

const port = await findPort()
if (port === undefined) {
  console.error('找不到 review 路由，先启动应用')
  process.exit(1)
}
console.log(`端口: ${port}`)
console.log(`仓库: ${workspace}`)
console.log('')

const call = async (route, body) => {
  const started = Date.now()
  const response = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  })
  const payload = await response.json()
  return { ms: Date.now() - started, status: response.status, payload }
}

const session = `perf-${Date.now()}`

// 1) 记基线（一次，允许慢）
let result = await call('baseline', { workspace, sessionId: session })
console.log(`记基线      : ${result.status}  ${(result.ms / 1000).toFixed(2)}s  ${JSON.stringify(result.payload).slice(0, 90)}`)

// 2) 连续取差异（轮询路径，必须快）
const timings = []
for (let i = 0; i < 5; i += 1) {
  result = await call('changes', { workspace, sessionId: session })
  const files = result.payload.files?.length ?? 0
  timings.push(result.ms)
  console.log(`取差异 #${i + 1}   : ${result.status}  ${(result.ms / 1000).toFixed(2)}s  files=${files}`)
}

const first = timings[0]
const rest = timings.slice(1)
const average = rest.length > 0 ? rest.reduce((a, b) => a + b, 0) / rest.length : first
console.log('')
console.log(`首次 ${(first / 1000).toFixed(2)}s（构建常驻索引）  之后平均 ${(average / 1000).toFixed(2)}s`)
console.log(average < 2000 ? '结论：轮询延迟在可用范围（< 2s）' : `结论：轮询仍偏慢（${(average / 1000).toFixed(2)}s），需要继续优化`)
