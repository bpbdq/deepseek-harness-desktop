/**
 * DeepSeek Harness desktop shell — main process.
 *
 * Owns the application lifecycle around one dsh server child process:
 * single-instance gate, workspace resolution, credential injection, window
 * creation, tray, and runtime updates.
 *
 * The heavy lifting (sandboxing, tools, sessions, jobs, subagents) all happens in
 * the child; this process is a shell and never runs agent code.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeTheme, shell } from 'electron'

import { CredentialStore } from './credentials'
import { DshServer } from './dsh-server'
import { format, initShellStrings, t } from './i18n'
import { resolveRuntime } from './paths'
import type { RuntimeLocation } from './paths'
import { installCloseToTray, createTray } from './tray'
import { RuntimeUpdater, locateNpmCli } from './updater'
import { createMainWindow } from './window'

const SHELL_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string })
      .version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

interface DesktopSettings {
  workspace?: string
  /** dist-tag the runtime updater follows: latest | next | alpha. */
  channel?: string
}

/** Populated during startup, read by the shutdown path. */
interface Session {
  server: DshServer
  window: BrowserWindow
  tray?: Tray
  updater: RuntimeUpdater
  quitting: boolean
}

let session: Session | undefined

/**
 * The runtime this process is running on.
 *
 * Held module-level because two independent UI surfaces (the tray menu and the
 * application menu) both need to report it, and both are only ever reachable
 * after `main()` has assigned it.
 */
let activeRuntime: RuntimeLocation | undefined

// A second launch focuses the existing window instead of starting a second
// server (which would bind another port and duplicate the harness home).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = session?.window
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  void main()
}

/** Read (and cache) the app's own settings file. */
function readSettings(userDataDir: string): DesktopSettings {
  try {
    return JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as DesktopSettings
  } catch {
    return {}
  }
}

/** Merge keys into the settings file. */
function writeSettings(userDataDir: string, patch: DesktopSettings): void {
  const next = { ...readSettings(userDataDir), ...patch }
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(next, null, 2) + '\n')
}

/**
 * Decide which directory the agent treats as its workspace.
 *
 * Precedence: explicit CLI argument > remembered choice > home directory. The
 * dsh launcher treats the invoking directory as the default workspace root, so
 * mirroring that keeps behaviour familiar.
 * @param argv - `process.argv` of this launch.
 * @param userDataDir - Electron's per-user data directory.
 * @returns the absolute workspace path.
 */
function resolveWorkspace(argv: string[], userDataDir: string): string {
  const fromArgv = argv
    .slice(1)
    .find((token) => !token.startsWith('--') && !token.startsWith('-'))
  if (fromArgv !== undefined) {
    const absolute = resolve(fromArgv)
    if (existsSync(absolute)) {
      const target = statSync(absolute).isDirectory() ? absolute : dirname(absolute)
      writeSettings(userDataDir, { workspace: target })
      return target
    }
  }
  const remembered = readSettings(userDataDir).workspace
  if (remembered !== undefined && existsSync(remembered)) return remembered
  return homedir()
}

/** Launch, wire, and supervise the whole application. */
async function main(): Promise<void> {
  // Deliberately do NOT call app.setName(): it changes the userData directory, so
  // setting it here would split state between a development run (which Electron
  // names from package.json) and a packaged run (which it names from
  // productName). The window title and installer name carry the display name.
  //
  // The dark source also gives the (now visible) menu bar dark styling on Windows
  // so it does not read as a light strip above the dark web UI.
  nativeTheme.themeSource = 'dark'
  await app.whenReady()

  // Localization must be resolved after ready: the system locale is not available
  // before it. Every shell-owned string (menus, tray, dialogs) reads from here.
  const strings = initShellStrings()

  const userDataDir = process.env.DSH_DESKTOP_HOME ?? app.getPath('userData')
  const workspace = resolveWorkspace(process.argv, userDataDir)

  // A dedicated harness home keeps this app's sessions and credentials entirely
  // separate from a command-line `dsh` install, so the two can coexist.
  const dshHome = join(userDataDir, 'home')
  mkdirSync(dshHome, { recursive: true })

  const credentials = new CredentialStore(userDataDir)
  let runtime
  try {
    runtime = resolveRuntime(userDataDir)
  } catch (error) {
    dialog.showErrorBox(
      strings.startupFailedTitle,
      `${error instanceof Error ? error.message : String(error)}\n\n${strings.startupMissingRuntimeDetail}`,
    )
    app.exit(1)
    return
  }

  const runtimeVersion = RuntimeUpdater.readVersion(runtime.dir) ?? runtime.stagedVersion ?? 'unknown'
  activeRuntime = runtime
  process.env.DSH_DESKTOP_SHELL_VERSION = SHELL_VERSION
  process.env.DSH_DESKTOP_RUNTIME_VERSION = runtimeVersion

  const updater = new RuntimeUpdater({
    baseDir: join(userDataDir, 'runtime'),
    bundledDir: runtime.dir,
    currentVersion: runtimeVersion,
    ...(readSettings(userDataDir).channel !== undefined ? { channel: readSettings(userDataDir).channel } : {}),
  })

  const server = new DshServer({
    runtime,
    dshHome,
    workspace,
    // Decrypted secrets ride the launching environment, which outranks every
    // stored layer in dsh's credential precedence.
    env: credentials.read(),
  })

  // Server output is valuable when diagnosing a failed boot, so keep it visible
  // during development and in the log file rather than swallowing it.
  server.on('log', ({ stream, line }: { stream: 'stdout' | 'stderr'; line: string }) => {
    if (!app.isPackaged || stream === 'stderr') process[stream].write(`${line}\n`)
  })

  let ready
  try {
    ready = await server.start()
  } catch (error) {
    if (runtime.dir.startsWith(join(userDataDir, 'runtime'))) {
      // An updated runtime failed to boot: drop back to the bundled one rather
      // than leaving the user with an app that never opens.
      updater.rollback()
      dialog.showMessageBoxSync({
        type: 'warning',
        title: strings.rollbackTitle,
        message: strings.rollbackMessage,
        detail: error instanceof Error ? error.message : String(error),
        buttons: [strings.buttonOk],
      })
      app.relaunch()
      app.exit(0)
      return
    }
    dialog.showErrorBox(
      strings.startupFailedTitle,
      error instanceof Error ? error.message : String(error),
    )
    app.exit(1)
    return
  }

  const iconPath = resolveIconPath(runtime.packaged)
  const window = createMainWindow(ready, userDataDir, iconPath)

  const tray = createTray(iconPath, {
    show: () => {
      window.show()
      window.focus()
    },
    restartServer: () => {
      void restart(server, window)
    },
    checkForUpdates: () => {
      void checkForRuntimeUpdate(updater, window)
    },
    quit: () => {
      if (session !== undefined) session.quitting = true
      app.quit()
    },
  })

  installCloseToTray(window, () => tray !== undefined && session?.quitting !== true)
  window.on('closed', () => {
    // Closing the last window ends the app only when the tray is absent.
    if (tray === undefined) app.quit()
  })

  registerIpc(updater)
  buildApplicationMenu(window, updater, runtimeVersion)
  session = { server, window, ...(tray !== undefined ? { tray } : {}), updater, quitting: false }

  // The shell track: report a newer installer when one is published.
  if (app.isPackaged) void checkShellUpdate()

  app.on('before-quit', () => {
    if (session !== undefined) session.quitting = true
  })
  app.on('will-quit', () => {
    void server.stop()
  })
  // With a tray the app outlives its windows on purpose.
  app.on('window-all-closed', () => {
    if (session?.tray === undefined) app.quit()
  })
}

/**
 * Restart the agent runtime child process in place, keeping the window.
 * @param server - the running child.
 * @param window - the window to reload afterwards.
 */
async function restart(server: DshServer, window: BrowserWindow): Promise<void> {
  await server.stop()
  try {
    const ready = await server.start()
    await window.loadURL(ready.authenticatedUrl)
  } catch (error) {
    dialog.showErrorBox(t().restartFailedTitle, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Check the configured npm channel for a newer dsh and offer to install it.
 *
 * Reports the channel and the current runtime's on-disk location, because "up to
 * date" is only meaningful when the user can tell which channel was consulted and
 * which runtime is actually running.
 *
 * @param updater - the runtime updater.
 * @param window - the window used as the dialog parent.
 * @param runtime - the active runtime, for reporting where this build runs from.
 */
async function checkForRuntimeUpdate(
  updater: RuntimeUpdater,
  window: BrowserWindow,
  runtime: RuntimeLocation | undefined = activeRuntime,
): Promise<void> {
  if (runtime === undefined) return
  const s = t()
  let check
  let channel: string
  try {
    check = await updater.check()
    channel = updater.channel
  } catch (error) {
    dialog.showMessageBox(window, {
      type: 'error',
      message: s.updateCheckFailedTitle,
      detail: `${error instanceof Error ? error.message : String(error)}\n\n${s.updateCheckFailedDetail}`,
      buttons: [s.buttonOk],
    })
    return
  }

  const origin = runtime.dir.startsWith(join(app.getPath('userData'), 'runtime'))
    ? s.updateSourceDownloaded
    : s.updateSourceBundled

  if (!check.newer) {
    await dialog.showMessageBox(window, {
      type: 'info',
      message: s.updateUpToDateTitle,
      detail:
        `${s.updateInstalledLabel}:  ${check.current}\n` +
        `${s.updateNewestLabel} (${channel}):  ${check.latest.version}\n` +
        `${s.updateRuntimeSourceLabel}:  ${origin}\n` +
        `${s.updateLocationLabel}:  ${runtime.dir}\n` +
        `${s.updateRegistryLabel}:  ${check.latest.registry}`,
      buttons: [s.buttonOk],
    })
    return
  }

  const choice = dialog.showMessageBoxSync(window, {
    type: 'question',
    message: format(s.updateAvailableTitle, { version: check.latest.version }),
    detail:
      `${s.updateInstalledLabel}:  ${check.current}\n` +
      `${s.updateAvailableLabel}:  ${check.latest.version}\n` +
      `${s.updateChannelLabel}:  ${channel}\n` +
      `${s.updateRegistryLabel}:  ${check.latest.registry}\n\n` +
      s.updateAvailableDetail,
    buttons: [s.updateButtonInstall, s.updateButtonLater],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice !== 0) return

  const npmCli = locateNpmCli(process.resourcesPath)
  if (npmCli === undefined) {
    dialog.showMessageBox(window, {
      type: 'error',
      message: s.updateNoNpmTitle,
      detail: s.updateNoNpmDetail,
      buttons: [s.buttonOk],
    })
    return
  }

  const progress = new BrowserWindow({
    width: 460,
    height: 180,
    parent: window,
    modal: true,
    resizable: false,
    minimizable: false,
    title: s.updateProgressTitle,
    autoHideMenuBar: true,
  })
  await progress.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<body style="font:13px system-ui;padding:20px;background:#1b1b1f;color:#e8e8ea">' +
          `<h3 style="margin:0 0 8px">${s.updateProgressTitle}…</h3>` +
          `<div id="s" style="opacity:.75">${s.updateProgressStarting}</div></body>`,
      ),
  )

  try {
    const result = await updater.install(check.latest.version, check.latest.registry, npmCli, (line) => {
      void progress.webContents.executeJavaScript(
        `document.getElementById('s').textContent=${JSON.stringify(line)}`,
      )
    })
    progress.destroy()
    if (!result.updated) {
      dialog.showMessageBox(window, {
        type: 'error',
        message: s.updateFailedTitle,
        detail: result.reason ?? s.updateFailedUnknown,
        buttons: [s.buttonOk],
      })
      return
    }
    app.relaunch()
    app.exit(0)
  } catch (error) {
    progress.destroy()
    dialog.showMessageBox(window, {
      type: 'error',
      message: s.updateFailedTitle,
      detail: error instanceof Error ? error.message : String(error),
      buttons: [s.buttonOk],
    })
  }
}

/** Register the preload bridge's IPC handlers. */
function registerIpc(updater: RuntimeUpdater): void {
  ipcMain.handle('dsh-desktop:check-runtime-update', async () => {
    const check = await updater.check()
    return { current: check.current, latest: check.latest.version, newer: check.newer }
  })
  ipcMain.handle('dsh-desktop:open-external', async (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:/u.test(url)) await shell.openExternal(url)
  })
}

/** Application menu, reduced to what a desktop shell should own. */
function buildApplicationMenu(window: BrowserWindow, updater: RuntimeUpdater, runtimeVersion: string): void {
  const s = t()
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: s.menuFile,
      submenu: [
        { label: s.itemReload, role: 'reload' },
        { label: s.itemForceReload, role: 'forceReload' },
        { label: s.itemToggleDevTools, role: 'toggleDevTools' },
        { type: 'separator' },
        { label: s.itemQuit, role: 'quit' },
      ],
    },
    {
      label: s.menuEdit,
      submenu: [
        { label: s.itemUndo, role: 'undo' },
        { label: s.itemRedo, role: 'redo' },
        { type: 'separator' },
        { label: s.itemCut, role: 'cut' },
        { label: s.itemCopy, role: 'copy' },
        { label: s.itemPaste, role: 'paste' },
        { label: s.itemSelectAll, role: 'selectAll' },
      ],
    },
    {
      label: s.menuView,
      submenu: [
        { label: s.itemResetZoom, role: 'resetZoom' },
        { label: s.itemZoomIn, role: 'zoomIn' },
        { label: s.itemZoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: s.itemToggleFullScreen, role: 'togglefullscreen' },
      ],
    },
    {
      // Check-for-updates is deliberately first-class rather than buried: it is
      // the only way a user can act on a newer agent runtime.
      label: s.menuUpdate,
      submenu: [
        {
          label: s.itemCheckUpdates,
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => void checkForRuntimeUpdate(updater, window),
        },
        { type: 'separator' },
        { label: `${s.itemRuntimeVersion} ${runtimeVersion}`, enabled: false },
        { label: `${s.itemShellVersion} ${SHELL_VERSION}`, enabled: false },
      ],
    },
    {
      label: s.menuHelp,
      submenu: [
        {
          label: s.itemCheckUpdates,
          click: () => void checkForRuntimeUpdate(updater, window),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Best-effort shell self-update; never blocks startup. */
async function checkShellUpdate(): Promise<void> {
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.on('error', () => {
      /* offline or unsigned build: the runtime track still works */
    })
    await autoUpdater.checkForUpdatesAndNotify()
  } catch {
    // electron-updater is optional at runtime (e.g. an unpackaged dev run).
  }
}

/** Locate a window/tray icon inside dev and packaged layouts. */
function resolveIconPath(packaged: boolean): string | undefined {
  const candidates = packaged
    ? [join(process.resourcesPath, 'icon.png'), join(process.resourcesPath, 'build', 'icon.png')]
    : [resolve(__dirname, '..', '..', 'build', 'icon.png')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
