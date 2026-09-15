// 扫本地监听端口，找出哪个是 dsh 服务端并实测 gitbar 路由。
//
//   node scripts/probe-installed-gitbar.mjs
//
// 为什么不用 PID 过滤：那要在 Node 里再调 PowerShell，引号嵌套必然出问题（这个项目
// 里已经反复踩过）。直接"扫端口 + 按响应特征识别"更简单，也更能反映真实情况——
// 毕竟我们要证明的正是"这个路由在真实安装的实例上可用"。
const { execFileSync } = await import('node:child_process')

const netstat = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
const ports = new Set()
for (const line of netstat.split('\n')) {
  const match = /TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/u.exec(line)
  if (match !== null) ports.add(Number(match[1]))
}

console.log('本地监听端口:', [...ports].sort((a, b) => a - b).join(', '))
console.log('')

let found = 0
for (const port of [...ports].sort((a, b) => a - b)) {
  for (const path of ['status', 'branches']) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/dsh-desktop/gitbar/${path}`, {
        signal: AbortSignal.timeout(2500),
      })
      if (response.status !== 200) continue
      const text = await response.text()
      // 只看状态码会误判：本地别的服务对未知路径也可能回 200（拿到过二进制与 JWT）。
      // 必须能解析成 JSON 且含本插件的字段，才算真的命中。
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        continue
      }
      const looksLikeOurs =
        path === 'status'
          ? typeof payload?.branch === 'string' || payload?.isRepo !== undefined
          : Array.isArray(payload?.branches)
      if (!looksLikeOurs) continue

      console.log(`端口 ${port}  GET /dsh-desktop/gitbar/${path} -> 200`)
      console.log(`  ${text.slice(0, 200)}`)
      found += 1
    } catch {
      // 不是我们的服务端，或该端口不响应——继续。
    }
  }
}

console.log('')
console.log(found === 0 ? '没有端口响应 gitbar 路由（插件未挂载？）' : `共命中 ${found} 次`)
