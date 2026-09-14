/**
 * 信息面板窗口（项目信息、更新）的共享实现。
 *
 * 两个面板需要同一套东西：临时 HTML 文件 + 一个只读窗口 + 主进程向渲染进程推送
 * 实时数据。这里抽成一份，避免两处各写一遍转义与生命周期逻辑。
 *
 * 为什么用**临时文件**而不是 `data:` URI：页面里有中文，data URI 需要 URL 编码，
 * 而 HTML 又是 JS 模板拼的，两层转义极易出错（这个项目里中文编码已踩过两次）。
 *
 * 为什么用 **IPC 推送**而不是让页面轮询文件：更新进度是百分比、秒级变化，轮询既
 * 浪费又抖。主进程直接用 `webContents.send` 推给渲染进程。
 *
 * 为什么需要 preload：窗口开了 sandbox + contextIsolation，页面拿不到 ipcRenderer。
 * preload 通过 `additionalArguments` 拿到本窗口的频道名，把它暴露成一个小 API。
 * 不用环境变量是因为环境变量是进程级的，两个面板同时打开时会互相覆盖。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'

/** 面板的一行静态信息。 */
export interface PanelRow {
  label: string
  value: string
  hint?: string
}

/** 由调用方提供的页面外观与内容。 */
export interface PanelSpec {
  /** 面板标识，同时作为临时文件名与 IPC 频道前缀。 */
  id: string
  /** 窗口标题。 */
  title: string
  /** 静态信息行。 */
  rows: PanelRow[]
  /** 关闭按钮文案。 */
  close: string
  /** 追加的 CSS。 */
  css?: string
  /** 页面主体 HTML（动态部分留空，由推送填充）。 */
  body: string
  /** 页脚按钮 HTML。 */
  footer?: string
  /** 页面脚本：在 preload 暴露的 API 上注册渲染函数。 */
  script: string
  /** 窗口尺寸。 */
  width: number
  height: number
}

/** HTML 转义，防止路径里的 < & " 破坏页面。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

/** 把静态信息行渲染成 HTML。 */
export function renderRows(rows: readonly PanelRow[]): string {
  return rows
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
}

/** 面板的默认样式：与官方 Web UI 的深色基调一致。 */
export const PANEL_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 22px;
    font: 13px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: #1b1b1f; color: #e8e8ea;
  }
  h1 { margin: 0 0 14px; font-size: 15px; font-weight: 600; }
  .row { display: flex; gap: 14px; padding: 7px 0; border-top: 1px solid #2a2a30; }
  .row:first-of-type { border-top: none; }
  .label { flex: 0 0 128px; color: #9a9aa2; }
  .value {
    flex: 1 1 auto; min-width: 0;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    word-break: break-all; white-space: pre-wrap;
  }
  .hint { margin-top: 3px; color: #7c7c85; font-family: inherit; font-size: 12px; }
  footer { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }
  button {
    font: inherit; padding: 6px 16px; border-radius: 6px; cursor: pointer;
    background: #2f2f36; color: #e8e8ea; border: 1px solid #3d3d45;
  }
  button:hover:not(:disabled) { background: #3a3a42; }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: #2d4a7c; border-color: #3a5c94; }
  button.primary:hover:not(:disabled) { background: #35578f; }
`

/**
 * 打开一个信息面板窗口。
 *
 * @param parent - 父窗口。
 * @param userDataDir - 写入临时 HTML 的位置。
 * @param spec - 面板外观与内容。
 * @param onAction - 页面按钮点击回调，参数是按钮的 `data-action`。
 * @returns 窗口与 `push(channel, payload)`。
 */
export function openPanel(
  parent: BrowserWindow,
  userDataDir: string,
  spec: PanelSpec,
  onAction: (action: string) => void,
): { window: BrowserWindow; push: (channel: string, payload: unknown) => void } {
  const pushChannel = `${spec.id}:push`
  const actionChannel = `${spec.id}:action`

  const htmlPath = join(userDataDir, `${spec.id}.html`)
  writeFileSync(
    htmlPath,
    `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${escapeHtml(spec.title)}</title>
<style>${PANEL_CSS}${spec.css ?? ''}</style>
</head>
<body>
  <h1>${escapeHtml(spec.title)}</h1>
  ${spec.body}
  ${spec.footer ?? ''}
<script>
  // 页面只负责渲染：数据由主进程推送，按钮点击回传 action。
  window.__panelReady = (render) => { window.__render = render; };
  window.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (button && !button.disabled) window.dshPanel.action(button.dataset.action);
    });
    ${spec.script}
  });
</script>
</body>
</html>`,
    'utf8',
  )

  const window = new BrowserWindow({
    width: spec.width,
    height: spec.height,
    parent,
    modal: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: spec.title,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '..', 'preload', 'panel.js'),
      // 频道名随窗口走，两个面板同时打开时不会串。
      additionalArguments: [`--panel-push=${pushChannel}`, `--panel-action=${actionChannel}`],
    },
  })
  void window.loadFile(htmlPath)

  const handler = (_event: Electron.IpcMainEvent, action: unknown): void => {
    if (typeof action === 'string') onAction(action)
  }
  ipcMain.on(actionChannel, handler)

  window.on('closed', () => {
    ipcMain.removeListener(actionChannel, handler)
  })

  return {
    window,
    push: (channel: string, payload: unknown): void => {
      if (window.isDestroyed()) return
      // 任意频道都发到同一个渲染侧回调，由页面按 channel 分派。
      window.webContents.send(pushChannel, { channel, payload })
    },
  }
}
