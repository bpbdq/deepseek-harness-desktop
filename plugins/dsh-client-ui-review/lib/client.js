// review 的客户端半边：把「本轮修改」呈现出来。
//
// 数据来自 host 半边（同源 HTTP 路由）：
//   POST /dsh-desktop/review/baseline   记录本轮基线（本轮开始时调用一次）
//   POST /dsh-desktop/review/changes    基线 vs 当前工作区
//
// 轮次边界怎么定：**dsh 没有轮次生命周期事件**（`dsh-session-checkpoint-policy` 只管会话
// 日志落盘，不做文件快照）。因此这里用会话的运行状态推断——agent 从"未运行"转为"运行"
// 即一轮开始，那一刻记录基线。这是本次实现里最"推断"的一处，所以刻意写得保守：
// 只在状态真正发生跃迁时记录，且记录失败不影响任何功能。
//
// 基线按会话保存在宿主内存里，进程重启即失效；重新开始一轮会重新记录。
window.__ModuleLoader__.load({
  id: 'dsh-client-ui-review',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    /** 稳定插件名，用于诊断。 */
    const name = 'dsh-client-ui-review'

    /** 目标槽位：与 gitbar 同一排（输入框工具栏右侧、发送按钮之前）。 */
    const SLOT = 'conversation.input.right'

    /** 注册 id 与顺序。 */
    const ID = 'review-changes'
    const ORDER = 20

    /** 本地化命名空间。 */
    const NS = 'review'

    /** 路由前缀，与 host 半边一致。 */
    const API = '/dsh-desktop/review'

    /** 状态轮询间隔：agent 改动文件后要让计数跟上。 */
    const POLL_MS = 4000

    const zh = {
      idle: '本轮暂无改动',
      reviewing: '本轮改动',
      files: '{count} 个文件',
      title: '本轮修改审查',
      noBaseline: '本轮尚未记录基线。开始一轮对话后会自动记录。',
      notRepo: '当前工作区不是 git 仓库。',
      clean: '本轮没有改动任何文件。',
      loading: '正在读取差异…',
      close: '关闭',
      truncated: '差异过大，仅显示前一部分。',
      statusAdded: '新增',
      statusModified: '修改',
      statusDeleted: '删除',
      statusRenamed: '重命名',
      statusOther: '变更',
    }

    const en = {
      idle: 'No changes this turn',
      reviewing: 'Turn changes',
      files: '{count} files',
      title: 'Turn changes',
      noBaseline: 'No baseline recorded for this turn yet. It is captured when a turn starts.',
      notRepo: 'The current workspace is not a git repository.',
      clean: 'This turn did not change any file.',
      loading: 'Loading diff…',
      close: 'Close',
      truncated: 'The diff is large; only the beginning is shown.',
      statusAdded: 'added',
      statusModified: 'modified',
      statusDeleted: 'deleted',
      statusRenamed: 'renamed',
      statusOther: 'changed',
    }

    /** git 的 name-status 首字母到字典键。 */
    const STATUS_KEYS = { A: 'statusAdded', M: 'statusModified', D: 'statusDeleted', R: 'statusRenamed' }

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
     * 把差异文本渲染成带行级着色的块。
     *
     * 只做最小的语法着色（增/删/文件头），不引入差异解析库：面板要的是"看清楚改了什么"，
     * 而不是一个完整的 diff 浏览器。
     * @param diff - 统一差异文本。
     * @returns React 元素数组。
     */
    function renderDiff(diff) {
      return diff.split('\n').map((line, index) => {
        let color = '#c8c8d0'
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
          color = '#8a8a93'
        }
        return react.createElement(
          'div',
          {
            key: index,
            style: { color, background, whiteSpace: 'pre', fontVariantLigatures: 'none' },
          },
          line === '' ? ' ' : line,
        )
      })
    }

    /**
     * 审查面板：文件列表 + 统一差异。
     * @param props - 槽注入的属性。
     */
    function ReviewPanel(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const { onClose, workspace } = props
      const [state, setState] = react.useState({ phase: 'loading' })
      const [expanded, setExpanded] = react.useState('')

      react.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const result = await call('changes', { workspace, sessionId: props.sessionId ?? 'default' })
            if (alive) setState({ phase: 'ready', result })
          } catch (cause) {
            if (alive) setState({ phase: 'error', message: String(cause.message ?? cause) })
          }
        })()
        return () => {
          alive = false
        }
        // workspace 变了要重查：会话可以换项目。
      }, [workspace, props.sessionId])

      const result = state.result
      const files = result?.files ?? []

      /** 逐文件取该文件的差异片段。 */
      const hunkFor = (path) => {
        const diff = result?.diff ?? ''
        const parts = diff.split(/^diff --git /mu)
        const hit = parts.find((part) => part.includes(`b/${path}`))
        return hit === undefined ? '' : `diff --git ${hit}`
      }

      return react.createElement(
        'div',
        {
          style: {
            // 用 fixed 而不是 absolute。
            //
            // absolute 是相对工具栏里那个小容器定位的，而工具栏位于输入框卡片内部——
            // 面板会被它的可视区域裁掉，在小窗口里尤其明显（截图里只露出顶部一条）。
            // fixed 相对视口定位，彻底跳出祖先的裁剪；配合下面的 viewport 尺寸约束，
            // 面板在任何窗口大小下都完整可见。
            //
            // 位置刻意避开输入框所在的下半区，让面板浮在对话区之上。
            position: 'fixed',
            top: 'clamp(12px, 8vh, 72px)',
            right: 'clamp(12px, 3vw, 40px)',
            zIndex: 9999,
            width: 'min(760px, calc(100vw - 24px))',
            maxHeight: 'min(560px, calc(100vh - 140px))',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '10px',
            border: '1px solid #3d3d45',
            background: '#1f1f24',
            boxShadow: '0 16px 48px rgba(0,0,0,.5)',
            overflow: 'hidden',
          },
        },
        // 标题栏
        react.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '9px 12px',
              borderBottom: '1px solid #2f2f36',
              fontSize: '12.5px',
              color: '#d8d8de',
            },
          },
          react.createElement('strong', null, t('title')),
          react.createElement('span', { style: { color: '#8a8a93' } }, t('files', { count: files.length })),
          react.createElement('span', { style: { flex: 1 } }),
          react.createElement(
            'button',
            {
              type: 'button',
              onClick: onClose,
              style: {
                border: '1px solid #3d3d45',
                background: '#2a2a31',
                color: '#d8d8de',
                borderRadius: '6px',
                padding: '3px 10px',
                fontSize: '12px',
                cursor: 'pointer',
              },
            },
            t('close'),
          ),
        ),
        // 内容
        react.createElement(
          'div',
          { style: { overflowY: 'auto', padding: '8px 12px 12px' } },
          state.phase === 'loading' ? react.createElement('div', { style: { color: '#8a8a93', fontSize: '12px' } }, t('loading')) : null,
          state.phase === 'error'
            ? react.createElement('div', { style: { color: '#f0c8c8', fontSize: '12px' } }, state.message)
            : null,
          state.phase === 'ready' && result?.noBaseline === true
            ? react.createElement('div', { style: { color: '#8a8a93', fontSize: '12px' } }, t('noBaseline'))
            : null,
          state.phase === 'ready' && result?.isRepo === false
            ? react.createElement('div', { style: { color: '#8a8a93', fontSize: '12px' } }, t('notRepo'))
            : null,
          state.phase === 'ready' && result?.isRepo !== false && result?.noBaseline !== true && files.length === 0
            ? react.createElement('div', { style: { color: '#8a8a93', fontSize: '12px' } }, t('clean'))
            : null,

          files.map((file) =>
            react.createElement(
              'div',
              { key: file.path, style: { marginBottom: '6px' } },
              react.createElement(
                'button',
                {
                  type: 'button',
                  onClick: () => setExpanded((current) => (current === file.path ? '' : file.path)),
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: '100%',
                    textAlign: 'left',
                    padding: '5px 8px',
                    border: '1px solid #2f2f36',
                    borderRadius: '6px',
                    background: expanded === file.path ? '#2d4a7c' : '#26262c',
                    color: '#e0e0e6',
                    font: '12px ui-monospace, Consolas, monospace',
                    cursor: 'pointer',
                  },
                },
                react.createElement(
                  'span',
                  { style: { color: '#9a9aa2', minWidth: '46px' } },
                  t(STATUS_KEYS[file.status?.[0]] ?? 'statusOther'),
                ),
                react.createElement('span', { style: { flex: 1, wordBreak: 'break-all' } }, file.path),
                file.added === null && file.removed === null
                  ? null
                  : react.createElement(
                      'span',
                      { style: { whiteSpace: 'nowrap' } },
                      react.createElement('span', { style: { color: '#8fd6a4' } }, `+${file.added ?? 0}`),
                      ' ',
                      react.createElement('span', { style: { color: '#e0a0a0' } }, `-${file.removed ?? 0}`),
                    ),
              ),
              expanded === file.path
                ? react.createElement(
                    'div',
                    {
                      style: {
                        marginTop: '4px',
                        padding: '6px 8px',
                        border: '1px solid #2f2f36',
                        borderRadius: '6px',
                        background: '#17171b',
                        fontSize: '11px',
                        overflowX: 'auto',
                        maxHeight: '320px',
                        overflowY: 'auto',
                      },
                    },
                    renderDiff(hunkFor(file.path)),
                  )
                : null,
            ),
          ),

          result?.truncated === true
            ? react.createElement('div', { style: { marginTop: '6px', color: '#c9a0a0', fontSize: '11.5px' } }, t('truncated'))
            : null,
        ),
      )
    }

    /**
     * 输入框工具栏上的审查入口：显示本轮改动文件数，点击展开面板。
     *
     * 同时承担"记录基线"的职责：观察到会话从"未运行"转为"运行"时记一次基线，
     * 那一轮结束后的改动就都能对上。
     * @param props - 槽注入的属性。
     */
    function ReviewChip(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const { sessionId, useSessions } = props ?? {}

      // 会话的工作区：与 gitbar 同样的取法（渲染器按会话作用域自动注入这两个属性）。
      const workspace =
        typeof useSessions === 'function' && sessionId !== undefined
          ? useSessions((state) => state?.byId?.[sessionId]?.cwd)
          : undefined

      // 会话是否正在运行。用它推断轮次边界——没有轮次事件可订阅。
      const running =
        typeof useSessions === 'function' && sessionId !== undefined
          ? useSessions((state) => Boolean(state?.byId?.[sessionId]?.isRunning))
          : false

      const [open, setOpen] = react.useState(false)
      const [count, setCount] = react.useState(null)
      const [trouble, setTrouble] = react.useState('')

      // 记录基线：只在"未运行 -> 运行"的跃迁上做一次。
      const wasRunning = react.useRef(false)
      react.useEffect(() => {
        if (workspace === undefined || sessionId === undefined) return
        const justStarted = running && !wasRunning.current
        wasRunning.current = running
        if (!justStarted) return
        void call('baseline', { workspace, sessionId }).catch(() => {
          // 记录基线失败不该影响任何功能——审查面板会提示"本轮尚未记录基线"。
        })
      }, [running, workspace, sessionId])

      // 定期刷新改动文件数（agent 改文件后计数要跟上）。
      react.useEffect(() => {
        if (workspace === undefined || sessionId === undefined) return undefined
        let alive = true
        const tick = async () => {
          try {
            const result = await call('changes', { workspace, sessionId })
            if (!alive) return
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
      }, [workspace, sessionId])

      if (workspace === undefined) return null

      const label = count === null ? t('idle') : t('files', { count })
      const hasChanges = typeof count === 'number' && count > 0

      return react.createElement(
        'div',
        { style: { position: 'relative', display: 'inline-flex' } },
        react.createElement(
          'button',
          {
            type: 'button',
            title: trouble === '' ? t('title') : trouble,
            onClick: () => setOpen((value) => !value),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0 8px',
              height: '28px',
              borderRadius: '6px',
              border: `1px solid ${trouble === '' ? '#3d3d45' : '#6b3b3b'}`,
              background: hasChanges ? '#2d4a7c' : '#2a2a31',
              color: trouble === '' ? (hasChanges ? '#cfe0ff' : '#c8c8d0') : '#e6b0b0',
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
        ),
        open
          ? react.createElement(ReviewPanel, {
              t,
              workspace,
              sessionId,
              onClose: () => setOpen(false),
            })
          : null,
      )
    }

    /**
     * 挂载插件。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'review: dictionaries')
      ctx.effect(
        () =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: ID,
                order: ORDER,
                locale: NS,
                inject: () => ({ t: ctx.locale.bind(NS) }),
              },
              ReviewChip,
            ),
          ),
        'dsh-client-ui-review: review chip',
      )
    }

    exports.name = name
    exports.apply = apply
    // 与 gitbar 同样的两个必需服务：不声明 slots 会让整个界面渲染失败；
    // 不声明 locale 则取不到 ctx.locale.register。
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
