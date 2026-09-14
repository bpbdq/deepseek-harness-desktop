/**
 * Preload bridge.
 *
 * The official Web UI needs nothing from us — it talks to the host over the
 * loopback HTTP/WebSocket surface. This bridge only exposes a tiny, explicitly
 * enumerable set of shell capabilities for future desktop affordances, and it is
 * loaded with `contextIsolation` on and Node integration off.
 */
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  /** Version of the Electron shell. */
  shellVersion: process.env.DSH_DESKTOP_SHELL_VERSION ?? '0.0.0',
  /** Version of the bundled dsh runtime serving this window. */
  runtimeVersion: process.env.DSH_DESKTOP_RUNTIME_VERSION ?? 'unknown',
  /** Ask the shell to check the runtime channel for a newer dsh. */
  checkForRuntimeUpdate: (): Promise<{ current: string; latest: string; newer: boolean }> =>
    ipcRenderer.invoke('dsh-desktop:check-runtime-update') as Promise<{
      current: string
      latest: string
      newer: boolean
    }>,
  /** Open an external URL in the system browser. */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('dsh-desktop:open-external', url) as Promise<void>,
}

contextBridge.exposeInMainWorld('dshDesktop', api)

export type DshDesktopApi = typeof api
