// review 的 host 半边：为「每轮修改审查」提供快照与差异。
//
// 核心思路：复用 git 自己的对象库做快照，而不是自己遍历文件算哈希。
// 做法是给 git 指定一个**临时 index 文件**（`GIT_INDEX_FILE`）：
//
//     read-tree HEAD     从 HEAD 初始化临时 index
//     add -A             把工作区当前状态（含未跟踪文件）写进去
//     write-tree          得到一个树对象 SHA
//
// 这样完全不碰用户真实的 index、stash 列表与 HEAD——**只读**是硬要求，用户的工作区
// 状态不能因为"看了一眼审查"而变化。实测确认过：status 与 stash 列表均不受影响。
//
// 为什么需要它：审查的基线是本轮开始时的状态，而用户常常在改到一半时才开始一轮任务，
// 因此基线必须能覆盖未跟踪文件，也必须廉价（大仓库遍历一遍很慢，而 git 会复用已有对象、
// 只对变化的文件重新哈希）。
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** 插件名，用于诊断与 effect 标签。 */
export const name = 'review'

/** 必须先有 webServer 服务，路由才有地方注册。 */
export const inject = ['webServer']

/** 路由前缀，与 gitbar 的做法一致，便于分辨"这是外壳侧插件提供的"。 */
const ROUTE_PREFIX = '/dsh-desktop/review'

/** git 命令超时。快照要遍历工作区，大仓库可能偏慢，故比 gitbar 宽松。 */
const GIT_TIMEOUT_MS = 30000

/** 单个响应的差异文本上限，避免超大改动把面板压垮。 */
const MAX_DIFF_BYTES = 512 * 1024

/** 树对象 SHA 格式：40 位十六进制。用于校验客户端传来的基线。 */
const REVISION_PATTERN = /^[0-9a-f]{40}$/u

/** 每个会话的基线状态。 */
const baselines = new Map()

/** 临时 index 的存放根目录（随进程生命周期，进程退出即失效）。 */
let scratchRoot

/**
 * 解析外壳允许被操作的工作区集合。
 *
 * 与 gitbar 同样的安全边界：只接受应用登记过的工作区，否则任何能访问本机回环地址的
 * 页面都能让宿主进程对任意目录执行 git 命令。
 * @returns 允许的绝对路径数组。
 */
function collectAllowedRoots() {
  const roots = new Set()
  const shell = process.env.DSH_DESKTOP_WORKSPACE
  if (typeof shell === 'string' && shell !== '') roots.add(shell)

  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    try {
      const parsed = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
      const table = parsed?.tables?.workspaces
      if (table !== null && typeof table === 'object') {
        for (const record of Object.values(table)) {
          const root = record?.root ?? record?.path
          if (typeof root === 'string' && root !== '') roots.add(root)
        }
      }
    } catch {
      // 文件不存在或结构变化——只用外壳工作区即可。
    }
  }
  return [...roots]
}

/**
 * 校验请求里的工作区。
 * @param requested - 请求给出的路径。
 * @returns 通过校验的真实路径，否则 undefined。
 */
function validateWorkspace(requested) {
  if (typeof requested !== 'string' || requested === '' || !isAbsolute(requested)) return undefined
  let real
  try {
    real = realpathSync.native(requested)
  } catch {
    return undefined
  }
  for (const root of collectAllowedRoots()) {
    try {
      if (realpathSync.native(root) === real) return real
    } catch {
      // 某个已登记的工作区不存在——跳过，不影响其它。
    }
  }
  return undefined
}

/**
 * 运行一条 git 命令。
 * @param args - 参数数组（不含 `git`）。
 * @param cwd - 仓库目录。
 * @param env - 额外环境变量（用于传入临时 index）。
 * @returns stdout。
 */
function git(args, cwd, env) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(String(stderr).trim() || error.message))
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/**
 * 为某个会话取得（必要时创建）临时 index 路径。
 *
 * 按会话保持同一个 index 文件：git 会在里面记录 stat 缓存，因此后续快照只需重新哈希
 * 真正变化的文件，而不是每次遍历整棵树。
 * @param sessionId - 会话标识。
 * @returns index 文件绝对路径与其所在目录。
 */
function indexFor(sessionId) {
  if (scratchRoot === undefined) {
    scratchRoot = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', `dsh-review-${process.pid}`)
    mkdirSync(scratchRoot, { recursive: true })
  }
  // 会话 id 来自客户端，做个保守的字符过滤以免拼出意外路径。
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80)
  return join(scratchRoot, `${safe}.index`)
}

/**
 * 给工作区拍一张快照，返回树对象 SHA。
 *
 * 全程只读：git 只写我们自己指定的临时 index，不动仓库状态。
 * @param workspace - 已校验的工作区路径。
 * @param sessionId - 会话标识（决定临时 index 的归属）。
 * @returns 树对象 SHA。
 */
async function snapshot(workspace, sessionId) {
  const indexPath = indexFor(sessionId)
  const env = { GIT_INDEX_FILE: indexPath }
  try {
    // 空仓库没有 HEAD 可读——从空 index 开始即可。
    await git(['read-tree', 'HEAD'], workspace, env).catch(() => undefined)
    // -A：已跟踪的修改与删除、新增文件、以及按 .gitignore 规则纳入的未跟踪文件。
    await git(['add', '-A'], workspace, env)
    return (await git(['write-tree'], workspace, env)).trim()
  } catch (error) {
    // 临时 index 坏掉时删掉，下次重建。
    rmSync(indexPath, { force: true })
    throw error
  }
}

/**
 * 判断工作区是不是 git 仓库。
 * @param workspace - 工作区路径。
 * @returns 是则 true。
 */
async function isRepo(workspace) {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'], workspace)).trim() === 'true'
  } catch {
    return false
  }
}

/**
 * 给响应写 JSON。
 * @param response - HTTP 响应。
 * @param status - 状态码。
 * @param payload - 可序列化负载。
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

/**
 * 读取并限制请求体。
 * @param request - HTTP 请求。
 * @returns 请求体文本（上限 8 KiB）。
 */
async function readSmallBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8192) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 创建审查路由的处理器。
 * @returns `(request, response)` 处理器。
 */
function createReviewHandler() {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')

      let payload = {}
      if (request.method === 'POST') {
        try {
          payload = JSON.parse(await readSmallBody(request))
        } catch (error) {
          sendJson(response, 400, { error: 'invalid body', detail: String(error.message) })
          return
        }
      }

      const workspace = validateWorkspace(payload.workspace ?? url.searchParams.get('workspace'))
      if (workspace === undefined) {
        sendJson(response, 400, {
          error: 'workspace not allowed',
          code: 'workspaceNotAllowed',
          detail: 'workspace must be one of the workspaces known to this app',
        })
        return
      }

      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : 'default'

      // ---- 记录基线：本轮开始时调用 ----------------------------------------
      if (url.pathname === `${ROUTE_PREFIX}/baseline`) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const revision = await snapshot(workspace, sessionId)
        baselines.set(sessionId, { revision, workspace, takenAt: Date.now() })
        sendJson(response, 200, { isRepo: true, revision, workspace })
        return
      }

      // ---- 取差异：基线 vs 当前工作区 ---------------------------------------
      if (url.pathname === `${ROUTE_PREFIX}/changes`) {
        const stored = baselines.get(sessionId)
        if (stored === undefined) {
          sendJson(response, 200, { isRepo: true, noBaseline: true })
          return
        }
        // 工作区换了（会话切了项目）：旧基线无意义，要求重新记录。
        if (stored.workspace !== workspace) {
          sendJson(response, 200, { isRepo: true, noBaseline: true, workspaceChanged: true })
          return
        }
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }

        // 重新拍一张当前快照，与基线比对。基线本身始终不动。
        const current = await snapshot(workspace, `${sessionId}-current`)
        const [stat, names, diff] = await Promise.all([
          git(['diff', '--numstat', stored.revision, current], workspace),
          git(['diff', '--name-status', stored.revision, current], workspace),
          git(['diff', '--unified=3', stored.revision, current], workspace),
        ])

        // --numstat 给出每条文件的新增/删除行数，与 --name-status 的顺序一致。
        const counts = new Map()
        for (const line of stat.split('\n')) {
          const parts = line.split('\t')
          if (parts.length < 3) continue
          counts.set(parts[2], {
            added: parts[0] === '-' ? null : Number(parts[0]),
            removed: parts[1] === '-' ? null : Number(parts[1]),
          })
        }

        const files = []
        for (const line of names.split('\n')) {
          if (line.trim() === '') continue
          const [status, ...rest] = line.split('\t')
          // 重命名形如 `R100\told\tnew`，取新路径作为展示对象。
          const path = rest[rest.length - 1]
          if (path === undefined) continue
          const count = counts.get(path)
          files.push({
            path,
            status,
            added: count?.added ?? null,
            removed: count?.removed ?? null,
          })
        }

        const truncated = diff.length > MAX_DIFF_BYTES
        sendJson(response, 200, {
          isRepo: true,
          revision: stored.revision,
          takenAt: stored.takenAt,
          files,
          diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff,
          truncated,
        })
        return
      }

      sendJson(response, 404, { error: 'not found' })
    } catch (error) {
      // 任何未预期错误都转成 JSON，避免客户端拿到 HTML 错误页而无法解析。
      sendJson(response, 500, { error: String(error?.message ?? error) })
    }
  }
}

/**
 * 挂载插件。
 * @param ctx - host 侧 cordis 上下文。
 */
export function apply(ctx) {
  const handler = createReviewHandler()
  for (const path of [`${ROUTE_PREFIX}/baseline`, `${ROUTE_PREFIX}/changes`]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `review: ${path}`)
  }
}

/** 进程退出时清掉临时 index 目录。 */
export function dispose() {
  if (scratchRoot !== undefined && existsSync(scratchRoot)) {
    rmSync(scratchRoot, { recursive: true, force: true })
  }
}
