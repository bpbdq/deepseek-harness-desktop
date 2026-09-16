/**
 * BrowserWindow 及其"先显示、后就绪"的启动编排。
 *
 * 为什么窗口要先于服务端创建：
 *   DSH 的插件树 boot 实测要 ~10.7 秒（占启动总时长约 95%）。此前窗口是在
 *   `await server.start()` **之后**才创建的，用户要对着空屏幕等十几秒，主观上
 *   就是"启动特别慢"。改成先创建窗口并显示一个品牌化的加载页，等服务端就绪后
 *   再导航过去——总时长没变，但用户立刻有反馈。
 *
 * 认证握手（来自 dsh 的浏览器信任设计）：
 *   dsh-web-app 打印 `http://127.0.0.1:<port>/?token=<launch-token>`。服务端只在
 *   `GET /` 上接受该 token，用它写入绑定 authority 的 HttpOnly Cookie，然后 302 到
 *   干净的 `/`。所以窗口只加载一次带 token 的 URL，地址栏不会长期保留凭据。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, nativeTheme, shell, type BrowserWindowConstructorOptions } from 'electron'
import type { ServerReady } from './dsh-server'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const DEFAULT_STATE: WindowState = { width: 1440, height: 920 }

/** 加载页最多显示多久——即使 ready-to-show 不触发也要把窗口亮出来。 */
const SPLASH_FALLBACK_SHOW_MS = 2500

/**
 * 加载页的 HTML。
 *
 * 用临时文件而不是 data: URI —— 页面里有中文，data URI 需要 URL 编码，而 HTML
 * 又是 JS 模板拼的，两层转义极易出错（这个项目里中文编码已经踩过两次）。
 * @param title - 页面主标题。
 * @param hint - 次要提示文案。
 * @returns 完整 HTML 文档。
 */
function splashHtml(title: string, hint: string): string {
  // 加载页也要跟随系统外观。
  //
  // 此前整体写死深色，于是**系统设为浅色时，启动瞬间会先闪一块深色底**，而菜单栏周围
  // 也会露出深色——用户看到的就是"顶部这些没变成浅色"。这里按当前系统偏好选用配色，
  // 并让窗口背景色与之同步（见 themeBackground）。
  const dark = nativeTheme.shouldUseDarkColors
  const palette = dark
    ? { scheme: 'dark', bg: '#1b1b1f', fg: '#e8e8ea', hint: '#8a8a93' }
    : { scheme: 'light', bg: '#f6f6f8', fg: '#1f1f24', hint: '#6b6b75' }
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  :root { color-scheme: ${palette.scheme}; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 18px;
    background: ${palette.bg}; color: ${palette.fg};
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    user-select: none; -webkit-user-select: none;
  }
  .mark { display: flex; align-items: center; gap: 10px; opacity: .95; }
  .dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: #4d8dff; animation: pulse 1.1s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: .35; transform: scale(.85) } 50% { opacity: 1; transform: scale(1) } }
  h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .2px; }
  .hint { color: ${palette.hint}; font-size: 12.5px; }
</style>
</head>
<body>
  <div class="mark"><span class="dot"></span><h1>${title}</h1></div>
  <div class="hint">${hint}</div>
</body>
</html>`
}

/** 读取持久化的窗口几何。 */
function loadState(userDataDir: string): WindowState {
  const path = join(userDataDir, 'window-state.json')
  if (!existsSync(path)) return { ...DEFAULT_STATE }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WindowState>
    return {
      width: typeof parsed.width === 'number' ? parsed.width : DEFAULT_STATE.width,
      height: typeof parsed.height === 'number' ? parsed.height : DEFAULT_STATE.height,
      ...(typeof parsed.x === 'number' ? { x: parsed.x } : {}),
      ...(typeof parsed.y === 'number' ? { y: parsed.y } : {}),
      ...(parsed.maximized === true ? { maximized: true } : {}),
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/** 创建主窗口所需的配置。 */
export interface MainWindowOptions {
  /** Electron 的每用户数据目录。 */
  userDataDir: string
  /** 应用图标路径（存在时）。 */
  iconPath?: string
  /** 标题栏上的 git 徽章，如 `master*`。 */
  gitBadge?: string
  /** 加载页主标题。 */
  splashTitle: string
  /** 加载页提示文案。 */
  splashHint: string
}

/**
 * 立刻创建并显示窗口（加载页），并返回服务端就绪后用于导航的控制器。
 * @param options - 窗口与加载页配置。
 * @returns 窗口对象与 `navigate` / `close` 控制方法。
 */
export function createMainWindow(options: MainWindowOptions): {
  window: BrowserWindow
  navigate: (ready: ServerReady) => Promise<void>
  /** 清掉与上一个项目绑定的渲染进程状态（切换项目前调用）。 */
  clearProjectState: () => Promise<void>
  /** 更新加载页的提示文案（例如解包进度）。 */
  setSplashHint: (hint: string) => void
  close: () => void
} {
  const { userDataDir, iconPath, gitBadge, splashTitle, splashHint } = options
  const state = loadState(userDataDir)

  const constructorOptions: BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    // 窗口底板跟随系统外观：写死深色会在浅色系统下于页面加载前后露出深色边，
    // 用户看到的就是"顶部没跟着变浅色"。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f6f6f8',
    // 菜单栏承载着唯一用户可达的"检查更新"入口，必须常显。
    // autoHideMenuBar: true 会把它藏到 Alt 之后，等于让所有菜单项不可发现。
    autoHideMenuBar: false,
    title: 'DeepSeek Harness',
    ...(iconPath !== undefined ? { icon: iconPath } : {}),
    webPreferences: {
      // UI 是经 loopback 提供的官方 Web 构建，不需要 Node 能力，
      // 因此渲染进程保持完全沙箱化。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, '..', 'preload', 'preload.js'),
    },
  }

  const window = new BrowserWindow(constructorOptions)

  // 先显示加载页，让窗口立刻可见。
  const splashPath = join(userDataDir, 'splash.html')
  const writeSplash = (hint: string): void => {
    try {
      writeFileSync(splashPath, splashHtml(splashTitle, hint), 'utf8')
    } catch {
      // 写不了就退化成空白窗口，不影响后续导航。
    }
  }
  writeSplash(splashHint)
  void window.loadFile(splashPath)

  let shown = false
  /** 是否已经导航到真实 UI（导航后不得再重写加载页）。 */
  let navigated = false
  const show = (): void => {
    if (shown || window.isDestroyed()) return
    shown = true
    if (state.maximized === true) window.maximize()
    window.show()
  }
  window.once('ready-to-show', show)
  // 兜底：ready-to-show 在个别情况下不触发，不能让窗口永远藏着。
  setTimeout(show, SPLASH_FALLBACK_SHOW_MS)

  // 整个 UI 都在 loopback 的同一 origin 上，其它地址交给系统浏览器，
  // 而不是让外壳导航离开应用。
  let origin: string | undefined
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (origin === undefined || !url.startsWith(origin)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (origin !== undefined && !url.startsWith(origin)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // 网页 UI 会自己设置 document.title，导航后要把带 git 徽章的标题重新压回去，
  // 否则每次跳转都会把分支信息冲掉。
  const baseTitle = 'DeepSeek Harness'
  const title = gitBadge === undefined ? baseTitle : `${baseTitle} — ${gitBadge}`
  window.setTitle(title)
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(title)
  })

  window.on('close', () => persist(window, userDataDir))

  return {
    window,
    navigate: async (ready: ServerReady): Promise<void> => {
      origin = new URL(ready.url).origin
      // 带 token 的 URL 只加载一次，随后服务端会 302 到凭 Cookie 认证的干净根路径。
      await window.loadURL(ready.authenticatedUrl)
      // 标记已导航：此后不再允许重写加载页，否则会把真实界面刷掉。
      navigated = true
      show()
    },
    /**
     * 清掉渲染进程里与"上一个项目"绑定的持久化状态。
     *
     * 为什么必须清：dsh 把"当前选中的会话"和"工作区视图"存在 localStorage 里
     * （`dsh.sessions.current`、`dsh.workspace.view.v*`）。切换项目后这些指向的是
     * 旧项目里的会话，新服务端不认识它，于是界面卡在「自动重连中」——服务端其实
     * 已经就绪，只是客户端一直在重试一个不存在的会话（实测踩到过）。
     *
     * 清掉它们是安全的：会话数据在服务端，这里丢的只是"选中的是哪一个"。
     */
    clearProjectState: async (): Promise<void> => {
      if (window.isDestroyed()) return
      try {
        await window.webContents.executeJavaScript(
          `(() => { const keys = Object.keys(localStorage).filter((k) => k.startsWith('dsh.')); for (const k of keys) localStorage.removeItem(k); return keys.length })()`,
        )
      } catch {
        // 页面尚未加载时执行会抛错——此时本来也没有需要清理的状态。
      }
    },
    close: (): void => {
      if (!window.isDestroyed()) window.destroy()
    },
    setSplashHint: (hint: string): void => {
      // 只在还停在加载页时重写并重载：已经导航到真实 UI 之后再重载会把用户界面刷掉。
      if (window.isDestroyed() || navigated) return
      writeSplash(hint)
      void window.loadFile(splashPath)
    },
  }
}

/** 持久化窗口几何，下次启动还原。 */
function persist(window: BrowserWindow, userDataDir: string): void {
  try {
    const maximized = window.isMaximized()
    const bounds = maximized ? window.getNormalBounds() : window.getBounds()
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized,
    }
    writeFileSync(join(userDataDir, 'window-state.json'), JSON.stringify(state, null, 2) + '\n')
  } catch {
    // 几何信息是尽力而为，不能因为它阻塞关闭流程。
  }
}
