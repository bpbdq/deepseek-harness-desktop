/**
 * 信息面板窗口的 preload。
 *
 * 面板窗口开了 sandbox + contextIsolation，页面拿不到 ipcRenderer，因此这里把
 * 需要的两件事暴露成一个小 API：
 *   - `onPush(fn)`：订阅主进程推送的数据
 *   - `action(name)`：把按钮点击回传给主进程
 *
 * 频道名从 `additionalArguments` 读取（渲染进程无法自己拼），这样两个面板同时
 * 打开时各自只收到自己的数据——用环境变量做不到，那是进程级的。
 */
import { contextBridge, ipcRenderer } from 'electron'

/** 从命令行参数里取 `--name=value`。 */
function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  const found = process.argv.find((token) => token.startsWith(prefix))
  return found?.slice(prefix.length)
}

const pushChannel = argValue('panel-push') ?? ''
const actionChannel = argValue('panel-action') ?? ''

contextBridge.exposeInMainWorld('dshPanel', {
  /**
   * 订阅主进程推送。
   * @param listener - 收到 `{ channel, payload }` 时调用。
   */
  onPush: (listener: (message: { channel: string; payload: unknown }) => void): void => {
    if (pushChannel === '') return
    ipcRenderer.on(pushChannel, (_event, message) => listener(message as { channel: string; payload: unknown }))
  },
  /**
   * 把按钮动作回传主进程。
   * @param action - 按钮的 data-action 值。
   */
  action: (action: string): void => {
    if (actionChannel === '') return
    ipcRenderer.send(actionChannel, action)
  },
})
