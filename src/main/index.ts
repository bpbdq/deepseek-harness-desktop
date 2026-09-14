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
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BrowserWindow, Menu, Tray, app, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'

import { CredentialStore } from './credentials'
import { DshServer } from './dsh-server'
import { formatGitBadge, readGitInfo } from './git'
import { format, initShellStrings, t } from './i18n'
import { healModuleFallback } from './module-heal'
import { resolveRuntime } from './paths'
import type { RuntimeLocation } from './paths'
import { showProjectInfo, type InfoRow } from './project-info'
import { readSettings, switchWorkspace } from './settings'
import { installCloseToTray, createTray } from './tray'
import { RuntimeUpdater, locateNpmCli } from './updater'
import { createMainWindow } from './window'
import { fallbackWorkspace, normalizeWorkspaceArgument, recentLabels, removeSplashFile } from './workspace'

const SHELL_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string })
      .version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

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

/**
 * 决定智能体把哪个目录当作工作区。
 *
 * 优先级：命令行显式参数 > 上次记住的选择 > 用户主目录。dsh 的启动器把"调用时
 * 所在目录"当作默认工作区根，这里保持同样的直觉。
 * @param argv - 本次启动的 `process.argv`。
 * @param userDataDir - Electron 的每用户数据目录。
 * @returns 工作区绝对路径。
 */
function resolveWorkspace(argv: string[], userDataDir: string): string {
  const fromArgv = argv.slice(1).find((token) => !token.startsWith('--') && !token.startsWith('-'))
  if (fromArgv !== undefined) {
    const normalized = normalizeWorkspaceArgument(fromArgv)
    if (normalized !== undefined) {
      // 走 switchWorkspace 而不是只写 workspace：命令行打开一个目录同样应当
      // 进入"最近打开"列表。
      switchWorkspace(userDataDir, normalized)
      return normalized
    }
  }
  const remembered = readSettings(userDataDir).workspace
  if (remembered !== undefined && existsSync(remembered)) return remembered
  return fallbackWorkspace()
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

  // Repair module-fallback links before boot. If the install directory ever moved,
  // dsh's own staleness check compares link *target strings*, so a dangling link can
  // still look current — which surfaces as "Cannot find package '@deepseek-ai/…'"
  // for every profile package. Checked on every start; a healthy home is a read-only
  // scan, and the directory holds no user data (dsh rebuilds it).
  const healed = healModuleFallback(dshHome)
  if (healed.cleaned) {
    process.stderr.write(
      `[dsh-desktop] 修复了 ${healed.brokenLinks}/${healed.checkedLinks} 个失效的模块链接，` +
        'dsh 将在本次启动时重建。\n',
    )
  } else if (healed.brokenLinks > 0) {
    process.stderr.write(
      `[dsh-desktop] 警告: 发现 ${healed.brokenLinks} 个失效模块链接但无法清理，启动可能失败。\n`,
    )
  }

  // Server output is valuable when diagnosing a failed boot, so keep it visible
  // during development and in the log file rather than swallowing it.
  server.on('log', ({ stream, line }: { stream: 'stdout' | 'stderr'; line: string }) => {
    if (!app.isPackaged || stream === 'stderr') process[stream].write(`${line}\n`)
  })

  // Git status of the workspace: shown in the title bar and the Project Info
  // panel. Read before the window so the title carries the branch from the start.
  const gitInfo = await readGitInfo(workspace)
  const gitBadge = formatGitBadge(gitInfo, '*')

  // Create and show the window BEFORE waiting for the server.
  //
  // The dsh plugin tree takes ~10.7s to boot, which is ~95% of startup. Creating the
  // window only after `server.start()` resolved meant the user stared at nothing for
  // that whole time. Now the window (with a splash page) is up almost immediately and
  // is navigated to the UI when the server announces its URL.
  const iconPath = resolveIconPath(runtime.packaged)
  const main = createMainWindow({
    userDataDir,
    ...(iconPath !== undefined ? { iconPath } : {}),
    ...(gitBadge !== undefined ? { gitBadge } : {}),
    splashTitle: strings.splashTitle,
    splashHint: strings.splashHint,
  })
  const window = main.window

  // 纯菜单诊断：菜单不依赖服务端，而启动服务端要 ~11 秒。以
  // DSH_DESKTOP_DUMP_MENU=1 启动时，构建完菜单就直接退出，让菜单可以被脚本
  // 快速断言，而不是每次等十几秒。
  if (process.env.DSH_DESKTOP_DUMP_MENU === '1') {
    buildApplicationMenu(
      window,
      updater,
      runtimeVersion,
      () => {},
      createWorkspaceActions({ window, workspace, userDataDir, server, strings }),
    )
    app.exit(0)
    return
  }

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
    main.close()
    dialog.showErrorBox(
      strings.startupFailedTitle,
      error instanceof Error ? error.message : String(error),
    )
    app.exit(1)
    return
  }

  // Hand the already-visible window over to the real UI.
  await main.navigate(ready)

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
    projectInfo: () => {
      showProjectInfoFor(window, workspace, dshHome, userDataDir, runtime, runtimeVersion, strings)
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
  buildApplicationMenu(
    window,
    updater,
    runtimeVersion,
    () => {
      showProjectInfoFor(window, workspace, dshHome, userDataDir, runtime, runtimeVersion, strings)
    },
    createWorkspaceActions({ window, workspace, userDataDir, server, strings }),
  )
  session = { server, window, ...(tray !== undefined ? { tray } : {}), updater, quitting: false }

  // The shell track: report a newer installer when one is published.
  if (app.isPackaged) void checkShellUpdate()

  app.on('before-quit', () => {
    if (session !== undefined) session.quitting = true
  })
  app.on('will-quit', () => {
    removeSplashFile(userDataDir)
    void server.stop()
  })
  // With a tray the app outlives its windows on purpose.
  app.on('window-all-closed', () => {
    if (session?.tray === undefined) app.quit()
  })
}

/**
 * 构造文件菜单里工作区相关动作的实现。
 *
 * 关键取舍：切换工作区**重启整个应用**，而不是原地换掉子进程的 `--workspace`。
 * 原因：
 *   * 工作区是在服务端启动时传入的，中途更换意味着要重建整棵插件树（约 11 秒），
 *     而重启走的是同一条已验证的启动路径，出问题的面更小；
 *   * 只有一条启动路径，不存在"半个进程还在用旧工作区"的中间态；
 *   * 会话已持久化，重启后可继续。
 *
 * @param deps - 需要的窗口、当前工作区、数据目录、服务端与文案。
 * @returns 菜单动作集合。
 */
function createWorkspaceActions(deps: {
  window: BrowserWindow
  workspace: string
  userDataDir: string
  server: DshServer
  strings: ReturnType<typeof t>
}): WorkspaceActions {
  const { window, workspace, userDataDir, server, strings } = deps
  const s = strings

  /** 记录并重启到新的工作区。 */
  const applyWorkspace = (dir: string): void => {
    switchWorkspace(userDataDir, dir)
    if (session !== undefined) session.quitting = true
    // 先停子进程再重启，避免重启瞬间两个服务端争用同一个 harness home。
    void server.stop(2000).finally(() => {
      app.relaunch()
      app.exit(0)
    })
  }

  const recent = recentLabels(readSettings(userDataDir).recent ?? [])

  return {
    recent: recent.map((label, index) => ({
      label,
      path: (readSettings(userDataDir).recent ?? [])[index] ?? '',
    })),
    openFolder: (): void => {
      const picked = dialog.showOpenDialogSync(window, {
        title: s.dialogOpenFolderTitle,
        buttonLabel: s.dialogOpenFolderButton,
        properties: ['openDirectory', 'createDirectory'],
      })
      const dir = picked?.[0]
      if (dir === undefined) return

      // 明确告知会重启，而不是默默把界面刷掉——重启是这里唯一可感知的副作用。
      const confirmation = dialog.showMessageBoxSync(window, {
        type: 'question',
        title: s.switchWorkspaceTitle,
        message: s.switchWorkspaceMessage,
        detail: `${dir}\n\n${s.switchWorkspaceDetail}`,
        buttons: [s.switchWorkspaceConfirm, s.switchWorkspaceCancel],
        defaultId: 0,
        cancelId: 1,
      })
      if (confirmation !== 0) return
      applyWorkspace(dir)
    },
    openRecent: (dir: string): void => {
      if (dir === '' || dir === workspace) return
      applyWorkspace(dir)
    },
    revealWorkspace: (): void => {
      void shell.openPath(workspace)
    },
    copyWorkspacePath: (): void => {
      clipboard.writeText(workspace)
      dialog.showMessageBox(window, {
        type: 'info',
        message: s.copiedPathTitle,
        detail: `${workspace}\n\n${s.copiedPathMessage}`,
        buttons: [s.buttonOk],
      })
    },
  }
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
 * 打开「项目信息」面板，并在 git 探测返回后把数据推给面板。
 *
 * 面板先渲染、数据后到：git 探测要走子进程，阻塞在菜单点击上会让界面发顿。
 * @param parent - 父窗口。
 * @param workspace - 工作区路径。
 * @param dshHome - Harness 主目录。
 * @param userDataDir - 应用数据目录。
 * @param runtime - 当前运行时位置。
 * @param runtimeVersion - 当前运行时版本。
 * @param strings - 已解析的本地化文案。
 */
function showProjectInfoFor(
  parent: BrowserWindow,
  workspace: string,
  dshHome: string,
  userDataDir: string,
  runtime: RuntimeLocation,
  runtimeVersion: string,
  strings: ReturnType<typeof t>,
): void {
  const rows: InfoRow[] = [
    { label: strings.projectWorkspace, value: workspace, hint: strings.projectWorkspaceHint },
    { label: strings.projectRuntimeVersion, value: runtimeVersion },
    {
      label: strings.projectRuntimeSource,
      value: runtime.dir.startsWith(join(userDataDir, 'runtime'))
        ? strings.projectRuntimeDownloaded
        : strings.projectRuntimeBundled,
    },
    { label: strings.projectNode, value: runtime.nodeVersion ?? process.version },
    { label: strings.projectElectron, value: process.versions.electron ?? '—' },
    { label: strings.projectHarnessHome, value: dshHome, hint: strings.projectHarnessHomeHint },
    { label: strings.projectUserData, value: userDataDir },
  ]

  const info = showProjectInfo(parent, userDataDir, strings.projectInfoTitle, rows, {
    title: strings.projectInfoTitle,
    close: strings.projectClose,
    notARepo: strings.projectGitNotARepo,
    dirty: strings.projectGitDirty,
    clean: strings.projectGitClean,
    detached: strings.projectGitDetached,
  })

  void readGitInfo(workspace).then(
    (git) => info.publish(git),
    () => info.publish({ isRepo: false }),
  )
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

/** 文件菜单里与工作区（项目）相关的动作。 */
export interface WorkspaceActions {  /** 弹出目录选择器，切换工作区。 */
  openFolder: () => void
  /** 切到某个最近打开过的目录。 */
  openRecent: (dir: string) => void
  /** 在系统文件管理器中打开当前工作区。 */
  revealWorkspace: () => void
  /** 复制当前工作区路径到剪贴板。 */
  copyWorkspacePath: () => void
  /** 菜单里"最近打开"的条目（已解析为可显示文案）。 */
  recent: Array<{ label: string; path: string }>
}

/** Application menu, reduced to what a desktop shell should own. */
function buildApplicationMenu(
  window: BrowserWindow,
  updater: RuntimeUpdater,
  runtimeVersion: string,
  openProjectInfo: () => void,
  workspaceActions: WorkspaceActions,
): void {
  const s = t()
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: s.menuFile,
      submenu: [
        { label: s.itemOpenFolder, accelerator: 'CmdOrCtrl+O', click: workspaceActions.openFolder },
        {
          label: s.itemOpenRecent,
          submenu:
            workspaceActions.recent.length === 0
              ? [{ label: s.itemNoRecent, enabled: false }]
              : workspaceActions.recent.map((entry) => ({
                  label: entry.label,
                  toolTip: entry.path,
                  click: () => workspaceActions.openRecent(entry.path),
                })),
        },
        { type: 'separator' },
        { label: s.itemProjectInfo, accelerator: 'CmdOrCtrl+I', click: openProjectInfo },
        {
          label: s.itemRevealWorkspace,
          click: workspaceActions.revealWorkspace,
        },
        { label: s.itemCopyWorkspacePath, click: workspaceActions.copyWorkspacePath },
        { type: 'separator' },
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

  // 诊断开关：DSH_DESKTOP_DUMP_MENU=1 时把菜单结构打到 stderr。
  //
  // 存在的理由：菜单在主进程里，渲染进程的 CDP 读不到；而没有可读的输出，
  // "菜单改对了吗"就只能靠人肉截图去猜。有了它，菜单结构可以被脚本断言。
  if (process.env.DSH_DESKTOP_DUMP_MENU === '1') {
    const dump = (items: Electron.MenuItemConstructorOptions[], indent = ''): string =>
      items
        .map((item) => {
          const label = item.label ?? (item.role === undefined ? '(分隔)' : `role=${item.role}`)
          const accel = item.accelerator === undefined ? '' : `  [${item.accelerator}]`
          const disabled = item.enabled === false ? '  (禁用)' : ''
          const head = `${indent}${label}${accel}${disabled}`
          const children = Array.isArray(item.submenu)
            ? '\n' + dump(item.submenu as Electron.MenuItemConstructorOptions[], `${indent}    `)
            : ''
          return head + children
        })
        .join('\n')
    process.stderr.write(`[menu]\n${dump(template)}\n[/menu]\n`)
  }
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
