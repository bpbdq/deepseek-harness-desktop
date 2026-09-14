/**
 * BrowserWindow that hosts the official dsh Web UI.
 *
 * Authentication handshake, taken from the dsh browser-trust design:
 *   dsh-web-app prints `http://127.0.0.1:<port>/?token=<launch-token>`. The server
 *   accepts that token only on `GET /`, writes an authority-bound signed HttpOnly
 *   cookie, and redirects to a clean `/`. So the window loads the token URL exactly
 *   once; every later request (including the /api WebSocket) rides the cookie and
 *   the URL bar never keeps the token.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import type { ServerReady } from './dsh-server'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const DEFAULT_STATE: WindowState = { width: 1440, height: 920 }

/**
 * Read persisted window geometry.
 * @param userDataDir - Electron's per-user data directory.
 * @returns the stored state, or defaults.
 */
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

/**
 * Create the main window and load the authenticated URL.
 * @param ready - the server readiness announcement.
 * @param userDataDir - Electron's per-user data directory.
 * @param iconPath - absolute path of the app icon, when one exists.
 * @returns the created window.
 */
export function createMainWindow(
  ready: ServerReady,
  userDataDir: string,
  iconPath: string | undefined,
): BrowserWindow {
  const state = loadState(userDataDir)
  const options: BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1b1b1f',
    // The menu bar carries the only user-reachable "check for updates" action, so
    // it must stay visible. `autoHideMenuBar: true` hides it behind an Alt press,
    // which makes every menu entry effectively undiscoverable.
    autoHideMenuBar: false,
    title: 'DeepSeek Harness',
    ...(iconPath !== undefined ? { icon: iconPath } : {}),
    webPreferences: {
      // The UI is the official web build served over loopback. It needs no
      // Node access, so keep the renderer fully sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, '..', 'preload', 'preload.js'),
    },
  }

  const window = new BrowserWindow(options)

  // The whole UI is one origin on loopback. Anything else opens in the real
  // browser instead of navigating the shell away from the app.
  const origin = new URL(ready.url).origin
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(origin)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (state.maximized === true) window.maximize()
  window.once('ready-to-show', () => window.show())

  window.on('close', () => persist(window, userDataDir))

  // The token URL is loaded once and 302s to the cookie-authenticated clean root.
  void window.loadURL(ready.authenticatedUrl)

  return window
}

/** Persist geometry so the next launch restores it. */
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
    // Geometry is best-effort; never block shutdown on it.
  }
}
