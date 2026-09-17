// 测出 bundle 请求被拒的阈值：同一路径逐段截短，看从多长开始返回 431。
//
//   node scripts/probe-431-threshold.mjs
//
// 已知：完整 URL 约 2.6 KB 时返回 431；服务端已加 --max-http-header-size=1MiB 仍然如此。
// 因此要判断 431 究竟由什么触发——是 URL 长度，还是路径里某个字符（例如 `??`）。
// 逐段截短能一次回答这两个问题。
import { connect } from './cdp-page.mjs'

const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)
const { evaluate, close } = await connect(PORT)

const results = await evaluate(`
  (async () => {
    const text = document.body.innerText || '';
    const m = /\\/plugins\\/\\?\\?[^\\s)]+/.exec(text);
    if (m === null) return JSON.stringify({ error: '页面上找不到 bundle URL' });
    const full = m[0];
    const cuts = [];
    // 在逗号边界上逐步截短，保持路径形态合法。
    for (const fraction of [1, 0.75, 0.5, 0.25, 0.1]) {
      let candidate = full.slice(0, Math.floor(full.length * fraction));
      const lastComma = candidate.lastIndexOf(',');
      if (lastComma > 0) candidate = candidate.slice(0, lastComma);
      cuts.push(candidate);
    }
    // 对照：去掉 revision、以及一个很短的合法路径。
    cuts.push(full.replace(/&v=\\d+$/, ''));
    cuts.push('/plugins/??@deepseek-ai/dsh-api-gateway/client.js');

    const out = [];
    for (const url of cuts) {
      try {
        const response = await fetch(url);
        const body = await response.text();
        out.push({ len: url.length, status: response.status, bodyLen: body.length });
      } catch (error) {
        out.push({ len: url.length, error: String(error && error.message).slice(0, 70) });
      }
    }
    return JSON.stringify({ fullLength: full.length, results: out });
  })()
`)

const parsed = JSON.parse(results)
if (parsed.error !== undefined) {
  console.log(parsed.error)
} else {
  console.log(`完整 URL 长度: ${parsed.fullLength}`)
  console.log('')
  console.log('  长度    状态码   响应体长度')
  for (const row of parsed.results) {
    if (row.error !== undefined) console.log(`  ${String(row.len).padStart(5)}    ${row.error}`)
    else console.log(`  ${String(row.len).padStart(5)}    ${String(row.status).padStart(5)}    ${row.bodyLen}`)
  }
}

close()
