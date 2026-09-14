/**
 * 「项目信息」窗口。
 *
 * 用共享的 panel 组件（`./panel`）承载，因此转义、窗口生命周期与 IPC 细节都只有
 * 一份实现。这个窗口只是只读展示，不需要预加载的 action 能力，但复用它比再写一遍
 * 转义与窗口参数更稳妥。
 *
 * git 数据通过主进程推送（`openPanel().push`）而不是让页面自己轮询文件：轮询要
 * 处理"文件还没写好"的竞态，推送则天然有序。
 */
import { BrowserWindow } from 'electron'
import type { GitInfo } from './git'
import { escapeHtml, openPanel, renderRows, type PanelRow } from './panel'

/** 面板文案。 */
export interface InfoStrings {
  title: string
  close: string
  notARepo: string
  dirty: string
  clean: string
}

/**
 * 打开项目信息窗口。
 *
 * @param parent - 父窗口。
 * @param userDataDir - 写入临时 HTML 的位置。
 * @param rows - 静态信息行（工作区、版本、路径等）。
 * @param strings - 文案。
 * @returns 窗口与推送 git 状态的方法。
 */
export function showProjectInfo(
  parent: BrowserWindow,
  userDataDir: string,
  rows: readonly PanelRow[],
  strings: InfoStrings,
): { window: BrowserWindow; publishGit: (git: GitInfo) => void } {
  const body = `
  <div class="top"><span class="badge off" id="git-badge">${escapeHtml(strings.notARepo)}</span>
    <span class="flags" id="git-flags"></span></div>
  ${renderRows(rows)}`

  const script = `
    const strings = ${JSON.stringify(strings)};
    const badge = document.getElementById('git-badge');
    const flags = document.getElementById('git-flags');
    const arrowUp = '\\u2191';
    const arrowDown = '\\u2193';
    const dot = ' \\u00b7 ';

    function render(git) {
      if (!git || !git.isRepo || !git.branch) {
        badge.className = 'badge off';
        badge.textContent = strings.notARepo;
        flags.textContent = '';
        return;
      }
      badge.className = 'badge on';
      badge.textContent = git.branch;
      const parts = [];
      parts.push(git.dirty ? strings.dirty + (git.changedFiles || 0) : strings.clean);
      if (git.ahead > 0) parts.push(arrowUp + git.ahead);
      if (git.behind > 0) parts.push(arrowDown + git.behind);
      flags.textContent = parts.join(dot);
    }

    window.__panelReady(() => {});
    window.dshPanel.onPush(({ channel, payload }) => {
      if (channel === 'git') render(payload.git);
    });`

  const css = `
  .top { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; min-height: 22px; }
  .badge {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 12px; padding: 3px 9px; border-radius: 5px;
  }
  .badge.on { background: #2d4a7c; color: #cfe0ff; }
  .badge.off { background: #3a3a40; color: #9a9aa2; }
  .flags { font-size: 12px; color: #9a9aa2; }`

  const panel = openPanel(
    parent,
    userDataDir,
    {
      id: 'project-info',
      title: strings.title,
      rows: [...rows],
      close: strings.close,
      body,
      script,
      css,
      width: 580,
      height: 440,
    },
    // 只读面板没有动作按钮，收到任何 action 都忽略。
    () => {},
  )

  return { window: panel.window, publishGit: (git: GitInfo): void => panel.push('git', { git }) }
}
