/**
 * Tray icon and menu.
 *
 * The tray is not decoration: it is what lets long-running work survive a closed
 * window. Goals, ralph loops, background jobs, and spawned subagents all live in
 * the server child process, so hiding to tray keeps them running where closing a
 * browser tab would not.
 */
import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { t } from './i18n'

/** Actions the tray needs from the application shell. */
export interface TrayActions {
  show: () => void
  restartServer: () => void
  checkForUpdates: () => void
  quit: () => void
}

/**
 * Create the tray icon.
 * @param iconPath - absolute path of a PNG/ICO icon, when one exists.
 * @param actions - callbacks wired into the menu.
 * @returns the tray, or undefined when no icon is available.
 */
export function createTray(iconPath: string | undefined, actions: TrayActions): Tray | undefined {
  if (iconPath === undefined) return undefined
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return undefined

  const strings = t()
  const tray = new Tray(image.resize({ width: 16, height: 16 }))
  tray.setToolTip(strings.trayTooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: strings.trayShow, click: actions.show },
      { type: 'separator' },
      { label: strings.trayRestart, click: actions.restartServer },
      { label: strings.trayCheckUpdates, click: actions.checkForUpdates },
      { type: 'separator' },
      { label: strings.trayQuit, click: actions.quit },
    ]),
  )
  tray.on('click', actions.show)
  tray.on('double-click', actions.show)
  return tray
}

/**
 * Wire "close hides to tray" behaviour.
 * @param window - the main window.
 * @param shouldHide - returns whether closing should hide instead of quit.
 */
export function installCloseToTray(window: BrowserWindow, shouldHide: () => boolean): void {
  window.on('close', (event) => {
    if (!shouldHide()) return
    event.preventDefault()
    window.hide()
  })
}
