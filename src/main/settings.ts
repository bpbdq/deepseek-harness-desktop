/**
 * 应用自身的设置文件（`<userData>/settings.json`）。
 *
 * 与 Harness 自己的配置分开：这里是**外壳**的偏好（当前工作区、最近打开列表、
 * 更新通道）。Harness 的设置由 dsh 自己管理，两者互不干涉。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pruneRecent, rememberWorkspace } from './workspace'

/** 落盘的外壳设置。 */
export interface DesktopSettings {
  /** 当前工作区（智能体读写的根目录）。 */
  workspace?: string
  /** 最近打开过的项目目录，最新的在前。 */
  recent?: string[]
  /** 运行时更新跟随的 dist-tag：latest | next | alpha。 */
  channel?: string
}

const FILENAME = 'settings.json'

/**
 * 读取设置。
 *
 * 读取时顺手过滤掉已不存在的最近目录：目录被删或被改名是常态，
 * 菜单里留着打不开的条目只会让人误点。
 * @param userDataDir - 应用数据目录。
 * @returns 设置；文件缺失或损坏时返回空对象而不是抛错。
 */
export function readSettings(userDataDir: string): DesktopSettings {
  try {
    const parsed = JSON.parse(readFileSync(join(userDataDir, FILENAME), 'utf8')) as DesktopSettings
    return { ...parsed, recent: pruneRecent(parsed.recent) }
  } catch {
    return {}
  }
}

/**
 * 合并写入设置。
 * @param userDataDir - 应用数据目录。
 * @param patch - 要合并进去的字段。
 */
export function writeSettings(userDataDir: string, patch: DesktopSettings): void {
  const next = { ...readSettings(userDataDir), ...patch }
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, FILENAME), JSON.stringify(next, null, 2) + '\n')
}

/**
 * 记录一次工作区切换：设为当前并提到最近列表首位。
 * @param userDataDir - 应用数据目录。
 * @param dir - 选中的目录绝对路径。
 * @returns 写入后的设置。
 */
export function switchWorkspace(userDataDir: string, dir: string): DesktopSettings {
  const next = rememberWorkspace(readSettings(userDataDir), dir)
  writeSettings(userDataDir, next)
  return next
}
