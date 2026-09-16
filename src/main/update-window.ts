/**
 * 「更新」窗口：把两条更新轨道放在一处展示与操作。
 *
 * 两条轨道的性质不同，因此在同一个窗口里分节呈现而不是混成一句话：
 *
 *   智能体运行时（dsh）—— 迭代快（0.1.5-rc.1、rc.2…），从 npm registry 拉取，
 *                          装进本应用数据目录，**不需要重装应用**。
 *   应用外壳（本 Electron 应用）—— 迭代慢，从 GitHub Releases 拉安装包，
 *                          装完会替换应用本体。
 *
 * 为什么首屏秒开、数据后到：两条检查都要走网络（registry 与 GitHub），慢的时候
 * 十几秒。窗口应当立刻出现并显示"正在检查"，而不是等结果才弹出来。
 * 因此数据由主进程通过 IPC 推送，页面只负责渲染。
 */
import { BrowserWindow } from 'electron'
import { escapeHtml, openPanel, type PanelRow } from './panel'

/** 单条轨道的状态。 */
export interface TrackState {
  /** 已安装版本。 */
  installed: string
  /** 最新版本（已知时）。 */
  latest?: string
  /** 状态枚举。 */
  state: 'checking' | 'latest' | 'available' | 'unknown'
  /** `unknown` 时的原因。 */
  reason?: string
  /** 附加详情行。 */
  details?: PanelRow[]
  /**
   * 「已安装 / 最新」两行的标签覆盖。
   *
   * 两条轨道的"最新"含义不同：运行时看的是 npm 上的**通道**（latest/next/alpha），
   * 外壳看的是 GitHub 上的**已发布版本**。用同一个标签会让人误解为同一件事。
   */
  installedLabel?: string
  latestLabel?: string
}

/** 推送给页面的完整状态。 */
export interface UpdatePanelState {
  runtime: TrackState
  shell: TrackState
  /** 外壳更新是否可下载（可由页面按钮触发）。 */
  shellCanInstall: boolean
  /** 正在下载外壳更新的百分比（0-100），未在下载时为 undefined。 */
  shellProgress?: number
  /** 正在下载运行时更新的百分比（0-100），未在下载时为 undefined。 */
  runtimeProgress?: number
}

/** 面板文案与动作所需的字符串。 */
export interface UpdateWindowStrings {
  title: string
  checking: string
  sectionRuntime: string
  sectionShell: string
  stateLatest: string
  stateAvailable: string
  stateUnknown: string
  installedLabel: string
  latestLabel: string
  detailLabel: string
  buttonClose: string
  buttonRuntime: string
  buttonShell: string
  shellUnavailable: string
  shellProgress: string
  /** 按钮在下载中的文案，`{percent}` 会被替换成百分比。 */
  buttonDownloading: string
  shellFailedTitle: string
  /** 运行时轨道专用：「该通道最新版本」。 */
  runtimeLatestLabel: string
  /** 外壳轨道专用：「最新已发布版本」。 */
  shellLatestLabel: string
}

const STATE_TEXT: Record<TrackState['state'], keyof UpdateWindowStrings> = {
  checking: 'checking',
  latest: 'stateLatest',
  available: 'stateAvailable',
  unknown: 'stateUnknown',
}

/** 渲染一条轨道为 HTML。 */
function trackHtml(id: 'runtime' | 'shell', sectionTitle: string, strings: UpdateWindowStrings): string {
  return `
  <section class="track" id="track-${id}">
    <div class="track-head">
      <span class="track-title">${escapeHtml(sectionTitle)}</span>
      <span class="status" id="${id}-status">${escapeHtml(strings.checking)}</span>
    </div>
    <div class="row"><div class="label" id="${id}-installed-label">${escapeHtml(strings.installedLabel)}</div>
      <div class="value" id="${id}-installed">—</div></div>
    <div class="row"><div class="label" id="${id}-latest-label">${escapeHtml(strings.latestLabel)}</div>
      <div class="value" id="${id}-latest">—</div></div>
    <div id="${id}-details"></div>
    <div class="note" id="${id}-note" hidden></div>
  </section>`
}

/**
 * 打开更新窗口。
 *
 * @param parent - 父窗口。
 * @param userDataDir - 写入临时 HTML 的位置。
 * @param strings - 文案。
 * @param onAction - 按钮动作回调（`update-runtime-shell` 等）。
 * @returns 窗口与状态推送方法。
 */
export function openUpdateWindow(
  parent: BrowserWindow,
  userDataDir: string,
  strings: UpdateWindowStrings,
  onAction: (action: string) => void,
): { window: BrowserWindow; update: (state: UpdatePanelState) => void } {
  const body = `
  <div id="progress-wrap" hidden>
    <div class="progress"><div class="progress-bar" id="progress-bar"></div></div>
    <div class="progress-text" id="progress-text"></div>
  </div>
  ${trackHtml('runtime', strings.sectionRuntime, strings)}
  ${trackHtml('shell', strings.sectionShell, strings)}`

  const footer = `
  <footer>
    <button data-action="close" id="btn-close">${escapeHtml(strings.buttonClose)}</button>
    <button class="primary" data-action="update-runtime" id="btn-runtime" hidden>${escapeHtml(strings.buttonRuntime)}</button>
    <button class="primary" data-action="update-shell" id="btn-shell" hidden>${escapeHtml(strings.buttonShell)}</button>
  </footer>`

  const script = `
    const stateText = {
      checking: ${JSON.stringify(strings.checking)},
      latest: ${JSON.stringify(strings.stateLatest)},
      available: ${JSON.stringify(strings.stateAvailable)},
      unknown: ${JSON.stringify(strings.stateUnknown)},
    };
    const strings = ${JSON.stringify({
      shellUnavailable: strings.shellUnavailable,
      shellProgress: strings.shellProgress,
      buttonDownloading: strings.buttonDownloading,
      buttonRuntime: strings.buttonRuntime,
      buttonShell: strings.buttonShell,
      installedLabel: strings.installedLabel,
      latestLabel: strings.latestLabel,
      detailLabel: strings.detailLabel,
    })};

    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    function renderTrack(id, track) {
      setText(id + '-status', stateText[track.state] || track.state);
      setText(id + '-installed', track.installed || '—');
      setText(id + '-latest', track.latest || '—');
      // 轨道可以覆盖这两个标签（运行时的"最新"指通道，外壳指已发布版本）。
      setText(id + '-installed-label', track.installedLabel || strings.installedLabel);
      setText(id + '-latest-label', track.latestLabel || strings.latestLabel);
      const details = document.getElementById(id + '-details');
      details.innerHTML = (track.details || []).map((row) =>
        '<div class="row"><div class="label">' + row.label + '</div><div class="value">' + row.value + '</div></div>'
      ).join('');
      const note = document.getElementById(id + '-note');
      if (track.reason) { note.hidden = false; note.textContent = track.reason; }
      else { note.hidden = true; note.textContent = ''; }
      const status = document.getElementById(id + '-status');
      status.className = 'status ' + track.state;
    }

    window.__panelReady(() => {});
    window.dshPanel.onPush(({ channel, payload }) => {
      if (channel !== 'state') return;
      // 留一份最近的状态，便于用 CDP 排查"页面没渲染出预期内容"这类问题。
      window.__lastState = payload;
      renderTrack('runtime', payload.runtime);
      renderTrack('shell', payload.shell);

      const runtimeButton = document.getElementById('btn-runtime');
      runtimeButton.hidden = payload.runtime.state !== 'available';

      const shellButton = document.getElementById('btn-shell');
      shellButton.hidden = !(payload.shell.state === 'available' && payload.shellCanInstall);

      // 下载进度直接写在按钮上。
      //
      // 进度条在窗口顶部、按钮在底部，窗口一长两者就不同屏——用户点了"下载"之后，
      // 视线还在按钮上，看不到顶部的进度条，于是**以为没反应**（这是实际反馈的问题）。
      // 因此按钮自身也要表达状态：下载中显示百分比并禁用。
      if (payload.shellProgress !== undefined) {
        shellButton.textContent = strings.buttonDownloading.replace('{percent}', String(payload.shellProgress));
        shellButton.disabled = true;
      } else {
        shellButton.textContent = strings.buttonShell;
        shellButton.disabled = false;
      }
      if (payload.runtimeProgress !== undefined) {
        runtimeButton.textContent = strings.buttonDownloading.replace('{percent}', String(payload.runtimeProgress));
        runtimeButton.disabled = true;
      } else {
        runtimeButton.textContent = strings.buttonRuntime;
        runtimeButton.disabled = false;
      }

      // 进度条：任一条轨道在下载时都展示（原来只认外壳那条，运行时更新时顶部没有反馈）。
      //
      // 顺序要求：这一段必须在 shellNote 之前。因为页面脚本是模板字符串拼出来的，
      // 这里的注释不能使用反引号（会提前闭合模板），也避免用含反引号的词。
      const percent = payload.shellProgress ?? payload.runtimeProgress;
      const wrap = document.getElementById('progress-wrap');
      if (percent === undefined) {
        wrap.hidden = true;
      } else {
        wrap.hidden = false;
        document.getElementById('progress-bar').style.width = percent + '%';
        document.getElementById('progress-text').textContent =
          strings.shellProgress.replace('{percent}', String(percent));
      }

      const shellNote = document.getElementById('shell-note');
      // 注意顺序：renderTrack 已经把真实原因（例如"未打包运行"）写进 note 了，
      // 这里只能在没有原因时补一句通用提示，**不能无条件覆盖**。
      // 踩过一次：原先无论是否有原因都重写 note，结果真实原因被冲掉，用户只看到
      // 状态是"无法检查"却不知道原因，看起来就像个 bug。
      const hasReason = Boolean(payload.shell.reason);
      if (payload.shell.state === 'available' && !payload.shellCanInstall && !hasReason) {
        shellNote.hidden = false;
        shellNote.textContent = strings.shellUnavailable;
      } else if (!hasReason) {
        shellNote.hidden = true;
        shellNote.textContent = '';
      }

    });`

  const css = `
  .track { margin-top: 16px; padding-top: 12px; border-top: 1px solid #2a2a30; }
  .track:first-of-type { border-top: none; margin-top: 4px; padding-top: 0; }
  .track-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
  .track-title { font-weight: 600; font-size: 13px; }
  .status { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #3a3a40; color: #b9b9c0; }
  .status.latest { background: #24402c; color: #a7e0b8; }
  .status.available { background: #2d4a7c; color: #cfe0ff; }
  .status.unknown { background: #4a3030; color: #e6b0b0; }
  .note { margin-top: 6px; color: #8a8a93; font-size: 12px; }
  #progress-wrap { margin: 10px 0 4px; }
  .progress { height: 6px; border-radius: 3px; background: #2a2a30; overflow: hidden; }
  .progress-bar { height: 100%; width: 0; background: #4d8dff; transition: width .2s ease; }
  .progress-text { margin-top: 4px; color: #8a8a93; font-size: 12px; }`

  const panel = openPanel(
    parent,
    userDataDir,
    {
      id: 'update',
      title: strings.title,
      rows: [],
      close: strings.buttonClose,
      body,
      footer,
      script,
      css,
      width: 560,
      // 高度给足，避免底部的操作按钮被截在可视区之外（此前 470 就是这个问题：用户
      // 看不到"下载"按钮，自然也无从点击）。openPanel 已把窗口设为可调整大小。
      height: 720,
    },
    onAction,
  )

  // 检查可能在页面订阅 IPC 前完成；保留最新状态，加载（或重新加载）后再补发。
  let loaded = false
  let latestState: UpdatePanelState | undefined
  panel.window.webContents.on('did-start-loading', () => {
    loaded = false
  })
  panel.window.webContents.on('did-finish-load', () => {
    loaded = true
    if (latestState !== undefined) panel.push('state', latestState)
  })

  return {
    window: panel.window,
    update: (state: UpdatePanelState): void => {
      latestState = state
      if (loaded) panel.push('state', state)
    },
  }
}
