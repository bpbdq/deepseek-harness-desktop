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
import { BrowserWindow, ipcMain, nativeTheme, screen } from 'electron'

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

/**
 * 面板的样式，跟随系统外观。
 *
 * 此前写死深色，于是**浅色系统下打开项目信息面板会是一整块深色**，与其余界面不一致。
 * 现在按当前系统偏好选用一套色板。
 * @returns 该面板的完整 CSS。
 */
export function panelCss(): string {
  const dark = nativeTheme.shouldUseDarkColors
  const c = dark
    ? {
        scheme: 'dark',
        bg: '#1b1b1f',
        fg: '#e8e8ea',
        border: '#2a2a30',
        label: '#9a9aa2',
        hint: '#7c7c85',
        buttonBg: '#2f2f36',
        buttonBorder: '#3d3d45',
        buttonHover: '#3a3a42',
      }
    : {
        scheme: 'light',
        bg: '#f6f6f8',
        fg: '#1f1f24',
        border: '#e2e2e8',
        label: '#5f5f68',
        hint: '#8a8a93',
        buttonBg: '#ffffff',
        buttonBorder: '#d0d0d8',
        buttonHover: '#eeeef2',
      }
  return `
  :root { color-scheme: ${c.scheme}; }
  * { box-sizing: border-box; }
  /* 让页面成为一列固定高度的布局：标题与内容可滚动，底部按钮永远贴在视口内。
     此前 body 只是普通块级盒，footer 随内容一起滚动——窗口一矮，操作按钮就被滚出
     可视区，用户看到的是"按钮不存在"，而实际它只是被推到下面了。 */
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex; flex-direction: column;
    font: 13px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: ${c.bg}; color: ${c.fg};
  }
  main { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 20px 22px 0; }
  h1 { margin: 0 0 14px; font-size: 15px; font-weight: 600; }
  .row { display: flex; gap: 14px; padding: 7px 0; border-top: 1px solid ${c.border}; }
  .row:first-of-type { border-top: none; }
  .label { flex: 0 0 128px; color: ${c.label}; }
  .value {
    flex: 1 1 auto; min-width: 0;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    word-break: break-all; white-space: pre-wrap;
  }
  .hint { margin-top: 3px; color: ${c.hint}; font-family: inherit; font-size: 12px; }
  /* 按钮区固定在底部，不随内容滚动。 */
  footer {
    flex: 0 0 auto;
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 12px 22px 16px;
    border-top: 1px solid ${c.border};
    background: ${c.bg};
  }
  button {
    font: inherit; padding: 6px 16px; border-radius: 6px; cursor: pointer;
    background: ${c.buttonBg}; color: ${c.fg}; border: 1px solid ${c.buttonBorder};
  }
  button:hover:not(:disabled) { background: ${c.buttonHover}; }
  button:disabled { opacity: .5; cursor: default; }
  /* 下载中的按钮：文字含百分比，略降不透明度提示不可重复点击。 */
  button.busy { opacity: .85; }
  button.primary { background: #2d4a7c; border-color: #3a5c94; color: #fff; }
  button.primary:hover:not(:disabled) { background: #35578f; }
`
}

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
<style>${panelCss()}${spec.css ?? ''}</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(spec.title)}</h1>
    ${spec.body}
  </main>
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

  // 高度不得超过屏幕可用区域，否则在小屏上窗口会超出屏幕、底部按钮同样够不到。
  // 用户仍可拖动边框调整大小（resizable: true）。
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const height = Math.min(spec.height, Math.round(workArea.height * 0.9))

  const window = new BrowserWindow({
    width: Math.min(spec.width, workArea.width - 40),
    height: Math.max(height, 400),
    parent,
    modal: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: spec.title,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f6f6f8',
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
