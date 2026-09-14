/**
 * 工作区（项目）管理。
 *
 * "工作区"就是智能体读写文件的根目录。它在服务端启动时作为 `--workspace` 传入，
 * 因此切换工作区意味着**重启服务端子进程**——这也决定了下面这些操作的实现方式：
 * 与其原地替换，不如记下选择后整体重启应用，让启动路径保持唯一（一条路径比两条
 * 好维护，也不会出现"半个进程还在用旧工作区"的状态）。
 *
 * 本模块只负责"选"与"记"，不负责重启。
 */
import { existsSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 最近打开列表的最大长度——够用即可，避免菜单过长。 */
const MAX_RECENT = 8

/** 落盘的工作区相关设置。 */
export interface WorkspaceSettings {
  /** 当前工作区。 */
  workspace?: string
  /** 最近打开过的目录，最新的在前。 */
  recent?: string[]
}

/**
 * 记录一次工作区选择：更新当前值并把它提到最近列表首位。
 * @param settings - 现有设置。
 * @param dir - 选中的目录绝对路径。
 * @returns 更新后的设置（不落盘，交给调用方）。
 */
export function rememberWorkspace(settings: WorkspaceSettings, dir: string): WorkspaceSettings {
  const existing = (settings.recent ?? []).filter((item) => item !== dir)
  return { ...settings, workspace: dir, recent: [dir, ...existing].slice(0, MAX_RECENT) }
}

/**
 * 让"最近打开"里只保留仍然存在的目录。
 *
 * 目录被删或被改名是常态，菜单里留一堆打不开的条目只会让人误点。
 * @param recent - 原始列表。
 * @returns 过滤后的列表。
 */
export function pruneRecent(recent: readonly string[] | undefined): string[] {
  return (recent ?? []).filter((dir) => {
    try {
      return existsSync(dir) && statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 判断一个路径是否是"真实目录"而非链接。
 *
 * 存在这个判断是因为 Windows 上 junction 与真实目录用 `statSync` 无法区分，
 * 而我们要避免把链接路径写进最近列表（链接目标被删除后会变成死条目）。
 * @param dir - 待检查的路径。
 * @returns 是否是可直接使用的工作区目录。
 */
export function isUsableWorkspace(dir: string): boolean {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false
    // readlinkSync 对普通目录抛错，对 junction/符号链接成功——用它区分两者。
    readlinkSync(dir)
    return true
  } catch {
    // 普通目录：readlink 失败，说明是真实目录。
    return true
  }
}

/**
 * 清理一个可能残留的加载页文件。
 *
 * 加载页是启动瞬态产物，退出后没有保留价值，也不该出现在数据目录里被误认为配置。
 * @param userDataDir - 应用数据目录。
 */
export function removeSplashFile(userDataDir: string): void {
  try {
    rmSync(join(userDataDir, 'splash.html'), { force: true })
  } catch {
    // 清理失败不影响任何功能。
  }
}

/**
 * 把命令行传入的路径规范成工作区。
 *
 * 传文件时取其所在目录——用户从"用…打开"里选中一个文件是常见操作，
 * 此时把文件所在目录当工作区比拒绝更符合预期。
 * @param candidate - 命令行传入的路径。
 * @returns 规范化后的绝对路径，或 undefined（路径无效）。
 */
export function normalizeWorkspaceArgument(candidate: string): string | undefined {
  const absolute = isAbsolute(candidate) ? candidate : resolve(candidate)
  if (!existsSync(absolute)) return undefined
  try {
    return statSync(absolute).isDirectory() ? absolute : resolve(absolute, '..')
  } catch {
    return undefined
  }
}

/**
 * 兜底工作区：用户主目录。
 *
 * 主目录一定存在，且是用户最可能想操作的范围；比硬编码 `C:\` 或当前目录更合理
 * （后者在安装后可能是系统目录）。
 * @returns 主目录绝对路径。
 */
export function fallbackWorkspace(): string {
  return homedir()
}

/**
 * 为菜单生成"最近打开"的显示文案。
 *
 * 只显示目录名，重名时补上父目录名，避免菜单里出现两个一模一样的条目
 * 而用户无从分辨。
 * @param dirs - 最近目录列表。
 * @returns 显示文案，与入参一一对应。
 */
export function recentLabels(dirs: readonly string[]): string[] {
  const names = dirs.map((dir) => resolve(dir).split(/[\\/]/u).filter(Boolean).pop() ?? dir)
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)

  return dirs.map((dir, index) => {
    const name = names[index] ?? dir
    if ((counts.get(name) ?? 0) <= 1) return name
    // 重名时用父目录 + 目录名消歧。
    const parts = resolve(dir).split(/[\\/]/u).filter(Boolean)
    const parent = parts[parts.length - 2] ?? ''
    return parent === '' ? dir : `${parent}/${name}`
  })
}
