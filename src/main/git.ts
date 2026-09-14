/**
 * Git 状态探测（外壳侧）。
 *
 * 在指定工作区里读取当前分支与工作树状态，供菜单、标题栏与"项目信息"面板展示。
 *
 * 设计取舍：
 *   * 用 `execFile('git', …)` 而不是 shell —— 工作区路径可能含空格或特殊字符，
 *     走 shell 会引入转义问题。
 *   * **每个调用都有超时**。git 在超大仓库、网络盘或缺失凭据时会卡住；探测
 *     信息不值得拖住主进程。
 *   * 任何失败都返回 `isRepo: false` 而不是抛错 —— 没有 git、不是仓库、git
 *     未安装，都是正常状态而非错误。
 */
import { execFile } from 'node:child_process'

/** 一次 git 探测的结果。 */
export interface GitInfo {
  /** 工作区是否是 git 仓库。 */
  isRepo: boolean
  /** 当前分支名，或 `undefined`。游离 HEAD 时为短 SHA。 */
  branch?: string
  /** 相对于上游的领先/落后提交数（有上游时才有）。 */
  ahead?: number
  behind?: number
  /** 是否有未提交改动。 */
  dirty?: boolean
  /** 已跟踪文件的改动条数（来自 `status --porcelain`）。 */
  changedFiles?: number
  /** 本次探测失败的原因；`isRepo: false` 时可能有值。 */
  error?: string
}

/** git 探测的默认超时（毫秒）。 */
const GIT_TIMEOUT_MS = 5_000

/**
 * 运行一条 git 命令。
 * @param cwd - 在哪个目录里执行。
 * @param args - git 子命令与参数。
 * @returns 去掉首尾空白的 stdout，失败时返回 undefined。
 */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

/**
 * 读取一个工作区的 git 状态。
 *
 * 只做四条廉价命令，不做 `git log` 之类的重活：面板要秒开。
 * @param workspace - 工作区绝对路径。
 * @returns 探测结果；非仓库或 git 不可用时 `isRepo: false`。
 */
export async function readGitInfo(workspace: string): Promise<GitInfo> {
  // `rev-parse --is-inside-work-tree` 是判断"是否仓库"最便宜的方式。
  const inside = await git(workspace, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') {
    return {
      isRepo: false,
      ...(inside === undefined ? { error: 'git 不可用或该目录不是仓库' } : {}),
    }
  }

  // 分支名：优先符号引用名；游离 HEAD 时退化为短 SHA。
  const [symbolic, shortSha, status, tracking] = await Promise.all([
    git(workspace, ['symbolic-ref', '--short', 'HEAD']),
    git(workspace, ['rev-parse', '--short', 'HEAD']),
    git(workspace, ['status', '--porcelain']),
    git(workspace, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
  ])

  const info: GitInfo = { isRepo: true }

  const branch = symbolic ?? shortSha
  if (branch !== undefined && branch !== '') info.branch = branch

  if (status !== undefined) {
    const lines = status.split('\n').filter((line) => line.trim() !== '')
    info.dirty = lines.length > 0
    info.changedFiles = lines.length
  }

  // `rev-list --left-right --count HEAD...@{upstream}` 输出 "<ahead>\t<behind>"。
  if (tracking !== undefined) {
    const [aheadRaw, behindRaw] = tracking.split(/\s+/u)
    const ahead = Number.parseInt(aheadRaw ?? '', 10)
    const behind = Number.parseInt(behindRaw ?? '', 10)
    if (Number.isFinite(ahead)) info.ahead = ahead
    if (Number.isFinite(behind)) info.behind = behind
  }

  return info
}

/**
 * 把 git 状态压成一行短文本，用于标题栏。
 * @param info - 探测结果。
 * @param dirtyMark - 有未提交改动时追加的标记，如 `*`。
 * @returns 形如 `main* ↑2` 的文本；非仓库返回 undefined。
 */
export function formatGitBadge(info: GitInfo, dirtyMark: string): string | undefined {
  if (!info.isRepo || info.branch === undefined) return undefined
  const head = info.dirty === true ? `${info.branch}${dirtyMark}` : info.branch
  const tracking: string[] = []
  if (info.ahead !== undefined && info.ahead > 0) tracking.push(`↑${info.ahead}`)
  if (info.behind !== undefined && info.behind > 0) tracking.push(`↓${info.behind}`)
  return tracking.length > 0 ? `${head} ${tracking.join(' ')}` : head
}
