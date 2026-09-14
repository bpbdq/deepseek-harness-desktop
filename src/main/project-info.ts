/**
 * “项目信息”窗口。
 *
 * 用 BrowserWindow 载入一个临时 HTML 文件，而不是 `data:` URI：data URI 里
 * 的中文与特殊字符必须 URL 编码，而 HTML 字符串又是用 JS 模板拼的，两层转义
 * 极易出错。写文件 + loadFile 绕开全部转义问题。
 *
 * 窗口是只读展示，因此 contextIsolation 打开、nodeIntegration 关闭、无 preload。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import type { GitInfo } from './git'

/** 面板上要展示的一行信息。 */
export interface InfoRow {
  label: string
  value: string
  /** 次要说明，灰色小字。 */
  hint?: string
}

/** 面板文案（由调用方按语言传入）。 */
export interface InfoStrings {
  title: string
  close: string
  notARepo: string
  dirty: string
  clean: string
  detached: string
}

/** HTML 转义，防止路径里的 `<` `&` 破坏页面。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

/**
 * 生成面板 HTML。
 *
 * 数据从同目录的 `<name>.json` 轮询读取，而不是把数值直接烧进 HTML。原因：
 * git 探测是异步的，而窗口应当在用户点菜单的瞬间就出现；轮询让面板先渲染、
 * 数据到位后自行刷新，也让"重新打开时是最新的"这件事自然成立。
 *
 * @param title - 窗口标题。
 * @param rows - 静态信息行（不含 git）。
 * @param strings - 文案。
 * @param dataFile - 与 HTML 同目录的数据文件名。
 * @returns 完整 HTML 文档。
 */
function renderInfoHtml(title: string, rows: InfoRow[], strings: InfoStrings, dataFile: string): string {
  const body = rows
    .map(
      (row) => `
      <div class="row">
        <div class="label">${escapeHtml(row.label)}</div>
        <div class="value">${escapeHtml(row.value)}${
          row.hint === undefined ? '' : `<div class="hint">${escapeHtml(row.hint)}</div>`
        }</div>
      </div>`,
    )
    .join('')

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 22px;
    font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: #1b1b1f; color: #e8e8ea;
  }
  h1 { margin: 0 0 14px; font-size: 15px; font-weight: 600; }
  .top { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; min-height: 24px; }
  .badge {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 12px; padding: 3px 9px; border-radius: 5px;
  }
  .badge.on { background: #2d4a7c; color: #cfe0ff; }
  .badge.off { background: #3a3a40; color: #9a9aa2; }
  .flags { font-size: 12px; color: #9a9aa2; }
  .row { display: flex; gap: 14px; padding: 7px 0; border-top: 1px solid #2a2a30; }
  .row:first-of-type { border-top: none; }
  .label { flex: 0 0 132px; color: #9a9aa2; }
  .value {
    flex: 1 1 auto; min-width: 0;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    word-break: break-all; white-space: pre-wrap;
  }
  .hint { margin-top: 3px; color: #7c7c85; font-family: inherit; font-size: 12px; }
  footer { margin-top: 18px; display: flex; justify-content: flex-end; }
  button {
    font: inherit; padding: 6px 18px; border-radius: 6px; cursor: pointer;
    background: #2f2f36; color: #e8e8ea; border: 1px solid #3d3d45;
  }
  button:hover { background: #3a3a42; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="top" id="git"><span class="flags">…</span></div>
  ${body}
  <footer><button autofocus onclick="window.close()">${escapeHtml(strings.close)}</button></footer>
<script>
  const strings = ${JSON.stringify(strings)};
  const target = document.getElementById('git');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  function render(git) {
    if (!git || !git.isRepo || !git.branch) {
      target.innerHTML = '<span class="badge off">' + esc(strings.notARepo) + '</span>';
      return;
    }
    const flags = [];
    if (git.dirty) flags.push(esc(strings.dirty) + (git.changedFiles || 0));
    else flags.push(esc(strings.clean));
    if (git.ahead > 0) flags.push('\\u2191' + git.ahead);
    if (git.behind > 0) flags.push('\\u2193' + git.behind);
    target.innerHTML = '<span class="badge on">' + esc(git.branch) + '</span>' +
      '<span class="flags">' + flags.join(' \\u00b7 ') + '</span>';
  }

  async function poll() {
    try {
      const response = await fetch(${JSON.stringify(dataFile)} + '?t=' + Date.now());
      render(await response.json());
    } catch {
      /* 文件还没写好，下一轮再试 */
    }
  }
  poll();
  const timer = setInterval(poll, 700);
  window.addEventListener('beforeunload', () => clearInterval(timer));
</script>
</body>
</html>`
}

/**
 * 打开项目信息窗口。
 * @param parent - 父窗口。
 * @param userDataDir - 写入临时 HTML 与 JSON 的位置。
 * @param title - 窗口标题。
 * @param rows - 静态信息行。
 * @param strings - 文案。
 * @returns 打开的窗口。
 */
export function showProjectInfo(
  parent: BrowserWindow,
  userDataDir: string,
  title: string,
  rows: InfoRow[],
  strings: InfoStrings,
): { window: BrowserWindow; publish: (git: GitInfo) => void } {
  const htmlPath = join(userDataDir, 'project-info.html')
  const dataPath = join(userDataDir, 'project-info.json')
  writeFileSync(htmlPath, renderInfoHtml(title, rows, strings, 'project-info.json'), 'utf8')
  // 先写一份占位，避免面板首次轮询 404。
  writeFileSync(dataPath, JSON.stringify({ isRepo: false }), 'utf8')

  const window = new BrowserWindow({
    width: 580,
    height: 440,
    parent,
    modal: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void window.loadFile(htmlPath)

  return {
    window,
    publish: (git: GitInfo): void => {
      try {
        writeFileSync(dataPath, JSON.stringify(git), 'utf8')
      } catch {
        // 面板是只读展示，写失败不值得打断用户。
      }
    },
  }
}
