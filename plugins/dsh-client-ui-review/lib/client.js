// review 的客户端半边：本轮的改动概览，以及展示具体差异的侧边栏标签。
//
// 数据来自 host 半边（同源 HTTP 路由）：
//   POST /dsh-desktop/review/baseline   记录本轮基线（本轮开始时调用一次）
//   POST /dsh-desktop/review/changes    基线 vs 当前工作区
//
// 呈现方式刻意复用官方自带的右侧栏，而不是自制浮层：
//   * `sidebar.right.pane.tab`        —— 差异正文（keyed 槽位，key 即标签类型）
//   * `sidebar.right.pane.tab.title`  —— 标签标题
//   打开方式：inject 官方服务 `sidebarRight`，调用 `openTab(kind, { sessionId })`。
// 这样标签的外观、拖拽、关闭、全屏都由官方侧边栏管理，与文档预览等既有标签一致；
// 自制浮层做不到这些，还会在小窗口里被裁剪（此前正是如此）。
//
// 轮次边界怎么定：**dsh 没有轮次生命周期事件**，因此用会话的运行状态推断——agent 从
// "未运行"转为"运行"即一轮开始。这是本次实现里最依赖推断的一处，所以刻意保守：
// 发现没有基线且当前空闲时也会补记，避免因错过跃迁而永久失效。
window.__ModuleLoader__.load({
  id: 'dsh-client-ui-review',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    /** 稳定插件名，用于诊断。 */
    const name = 'dsh-client-ui-review'

    /** 概览入口所在的槽位。
     *
     * 必须是 **list** 类型的槽位：single 槽只能有一个注册，占用它会顶掉官方自己的注册，
     * 甚至让整个界面加载失败（实际踩过——把入口挂到 conversation.composer.bar 后，
     * 官方的 conversation 包注册失败，界面显示 "Failed to load plugins"）。
     * 下方工具栏与分支徽章同排，是 list 槽且已验证可用。
     */
    const CHIP_SLOT = 'conversation.input.right'

    /** 项目页（尚未进入会话时）可用的槽位：工作区选择器那一行。 */
    const HERO_SLOT = 'conversation.hero.workspace'

    /** 常驻面板开关的持久化键（按应用而非按会话记忆）。 */
    const PANEL_KEY = 'dsh.review.panelOpen'

    /** 侧边栏标签正文与标题的槽位。 */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'

    /** 标签类型标识：同时作为两个槽位的 key。 */
    const KIND = 'review-changes'

    /** 概览入口的注册 id 与顺序。 */
    const ID = 'review-changes'
    const ORDER = 20

    /** 本地化命名空间。 */
    const NS = 'review'

    /** 路由前缀，与 host 半边一致。 */
    const API = '/dsh-desktop/review'

    /** 概览轮询间隔。
     *
     * 取 10 秒：每次轮询都要让宿主核对工作区状态，而"本轮改了几个文件"晚几秒更新无感。 */
    const POLL_MS = 10000

    const zh = {
      idle: '本轮暂无改动',
      files: '{count} 个文件',
      title: '本轮修改审查',
      summary: '{files} 个文件，+{added} −{removed}',
      noBaseline: '本轮尚未记录基线。开始一轮对话后会自动记录。',
      notRepo: '当前工作区不是 git 仓库。',
      clean: '本轮没有改动任何文件。',
      projectTitle: '项目改动',
      projectIdle: '项目暂无改动',
      workspaceClean: '这个项目当前没有未提交的改动。',
      workspaceEmpty: '这个仓库还没有任何提交。',
      collapse: '收起面板',
      revert: '还原',
      revertConfirm: '确认还原',
      reverting: '还原中…',
      revertFailed: '还原失败：{message}',
      loading: '正在读取差异…',
      truncated: '差异过大，仅显示前一部分。',
      openInSidebar: '在侧边栏查看',
      statusAdded: '新增',
      statusModified: '修改',
      statusDeleted: '删除',
      statusRenamed: '重命名',
      statusOther: '变更',
      binaryDiff: '该文件是二进制内容，不展示逐行差异。',
      sidebarUnavailable: '当前界面未能提供侧边栏，无法展示详情。',
    }

    const en = {
      idle: 'No changes this turn',
      files: '{count} files',
      title: 'Turn changes',
      summary: '{files} files, +{added} −{removed}',
      noBaseline: 'No baseline recorded for this turn yet. It is captured when a turn starts.',
      notRepo: 'The current workspace is not a git repository.',
      clean: 'This turn did not change any file.',
      projectTitle: 'Project changes',
      projectIdle: 'No project changes',
      workspaceClean: 'This project has no uncommitted changes.',
      workspaceEmpty: 'This repository has no commits yet.',
      collapse: 'Collapse panel',
      revert: 'Revert',
      revertConfirm: 'Confirm revert',
      reverting: 'Reverting…',
      revertFailed: 'Revert failed: {message}',
      loading: 'Loading diff…',
      truncated: 'The diff is large; only the beginning is shown.',
      openInSidebar: 'Open in sidebar',
      statusAdded: 'added',
      statusModified: 'modified',
      statusDeleted: 'deleted',
      statusRenamed: 'renamed',
      statusOther: 'changed',
      binaryDiff: 'This file is binary; no line diff is shown.',
      sidebarUnavailable: 'The sidebar is unavailable, so details cannot be shown.',
    }

    /** git 的 name-status 首字母到字典键。 */
    const STATUS_KEYS = { A: 'statusAdded', M: 'statusModified', D: 'statusDeleted', R: 'statusRenamed' }

    /** 状态字母对应的颜色，让列表一眼能分辨增删改。 */
    const STATUS_COLORS = { A: '#8fd6a4', M: '#e0c98f', D: '#e0a0a0', R: '#9db8e8' }

    /**
     * 常驻面板开关的持久化状态。
     *
     * 刻意放在模块级而不是组件 state 里：面板需要在**不同槽位之间共享同一个开关**——
     * 项目页的入口挂在 `conversation.hero.workspace`，会话内的入口挂在输入框工具栏，
     * 两者是两个组件实例，但它们控制的是同一块面板。用 localStorage 加一个订阅列表，
     * 既共享状态又跨重启记住用户的选择。
     */
    const panelStore = (() => {
      const listeners = new Set()
      let open = false
      try {
        open = window.localStorage.getItem(PANEL_KEY) === '1'
      } catch {
        // 读不到就用默认值（隐私模式等）。
      }
      return {
        get: () => open,
        set: (value) => {
          open = value
          try {
            window.localStorage.setItem(PANEL_KEY, value ? '1' : '0')
          } catch {
            // 存不了也不影响本次会话内的行为。
          }
          for (const listener of listeners) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    })()

    /**
     * 订阅常驻面板的开关状态。
     * @returns 当前是否展开。
     */
    function usePanelOpen() {
      return react.useSyncExternalStore(panelStore.subscribe, panelStore.get, () => false)
    }

    /**
     * 请求宿主侧路由。
     * @param path - 相对 API 前缀的路径。
     * @param body - 请求体（会被 JSON 序列化）。
     * @returns 解析后的 JSON；失败时抛出带 code/detail 的错误。
     */
    async function call(path, body) {
      const response = await fetch(`${API}/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(text.slice(0, 200))
      }
      if (!response.ok) {
        const error = new Error(payload?.error ?? `HTTP ${response.status}`)
        if (typeof payload?.code === 'string') error.code = payload.code
        if (typeof payload?.detail === 'string') error.detail = payload.detail
        throw error
      }
      return payload
    }

    /**
     * 判断一段差异是否是"二进制内容"而非行级差异。
     *
     * git 对二进制文件只输出 `Binary files … differ`，没有可直接渲染的行。若不识别它，
     * 界面就会把这句话当成一行普通文本显示，看起来像是乱码或坏数据。
     * @param diff - 单个文件的差异片段。
     * @returns 是二进制则 true。
     */
    function isBinaryDiff(diff) {
      return /^Binary files .* differ$/mu.test(diff) || /^GIT binary patch$/mu.test(diff)
    }

    /**
     * 按文件切分统一差异文本。
     *
     * 差异里最长的行可能是极长的单行文件（例如被压缩成一行的 JSON、或内嵌 data URI），
     * 直接整段渲染会让布局横向撑爆。因此这里不截断内容，但在渲染时用 `pre-wrap` +
     * 自动换行，让长行折行显示而不是撑开容器。
     * @param diff - 完整差异文本。
     * @returns 路径到该文件差异片段的映射。
     */
    function splitByFile(diff) {
      const map = new Map()
      // 以 `diff --git a/x b/y` 为界切分；首段（若有）不带前缀，忽略。
      const parts = diff.split(/^diff --git /mu).slice(1)
      for (const part of parts) {
        const head = part.split('\n', 1)[0]
        // 头部形如 `a/<old> b/<new>`，取 b/ 侧作为路径。
        const match = / b\/(.+)$/u.exec(head)
        const path = match === null ? undefined : match[1]
        if (path !== undefined) map.set(path, `diff --git ${part}`)
      }
      return map
    }

    /**
     * 渲染差异文本。
     *
     * 只做最小的行级着色（增/删/文件头），不引入差异解析库：要的是"看清楚改了什么"，
     * 而不是一个完整的 diff 浏览器。
     *
     * 长行处理：`whiteSpace: 'pre-wrap'` 配合 `overflowWrap: 'anywhere'`，使超长行折行
     * 而不是把容器撑宽——这是"乱码/看不出改动"观感的主要来源之一。
     * @param diff - 统一差异文本。
     * @returns React 元素数组。
     */
    function renderDiff(diff) {
      return diff.split('\n').map((line, index) => {
        let color = 'var(--dsw-alias-label-secondary)'
        let background = 'transparent'
        if (line.startsWith('+') && !line.startsWith('+++')) {
          color = '#b6e0c2'
          background = 'rgba(60,140,90,.16)'
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          color = '#f0c8c8'
          background = 'rgba(160,70,70,.16)'
        } else if (line.startsWith('@@')) {
          color = '#8fb8ff'
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
          color = 'var(--dsw-alias-label-tertiary)'
        }
        return react.createElement(
          'div',
          {
            key: index,
            style: {
              color,
              background,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontVariantLigatures: 'none',
            },
          },
          line === '' ? ' ' : line,
        )
      })
    }

    /**
     * 读取本轮改动数据的共用钩子。
     * @param workspace - 会话的工作区。
     * @param sessionId - 会话标识。
     * @returns `{ state, reload }`。
     */
    function useChanges(workspace, sessionId) {
      const [state, setState] = react.useState({ phase: 'loading' })

      const reload = react.useCallback(async () => {
        if (workspace === undefined || sessionId === undefined) return
        try {
          const result = await call('changes', { workspace, sessionId })
          setState({ phase: 'ready', result })
        } catch (cause) {
          setState({ phase: 'error', message: String(cause.message ?? cause) })
        }
      }, [workspace, sessionId])

      react.useEffect(() => {
        void reload()
      }, [reload])

      return { state, reload }
    }

    /**
     * 由改动数据汇总出统计。
     * @param result - 路由响应。
     * @returns `{ files, added, removed }`。
     */
    function summarize(result) {
      const files = result?.files ?? []
      let added = 0
      let removed = 0
      for (const file of files) {
        added += file.added ?? 0
        removed += file.removed ?? 0
      }
      return { files, added, removed }
    }

    /**
     * 读取工作区级改动（相对 HEAD，不需要会话）。
     *
     * 项目页还没有任何一轮对话，因此"本轮改动"在那里无意义；这里读的是这个项目当前
     * 有哪些未提交改动。
     * @param workspace - 工作区路径。
     * @returns `{ state, reload }`。
     */
    function useWorkspaceChanges(workspace) {
      const [state, setState] = react.useState({ phase: 'loading' })

      const reload = react.useCallback(async () => {
        if (workspace === undefined) return
        try {
          const result = await call('workspace', { workspace })
          setState({ phase: 'ready', result })
        } catch (cause) {
          setState({ phase: 'error', message: String(cause.message ?? cause) })
        }
      }, [workspace])

      react.useEffect(() => {
        void reload()
      }, [reload])

      return { state, reload }
    }

    /**
     * 常驻的右侧面板。
     *
     * 自绘而不是用官方右侧栏：官方那套内容槽带 `scope: "session"`，在项目页（没有会话）
     * 时不渲染，且 `sidebarRightTabs` 没有任何被采纳的会话——实测 `openTabIn` 会静默
     * 返回而不报错。因此项目级面板只能自己管理。
     *
     * 位置用 fixed 相对视口，避免被祖先裁剪（此前自制浮层就因此在小窗口里只露出顶部）。
     * @param props - `{ t, workspace, sessionId, scope, candidates, onPick }`。
     */
    function ReviewPanel(props) {
      const { t, workspace, sessionId, scope, candidates, onPick } = props
      const open = usePanelOpen()

      // 两种语义分别取数据：本轮改动需要会话，工作区改动不需要。
      const turn = useChanges(scope === 'workspace' ? undefined : workspace, sessionId)
      const workspaceChanges = useWorkspaceChanges(scope === 'workspace' ? workspace : undefined)
      const active = scope === 'workspace' ? workspaceChanges.state : turn.state

      if (!open) return null

      const { files, added, removed } = summarize(active.result)
      const title = scope === 'workspace' ? t('projectTitle') : t('title')
      const options = Array.isArray(candidates) ? candidates : []

      return react.createElement(
        'aside',
        {
          style: {
            position: 'fixed',
            top: 'clamp(12px, 6vh, 60px)',
            right: 'clamp(8px, 2vw, 24px)',
            bottom: 'clamp(12px, 6vh, 60px)',
            zIndex: 9998,
            width: 'min(520px, calc(100vw - 32px))',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '10px',
            border: '1px solid var(--dsw-alias-border-l2, #3d3d45)',
            background: 'var(--dsw-alias-bg-base)',
            boxShadow: '0 16px 48px rgba(0,0,0,.45)',
            overflow: 'hidden',
          },
        },
        react.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '9px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l1, #2f2f36)',
              fontSize: '12.5px',
              color: 'var(--dsw-alias-label-primary)',
            },
          },
          react.createElement('strong', null, title),
          react.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('files', { count: files.length })),
          react.createElement('span', { style: { flex: 1 } }),
          react.createElement(
            'button',
            {
              type: 'button',
              onClick: () => panelStore.set(false),
              title: t('collapse'),
              'aria-label': t('collapse'),
              style: {
                border: '1px solid var(--dsw-alias-border-l2, #3d3d45)',
                background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-2, #2a2a31))',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: '6px',
                width: '24px',
                height: '24px',
                cursor: 'pointer',
                lineHeight: 1,
              },
            },
            '×',
          ),
        ),
        // 工作区选择器：只在项目级且有多个候选时出现。
        //
        // 为什么需要：全新状态下应用里可能还没有"当前工作区"（没有任何会话与登记项），
        // 此时面板必须能列出候选让用户选，而不是猜一个路径。
        scope === 'workspace' && options.length > 1 && typeof onPick === 'function'
          ? react.createElement(
              'div',
              { style: { padding: '8px 12px 0' } },
              react.createElement(
                'select',
                {
                  value: workspace ?? '',
                  onChange: (event) => onPick(event.target.value),
                  style: {
                    width: '100%',
                    padding: '4px 6px',
                    borderRadius: '6px',
                    border: '1px solid var(--dsw-alias-border-l2, #3d3d45)',
                    background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-2, #26262c))',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: '12px',
                  },
                },
                options.map((option) =>
                  react.createElement('option', { key: option, value: option }, option),
                ),
              ),
            )
          : null,
        react.createElement(
          'div',
          { style: { overflowY: 'auto', padding: '8px 12px 12px' } },
          react.createElement(FileList, {
            t,
            result: active.result,
            phase: active.phase,
            message: active.message,
            workspace,
            sessionId,
            onChanged: scope === 'workspace' ? workspaceChanges.reload : turn.reload,
          }),
        ),
      )
    }

    /**
     * 判断一个值像不像工作区路径。
     * @param value - 候选值。
     * @returns 是字符串且非空则返回它。
     */
    function asPath(value) {
      return typeof value === 'string' && value !== '' ? value : undefined
    }

    /**
     * 在项目页推断"当前工作区"。
     *
     * 项目页没有会话，因此没有 `sessionId → cwd` 这条现成的路。按可靠性依次尝试：
     *   1. 最近会话的 cwd —— 用户实际使用时通常已有历史会话，这条最准；
     *   2. 工作区列表里的第一项 —— 刚安装、还没有任何会话时的兜底。
     * 两者都拿不到就不渲染入口，而不是猜一个路径（错误的路径只会得到 400）。
     * @param props - 槽注入的属性。
     * @returns 工作区路径；无法确定时 undefined。
     */
    function resolveProjectWorkspace(props) {
      // 会话存储：通常由渲染器自动注入 useSessions。
      if (typeof props?.useSessions === 'function') {
        const recent = props.useSessions((state) => {
          const list = state?.ids ?? []
          for (let index = list.length - 1; index >= 0; index -= 1) {
            const cwd = asPath(state?.byId?.[list[index]]?.cwd)
            if (cwd !== undefined) return cwd
          }
          return undefined
        })
        if (recent !== undefined) return recent
      }

      // 工作区列表：形状是 `{ items: [...] }`。
      if (typeof props?.useWorkspaces === 'function') {
        const first = props.useWorkspaces((state) => {
          const items = state?.items
          if (!Array.isArray(items)) return undefined
          for (const item of items) {
            const root = asPath(item?.path ?? item?.root)
            if (root !== undefined) return root
          }
          return undefined
        })
        if (first !== undefined) return first
      }

      return asPath(props?.workspace)
    }

    /**
     * 读取**全部**已登记的工作区。
     *
     * 项目级面板需要它：全新状态下既没有会话也没有"当前工作区"，面板必须能列出候选并
     * 让用户选，而不是猜一个路径（猜错只会得到 400 workspaceNotAllowed）。
     * @param props - 槽注入的属性。
     * @returns 工作区路径数组。
     */
    function useWorkspaceList(props) {
      return typeof props?.useWorkspaces === 'function'
        ? props.useWorkspaces((state) => {
            const items = state?.items
            if (!Array.isArray(items)) return []
            return items.map((item) => asPath(item?.path ?? item?.root)).filter((value) => value !== undefined)
          })
        : []
    }

    /**
     * 项目页（尚未进入会话）的常驻面板入口。
     * @param props - 槽注入的属性。
     */
    function HeroChangesTrigger(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const open = usePanelOpen()
      const candidates = useWorkspaceList(props)
      const inferred = resolveProjectWorkspace(props)

      // 用户手动选定的工作区优先；否则用推断出的那个。两者都没有就取第一个候选。
      const [picked, setPicked] = react.useState(undefined)
      const workspace = picked ?? inferred ?? candidates[0]
      const [count, setCount] = react.useState(null)

      react.useEffect(() => {
        if (workspace === undefined) return undefined
        let alive = true
        const tick = async () => {
          try {
            const result = await call('workspace', { workspace })
            if (alive) setCount(result?.isRepo === false ? null : (result?.files?.length ?? 0))
          } catch {
            if (alive) setCount(null)
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [workspace])

      if (workspace === undefined) return null
      const hasChanges = typeof count === 'number' && count > 0

      return react.createElement(
        'div',
        { style: { display: 'inline-flex' } },
        react.createElement(
          'button',
          {
            type: 'button',
            title: t('projectTitle'),
            onClick: () => panelStore.set(!open),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0 10px',
              height: '28px',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-l2, #3d3d45)',
              background: hasChanges || open ? '#2d4a7c' : 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-2, #2a2a31))',
              color: hasChanges || open ? '#cfe0ff' : 'var(--dsw-alias-label-secondary)',
              fontSize: '12px',
              fontFamily: 'ui-monospace, Consolas, monospace',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            },
          },
          react.createElement(
            'svg',
            { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            react.createElement('path', {
              d: 'M3 4.5h10M3 8h10M3 11.5h6',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
            }),
          ),
          react.createElement('span', null, count === null ? t('projectIdle') : t('files', { count })),
        ),
        react.createElement(ReviewPanel, {
          t,
          workspace,
          scope: 'workspace',
          candidates,
          onPick: setPicked,
        }),
      )
    }

    /**
     * 文件列表：每行一个文件，点击展开该文件的差异。
     * @param props - `{ t, result, phase, message, workspace, sessionId }`。
     */
    function FileList(props) {
      const { t, result, phase, message } = props
      const [expanded, setExpanded] = react.useState('')
      // 待确认还原的路径：还原是写操作，必须二次确认，因此先记下来再让用户点确认。
      const [confirming, setConfirming] = react.useState('')
      const [busy, setBusy] = react.useState('')
      const [trouble, setTrouble] = react.useState('')
      const onChanged = typeof props?.onChanged === 'function' ? props.onChanged : () => undefined
      const { files, added, removed } = summarize(result)
      const byFile = react.useMemo(() => splitByFile(result?.diff ?? ''), [result?.diff])

      /**
       * 还原单个文件到基线（本轮）或 HEAD（工作区）。
       * @param path - 相对仓库根的路径。
       */
      const revert = async (path) => {
        setBusy(path)
        setTrouble('')
        try {
          await call('revert', {
            workspace: props.workspace,
            sessionId: props.sessionId,
            scope: result?.scope === 'workspace' ? 'workspace' : 'turn',
            paths: [path],
          })
          setConfirming('')
          onChanged()
        } catch (cause) {
          setTrouble(String(cause.message ?? cause))
        } finally {
          setBusy('')
        }
      }

      if (phase === 'loading') {
        return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '10px 2px' } }, t('loading'))
      }
      if (phase === 'error') {
        return react.createElement('div', { style: { color: '#f0c8c8', fontSize: '12px', padding: '10px 2px' } }, message)
      }
      if (result?.isRepo === false) {
        return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '10px 2px' } }, t('notRepo'))
      }
      if (result?.empty === true) {
        return react.createElement(
          'div',
          { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '10px 2px' } },
          t('workspaceEmpty'),
        )
      }
      if (result?.noBaseline === true) {
        return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '10px 2px' } }, t('noBaseline'))
      }
      if (files.length === 0) {
        // 项目级与轮次级用不同措辞：前者是"没有未提交改动"，后者是"本轮没改文件"。
        const key = result?.scope === 'workspace' ? 'workspaceClean' : 'clean'
        return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '10px 2px' } }, t(key))
      }

      return react.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        react.createElement(
          'div',
          { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', padding: '0 2px' } },
          t('summary', { files: files.length, added, removed }),
        ),
        files.map((file) => {
          const diff = byFile.get(file.path) ?? ''
          const open = expanded === file.path
          const wantsRevert = confirming === file.path
          const working = busy === file.path
          return react.createElement(
            'div',
            { key: file.path },
            react.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'stretch', gap: '4px' } },
              react.createElement(
                'button',
                {
                  type: 'button',
                  onClick: () => setExpanded(open ? '' : file.path),
                  title: file.path,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    flex: '1 1 auto',
                    minWidth: 0,
                    textAlign: 'left',
                    padding: '6px 8px',
                    border: '1px solid var(--dsw-alias-border-l1, #2f2f36)',
                    borderRadius: '6px',
                    background: open ? '#2d4a7c' : 'var(--dsw-alias-bg-layer-2, #26262c)',
                    color: open ? '#cfe0ff' : 'var(--dsw-alias-label-primary)',
                    font: '12px ui-monospace, Consolas, monospace',
                    cursor: 'pointer',
                  },
                },
                react.createElement(
                  'span',
                  { style: { color: STATUS_COLORS[file.status?.[0]] ?? 'var(--dsw-alias-label-secondary)', minWidth: '38px', fontSize: '11px' } },
                  t(STATUS_KEYS[file.status?.[0]] ?? 'statusOther'),
                ),
                react.createElement(
                  'span',
                  { style: { flex: 1, wordBreak: 'break-all', lineHeight: '1.35' } },
                  file.path,
                ),
                react.createElement(
                  'span',
                  { style: { whiteSpace: 'nowrap', fontSize: '11px' } },
                  react.createElement('span', { style: { color: '#8fd6a4' } }, `+${file.added ?? 0}`),
                  ' ',
                  react.createElement('span', { style: { color: '#e0a0a0' } }, `−${file.removed ?? 0}`),
                ),
              ),
              // 还原按钮。首次点击进入确认态，再点一次才真正还原——这是写操作，
              // 不该一击生效（误点会丢掉用户自己的改动）。
              react.createElement(
                'button',
                {
                  type: 'button',
                  disabled: working,
                  title: wantsRevert ? t('revertConfirm') : t('revert'),
                  onClick: () => (wantsRevert ? void revert(file.path) : setConfirming(file.path)),
                  onBlur: () => setConfirming((current) => (current === file.path ? '' : current)),
                  style: {
                    flex: '0 0 auto',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: `1px solid ${wantsRevert ? '#8b5a5a' : 'var(--dsw-alias-border-l1, #2f2f36)'}`,
                    background: wantsRevert ? '#6b3b3b' : 'var(--dsw-alias-bg-layer-2, #26262c)',
                    color: wantsRevert ? '#ffdede' : 'var(--dsw-alias-label-secondary)',
                    fontSize: '11px',
                    fontFamily: 'inherit',
                    cursor: working ? 'default' : 'pointer',
                    whiteSpace: 'nowrap',
                  },
                },
                working ? t('reverting') : wantsRevert ? t('revertConfirm') : t('revert'),
              ),
            ),
            open
              ? react.createElement(
                  'div',
                  {
                    style: {
                      marginTop: '4px',
                      padding: '8px',
                      border: '1px solid var(--dsw-alias-border-l1, #2f2f36)',
                      borderRadius: '6px',
                      background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-1, #17171b))',
                      fontSize: '11px',
                      lineHeight: '1.45',
                      overflow: 'hidden',
                    },
                  },
                  isBinaryDiff(diff)
                    ? react.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('binaryDiff'))
                    : renderDiff(diff),
                )
              : null,
          )
        }),
        result?.truncated === true
          ? react.createElement('div', { style: { marginTop: '4px', color: '#c9a0a0', fontSize: '11.5px' } }, t('truncated'))
          : null,
      )
    }

    /**
     * 侧边栏里的审查标签正文。
     * @param props - 槽注入的属性（含会话标识与本地化函数）。
     */
    function ReviewTab(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      // 标签正文的注入按会话作用域做，因此 sessionId 可直接使用。
      const sessionId = props?.sessionId
      const workspace =
        typeof props?.useSessions === 'function' && sessionId !== undefined
          ? props.useSessions((state) => state?.byId?.[sessionId]?.cwd)
          : undefined

      const { state, reload } = useChanges(workspace, sessionId)

      return react.createElement(
        'div',
        { style: { padding: '10px 12px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' } },
        react.createElement(FileList, {
          t,
          result: state.result,
          phase: state.phase,
          message: state.message,
          workspace,
          sessionId,
          onChanged: reload,
        }),
      )
    }

    /** 侧边栏标签的标题。 */
    function ReviewTabTitle(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      return react.createElement('span', { style: { fontSize: '12px' } }, t('title'))
    }

    /**
     * 输入框工具栏上的改动概览入口：显示本轮改动文件数，点击在侧边栏查看详情。
     *
     * 同时负责**记录基线**：观察到会话由"未运行"转为"运行"时记一次，那一轮结束后的
     * 改动就都能对上；若发现没有基线而当前空闲，也补记一次（见下方注释）。
     * @param props - 槽注入的属性。
     */
    function ReviewChip(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const { sessionId, useSessions } = props ?? {}

      const workspace =
        typeof useSessions === 'function' && sessionId !== undefined
          ? useSessions((state) => state?.byId?.[sessionId]?.cwd)
          : undefined

      const running =
        typeof useSessions === 'function' && sessionId !== undefined
          ? useSessions((state) => Boolean(state?.byId?.[sessionId]?.isRunning))
          : false

      const [count, setCount] = react.useState(null)
      const [trouble, setTrouble] = react.useState('')

      // 记录基线：只在"未运行 -> 运行"的跃迁上做一次。
      const wasRunning = react.useRef(false)
      react.useEffect(() => {
        if (workspace === undefined || sessionId === undefined) return
        const justStarted = running && !wasRunning.current
        wasRunning.current = running
        if (!justStarted) return
        void call('baseline', { workspace, sessionId }).catch(() => undefined)
      }, [running, workspace, sessionId])

      // 刷新改动文件数；顺带做基线自愈。
      react.useEffect(() => {
        if (workspace === undefined || sessionId === undefined) return undefined
        let alive = true
        const tick = async () => {
          try {
            const result = await call('changes', { workspace, sessionId })
            if (!alive) return
            if (result?.noBaseline === true && !running) {
              // 空闲时补记：agent 不在运行就不可能产生改动，因此这一刻正是"下一轮开始前"。
              // 需要自愈是因为基线原本只在跃迁时记录，而"挂载时该轮已在跑"与"记录失败后
              // 不再重试"这两种情况都会让它永久缺失。
              await call('baseline', { workspace, sessionId }).catch(() => undefined)
              return
            }
            setCount(result?.isRepo === false || result?.noBaseline === true ? null : (result?.files?.length ?? 0))
            setTrouble('')
          } catch (cause) {
            if (alive) setTrouble(String(cause.message ?? cause))
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [workspace, sessionId, running])

      if (workspace === undefined) return null

      const hasChanges = typeof count === 'number' && count > 0
      // 只用数字，不加"个文件"字样：这一排宽度有限，多出的文字会把相邻控件挤变形。
      // 完整含义放在悬停提示里。
      const label = count === null ? t('idle') : String(count)

      return react.createElement(
        'button',
        {
          type: 'button',
          title: trouble === '' ? t('openInSidebar') : trouble,
          onClick: () => {
            // 用官方侧边栏打开差异标签——标签的关闭、拖拽、全屏都交给它管理。
            const open = props?.sidebarRight
            if (open === undefined) {
              setTrouble(t('sidebarUnavailable'))
              return
            }
            try {
              // 优先用会话作用域的 openTabIn；没有 sessionId 时退回 openTab（它自行解析会话）。
              if (sessionId !== undefined && typeof open.openTabIn === 'function') {
                open.openTabIn(sessionId, KIND, {})
              } else if (typeof open.openTab === 'function') {
                open.openTab(KIND, {})
              } else {
                // 诊断信息，面向开发者，列出服务实际提供的键名以便定位契约变化。
                // 标记必须与代码同一行——检查器是逐行判定的。
                setTrouble(`sidebarRight 没有 openTab/openTabIn（实际键：${Object.keys(open).join(',')}）`) // i18n-allow
                return
              }
              setTrouble('')
            } catch (cause) {
              // 不静默吞掉：打不开侧边栏时把原因显示在悬停提示里，否则表现只是"点了没反应"，
              // 从界面完全看不出是服务缺失、方法名不符，还是标签类型没登记。
              setTrouble(String(cause?.message ?? cause))
            }
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '0 8px',
            height: '28px',
            borderRadius: '6px',
            border: `1px solid ${trouble === '' ? 'var(--dsw-alias-border-l2, #3d3d45)' : '#6b3b3b'}`,
            background: hasChanges ? '#2d4a7c' : 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-2, #2a2a31))',
            color: trouble === '' ? (hasChanges ? '#cfe0ff' : 'var(--dsw-alias-label-secondary)') : '#e6b0b0',
            fontSize: '12px',
            fontFamily: 'ui-monospace, Consolas, monospace',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          },
        },
        // 一个"清单"小图标，避免依赖图标库。
        react.createElement(
          'svg',
          { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          react.createElement('path', {
            d: 'M3 4.5h10M3 8h10M3 11.5h6',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
          }),
        ),
        react.createElement('span', null, label),
      )
    }

    /**
     * 挂载插件。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      // 诊断挂钩：侧边栏的"打开标签"在会话未被采纳时**静默返回**，失败只表现为
      // "点了没反应"，从界面无法判断是服务缺失、会话不匹配还是标签类型没登记。
      // 把服务挂到 window 上，使这条链路可以被脚本断言。
      // 键名带插件前缀，避免与官方或其它插件的全局冲突。
      // 稳定的诊断路径：把侧边栏服务挂到 window 上。
      //
      // 侧边栏的"打开标签"在会话未被采纳时**静默返回**，失败只表现为"点了没反应"，
      // 从界面无法判断是服务缺失、标签类型没登记，还是会话不匹配。留着这个引用，
      // 就可以在渲染进程里直接调用并看到抛出的原因——定位这个问题时正是靠它。
      if (typeof window !== 'undefined') window.__dshDesktopReview = ctx.sidebarRight

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'review: dictionaries')

      ctx.effect(
        () =>
          ctx.slots.inject(CHIP_SLOT, () =>
            ctx.slots.register(
              {
                name: CHIP_SLOT,
                id: ID,
                order: ORDER,
                locale: NS,
                // 把官方侧边栏服务交给概览入口，供它打开差异标签。
                inject: () => ({ t: ctx.locale.bind(NS), sidebarRight: ctx.sidebarRight }),
              },
              ReviewChip,
            ),
          ),
        'dsh-client-ui-review: review chip',
      )

      // 项目页的常驻面板入口。挂在这个槽位是因为它**在没有会话时也渲染**——
      // 官方右侧栏的内容槽带 scope: "session"，项目页根本没有它（实测）。
      ctx.effect(
        () =>
          ctx.slots.inject(HERO_SLOT, () =>
            ctx.slots.register(
              {
                name: HERO_SLOT,
                id: 'review-project-changes',
                order: 30,
                locale: NS,
                inject: () => ({ t: ctx.locale.bind(NS) }),
              },
              HeroChangesTrigger,
            ),
          ),
        'dsh-client-ui-review: project changes trigger',
      )

      // 把标签**类型**注册进侧边栏的类型表。
      //
      // 这一步与下面的槽位注册是两件事，缺一不可：
      //   * 类型表（这里）决定 `openTab(kind)` 能否找到该类型——缺了会抛
      //     `no tab type is registered as "…"`；
      //   * 槽位（下面）决定找到类型后由哪个组件渲染正文。
      // 早先只注册了槽位，于是点击后表现为"没反应"：openTab 拿不到类型。
      ctx.effect(() => {
        const registry = ctx.sidebarRightTabs
        if (registry === undefined) return () => undefined
        return registry.register({
          id: KIND,
          kind: KIND,
          // 本标签没有对应的资源地址；`title` 只在标签栏显示固定文案。
          title: () => ctx.locale.bind(NS)('title'),
        })
      }, 'dsh-client-ui-review: tab type')

      // 差异正文：keyed 槽位，key 即上面注册的标签类型。
      ctx.effect(
        () =>
          ctx.slots.inject(TAB_SLOT, () =>
            ctx.slots.register(
              {
                name: TAB_SLOT,
                key: KIND,
                locale: NS,
                inject: () => ({ t: ctx.locale.bind(NS) }),
              },
              ReviewTab,
            ),
          ),
        'dsh-client-ui-review: review tab body',
      )

      ctx.effect(
        () =>
          ctx.slots.inject(TAB_TITLE_SLOT, () =>
            ctx.slots.register(
              {
                name: TAB_TITLE_SLOT,
                key: KIND,
                locale: NS,
                inject: () => ({ t: ctx.locale.bind(NS) }),
              },
              ReviewTabTitle,
            ),
          ),
        'dsh-client-ui-review: review tab title',
      )
    }

    exports.name = name
    exports.apply = apply
    // 四个必需服务：slots 与 locale 是插件机制要求（缺 slots 会导致整个界面白屏）；
    // sidebarRight 用于打开标签，sidebarRightTabs 用于把标签类型注册进它的类型表。
    exports.inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']
    return module.exports
  },
})
