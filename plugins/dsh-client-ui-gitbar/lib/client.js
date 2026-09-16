// gitbar 的客户端半边。
//
// 插到 `conversation.input.right` —— 输入框工具栏右侧、模型选择器之前，也就是
// 发送按钮左边那个位置。这个槽是 `kind: 'list'`、`scope: 'session'`，因此第三方
// 可以安全追加条目，不会被单占位槽拒绝。
//
// 这个文件刻意手写、不引入打包链：客户端 bundle 的契约很简单——调用 shell 提供的
// `window.__ModuleLoader__.load({ id, factory })`，在 factory 里 require 共享的基线
// 模块表，导出 `{ name, apply }`。官方包（如 dsh-client-ui-agent-preset/lib/client.js）
// 用的就是这个格式。
//
// 数据来自 host 半边注册的 HTTP 路由（同源，无需 token——服务端已经用 cookie 认证
// 过这个页面）：GET status / GET branches / POST checkout。
window.__ModuleLoader__.load({
  id: 'dsh-client-ui-gitbar',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    // 与官方包共用同一套基础组件，外观因此自动跟随主题，不需要自己对齐样式。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 稳定插件名，用于诊断。 */
    const name = 'dsh-client-ui-gitbar'

    /** 目标槽位。 */
    const SLOT = 'conversation.input.right'

    /** 注册 id，卸载时按它撤销。 */
    const ID = 'gitbar-branch'

    /** 注册顺序：放在该列表的最前面，紧贴模型选择器左侧。 */
    const ORDER = 10

    /** 路由前缀，与 host 半边保持一致。 */
    const API = '/dsh-desktop/gitbar'

    /** 本地化命名空间：字典注册到它下面，`ctx.locale.bind(NS)` 得到 `t`。 */
    const NS = 'gitbar'

    /**
     * 两套字典。
     *
     * 与官方客户端插件同一做法（见 dsh-client-ui-directory-picker-browse）：在 apply
     * 里 `ctx.locale.register(NS, { zh, en })`，再通过槽的 `inject` 把
     * `ctx.locale.bind(NS)` 得到的 `t` 传给组件。
     *
     * 注意 host 侧不返回任何自然语言提示——它不知道界面语言，只回稳定的 code，
     * 由这里的 `error_<code>` 渲染。git 自己的报错原文照常显示，因为它是权威信息，
     * 翻译反而失真。
     */
    const zh = {
      switching: '切换中…',
      switchBranch: '切换分支',
      stashing: '暂存并切换中…',
      stashAndSwitch: '暂存改动并切换到 {branch}',
      hintCommitOrStash: '提交这些改动，或用下方的「暂存并切换」。',
      noBranches: '没有可切换的分支',
      remoteBranch: '远程分支（切换时会自动创建本地跟踪分支）',
      localBranch: '本地分支',
      stashed: '改动已存入 stash {ref}，可用 git stash pop 恢复',
      error_localChanges: '切换被 git 拒绝：有未提交改动会被覆盖。',
      error_stashFailed: '暂存失败。',
      error_nothingToStash: '工作区没有未提交改动，可直接切换。',
      error_invalidBranch: '分支名不合法，已拒绝。',
      error_workspaceNotAllowed: '该工作区未在本应用中登记，已拒绝访问。',
      error_unknown: '切换失败。',
    }

    const en = {
      switching: 'Switching…',
      switchBranch: 'Switch branch',
      stashing: 'Stashing and switching…',
      stashAndSwitch: 'Stash changes and switch to {branch}',
      hintCommitOrStash: 'Commit these changes, or use "Stash changes and switch" below.',
      noBranches: 'No branches to switch to',
      remoteBranch: 'Remote branch (a local tracking branch is created on switch)',
      localBranch: 'Local branch',
      stashed: 'Changes saved to {ref}; restore them with git stash pop',
      error_localChanges: 'git refused the switch: you have uncommitted changes it would overwrite.',
      error_stashFailed: 'Stashing failed.',
      error_nothingToStash: 'The working tree is clean; switch directly.',
      error_invalidBranch: 'That branch name was rejected.',
      error_workspaceNotAllowed: 'That workspace is not registered with this app; access denied.',
      error_unknown: 'Switch failed.',
    }

    /** 状态轮询间隔：分支会在外部被切换（终端里 git checkout），所以要定期对齐。 */
    const POLL_MS = 15000

    /**
     * 请求 host 侧的 git 路由。
     * @param path - 相对 API 前缀的路径，如 'status'。
     * @param options - `cwd` 是要查询的工作区；`init` 是额外的 fetch 选项。
     * @returns 解析后的 JSON；失败时抛出。
     */
    async function call(path, options) {
      const { cwd, ...init } = options ?? {}
      // 必须带上工作区：会话可以有自己的项目，与外壳启动时的那个不同。
      // 不传的话 host 会用外壳工作区，于是切换项目后徽章仍显示上一个仓库的分支。
      const query = typeof cwd === 'string' && cwd !== '' ? `?cwd=${encodeURIComponent(cwd)}` : ''
      const response = await fetch(`${API}/${path}${query}`, {
        // 同源请求带上 cookie，服务端据此认证。
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        ...init,
      })
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        // 服务端理论上总是回 JSON；真出现 HTML 时把原文带出来，便于定位。
        throw new Error(text.slice(0, 200))
      }
      if (!response.ok) {
        // 把 host 的 code 与 detail 都挂到错误对象上，交给 describeError 决定
        // 用哪条本地化短句、以及是否展示 git 原文。
        const error = new Error(payload?.error ?? `HTTP ${response.status}`)
        if (typeof payload?.code === 'string') error.code = payload.code
        if (typeof payload?.detail === 'string') error.detail = payload.detail
        throw error
      }
      return payload
    }

    /** host 的稳定 code 到字典键的映射。 */
    const ERROR_KEYS = {
      localChanges: 'error_localChanges',
      stashFailed: 'error_stashFailed',
      nothingToStash: 'error_nothingToStash',
      invalidBranch: 'error_invalidBranch',
      workspaceNotAllowed: 'error_workspaceNotAllowed',
    }

    /**
     * 把错误整理成"字典键 + 原始细节"。
     *
     * 之所以要分开：git 的报错是英文长文（并含文件名），翻译它没有意义也不可靠；
     * 而"为什么失败、下一步该做什么"必须跟界面语言走。因此 host 返回稳定的 code，
     * 这里映射成字典键，由**组件内部**用 `t` 翻译。
     *
     * 注意本函数不自己翻译：它在组件外面，拿不到那里的 `t`（写成 `t(...)` 会抛
     * "t is not defined"，让整个插件加载失败）。
     *
     * @param cause - 捕获到的异常。
     * @returns `{ key, detail }`；`detail` 为空串表示没有可展示的原文。
     */
    function describeError(cause) {
      const code = cause?.code
      const detail = typeof cause?.detail === 'string' ? cause.detail : ''
      const known = typeof code === 'string' && Object.hasOwn(ERROR_KEYS, code)
      return { key: known ? ERROR_KEYS[code] : 'error_unknown', detail }
    }

    /**
     * 分支徽章 + 切换菜单。
     *
     * 用函数组件 + hooks 而不是类：与官方包的写法一致，且 hooks 的生命周期更容易和
     * 插件的 effect 对齐。
     * @param props - 槽注入的属性，其中 `t` 是按当前语言绑定的翻译函数。
     */
    function BranchChip(props) {
      // `t` 由槽的 inject 提供（ctx.locale.bind(NS)）。缺失时退化为原样返回键名，
      // 这样即使 locale 服务没挂上也不会崩。
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      // `sessionId` 与 `useSessions` 由渲染器按会话作用域自动注入（不需要自己写进
      // inject）——会话作用域的槽都会收到它们。
      const { sessionId, useSessions } = props ?? {}

      // 本会话的工作区。这是必须在**每个会话**里读的：用户可以在应用内为会话选择
      // 项目，它与外壳启动时的 `--workspace` 是两回事。用外壳那个会让徽章显示上一个
      // 仓库的分支（实测踩到过：外壳是 mmsm-amis、会话切到 scheduler-service-task，
      // 徽章却一直显示 mmsm-amis 的分支）。
      const workspace =
        typeof useSessions === 'function' && sessionId !== undefined
          ? useSessions((state) => state?.byId?.[sessionId]?.cwd)
          : undefined

      const [status, setStatus] = react.useState(null)
      const [branches, setBranches] = react.useState([])
      const [open, setOpen] = react.useState(false)
      const [busy, setBusy] = react.useState(false)
      /** 失败信息：`{ key, detail }`，key 是字典键。 */
      const [error, setError] = react.useState(null)
      /** 切换成功后的提示（例如"改动已存入 stash"）。 */
      const [notice, setNotice] = react.useState('')
      /**
       * 上一次尝试切换的目标分支。
       *
       * 失败时错误面板要给出「暂存并切换到 <分支>」按钮，就必须记住用户点的是哪一个
       * ——错误文本里只有文件名，没有分支名。
       */
      const [pendingBranch, setPendingBranch] = react.useState('')

      const refresh = react.useCallback(async () => {
        try {
          setStatus(await call('status', { cwd: workspace }))
          setError(null)
        } catch (cause) {
          setError(describeError(cause))
        }
        // 依赖 workspace：会话换了项目就要重新查，否则徽章会停在旧仓库的分支上。
      }, [workspace])

      // 首次拉取 + 定时对齐。
      react.useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) void refresh()
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [refresh])

      // 打开菜单时才拉分支列表：分支多的仓库列一次不便宜，而用户可能从不点它。
      react.useEffect(() => {
        if (!open) return undefined
        let alive = true
        void (async () => {
          try {
            const payload = await call('branches', { cwd: workspace })
            // host 侧返回的是对象数组：{ name, isRemote, current }。
            // 兼容旧的纯字符串形式，避免 host/client 版本不一致时列表整片消失。
            const raw = Array.isArray(payload?.branches) ? payload.branches : []
            if (alive) {
              setBranches(
                raw.map((item) =>
                  typeof item === 'string' ? { name: item, isRemote: false, current: false } : item,
                ),
              )
            }
          } catch (cause) {
            if (alive) setError(describeError(cause))
          }
        })()
        return () => {
          alive = false
        }
        // 依赖 workspace：会话换项目后，菜单里列出的必须是新仓库的分支。
      }, [open, workspace])

      const switchTo = react.useCallback(
        async (branch, options) => {
          setBusy(true)
          // 记下目标分支：失败时错误面板要靠它给出"暂存并切换到 X"的入口。
          setPendingBranch(branch)
          try {
            const next = await call('checkout', {
              cwd: workspace,
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(options?.stash === true ? { branch, stash: true } : { branch }),
            })
            setStatus(next)
            setError(null)
            // 暂存过就把 stash 位置告诉用户——否则他会以为改动丢了。
            setNotice(
              next?.stash?.stashed === true
                ? t('stashed', { ref: next.stash.ref })
                : '',
            )
            // 只有成功才关闭菜单。失败时保持打开，否则用户看不到原因、也不知道
            // 该重试哪个分支——实测中最常见的失败是有未提交改动（git 会拒绝覆盖）。
            setOpen(false)
          } catch (cause) {
            // 把 git 的原始拒绝原因给用户看，而不是替他 stash——那会动到他的工作区。
            setError(describeError(cause))
          } finally {
            setBusy(false)
          }
        },
        // 依赖 workspace：切换时必须对**当前会话**的工作区生效。
        [workspace],
      )

      // 重新打开菜单时清掉上一次的错误与提示：旧信息留到新一次尝试里只会造成混淆。
      const toggleOpen = react.useCallback(() => {
        setOpen((value) => {
          if (!value) {
            setError(null)
            setNotice('')
          }
          return !value
        })
      }, [])

      // 点击组件之外关闭菜单——这是标准交互，缺了它用户会觉得"弹框关不掉"。
      //
      // 用 mousedown 而不是 click：click 在 mouseup 之后才触发，中间可能已经有别的
      // 事情发生（例如拖选文本）。判定用"点击目标是否在容器内"，因此点菜单内部
      // 不会误关。
      //
      // 依赖数组里带 open：只在打开期间挂监听，关闭时立刻摘掉，不给文档留常驻监听。
      const containerRef = react.useRef(null)
      react.useEffect(() => {
        if (!open) return undefined

        const onPointerDown = (event) => {
          const node = containerRef.current
          if (node !== null && !node.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }

        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      if (status === null) {
        // 还没有数据时渲染 null 而不是占位骨架：这个位置空间很小，
        // 一个闪烁的骨架比"晚半秒出现"更惹眼。
        return null
      }

      if (!status.isRepo) return null

      const label = status.detached ? '(detached)' : status.branch || '(no branch)'
      const flags = []
      if (status.changedFiles > 0) flags.push(`*${status.changedFiles}`)
      if (status.ahead > 0) flags.push(`\u2191${status.ahead}`)
      if (status.behind > 0) flags.push(`\u2193${status.behind}`)

      return react.createElement(
        'div',
        // ref 用于"点击外部关闭"的判定：在这个容器内的点击不关菜单。
        { ref: containerRef, style: { position: 'relative', display: 'inline-flex' } },
        react.createElement(
          'button',
          {
            type: 'button',
            title: error === null ? `Git: ${label}${flags.length ? ' ' + flags.join(' ') : ''}` : error,
            onClick: toggleOpen,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0 8px',
              height: '28px',
              borderRadius: '6px',
              border: `1px solid ${error === null ? '#3d3d45' : '#6b3b3b'}`,
              background: '#2a2a31',
              color: error === null ? '#c8c8d0' : '#e6b0b0',
              fontSize: '12px',
              fontFamily: 'ui-monospace, Consolas, monospace',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            },
          },
          // 分支图标：一个极小的分叉符号，避免依赖图标库。
          react.createElement(
            'svg',
            { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            react.createElement('path', {
              d: 'M4.5 2.5v8.2M4.5 10.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6ZM11.5 2.5v3a2.6 2.6 0 0 1-2.6 2.6H4.5M11.5 2.5a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4Z',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
            }),
          ),
          react.createElement('span', null, label),
          flags.length > 0 ? react.createElement('span', { style: { opacity: 0.7 } }, flags.join(' ')) : null,
        ),

        open
          ? react.createElement(
              'div',
              {
                style: {
                  // fixed 而不是 absolute：absolute 相对工具栏里那个小容器定位，会被
                  // 输入框卡片的可视区域裁掉（小窗口里只能看到顶部一条）。fixed 相对
                  // 视口定位，跳出祖先裁剪；高度也用 viewport 约束，避免在大分支列表时
                  // 溢出屏幕。
                  position: 'fixed',
                  bottom: 'clamp(72px, 12vh, 140px)',
                  left: 'clamp(12px, 3vw, 40px)',
                  zIndex: 9999,
                  minWidth: '220px',
                  maxWidth: 'min(420px, calc(100vw - 24px))',
                  maxHeight: 'min(300px, calc(100vh - 200px))',
                  overflowY: 'auto',
                  borderRadius: '8px',
                  border: '1px solid #3d3d45',
                  background: '#232329',
                  boxShadow: '0 8px 24px rgba(0,0,0,.45)',
                  padding: '4px',
                },
              },
              react.createElement(
                'div',
                {
                  style: {
                    padding: '6px 8px',
                    fontSize: '11px',
                    color: '#8a8a93',
                    borderBottom: '1px solid #2f2f36',
                    marginBottom: '4px',
                  },
                },
                busy ? t('switching') : t('switchBranch'),
              ),

              // 失败原因必须显示在菜单里。原先只写进按钮的 hover 提示，而菜单照常
              // 关闭——用户看到的就是"点了没反应"。
              error === null
                ? null
                : react.createElement(
                    'div',
                    {
                      style: {
                        margin: '0 4px 6px',
                        padding: '7px 9px',
                        borderRadius: '6px',
                        background: '#3a2626',
                        border: '1px solid #6b3b3b',
                        color: '#f0c8c8',
                        fontSize: '11.5px',
                        lineHeight: 1.5,
                        wordBreak: 'break-word',
                        maxHeight: '150px',
                        overflowY: 'auto',
                      },
                    },
                    // 第一行是本地化短句（跟界面语言走）。
                    react.createElement('div', null, t(error.key)),
                    // 下面是 git 的英文原文：它是权威信息，翻译反而失真，所以原样显示。
                    // 用等宽字体 + 保留换行，多行报错才读得清。
                    error.detail === ''
                      ? null
                      : react.createElement(
                          'div',
                          {
                            style: {
                              marginTop: '5px',
                              paddingTop: '5px',
                              borderTop: '1px solid #4a3030',
                              fontFamily: 'ui-monospace, Consolas, monospace',
                              fontSize: '10.5px',
                              color: '#d8a8a8',
                              whiteSpace: 'pre-wrap',
                            },
                          },
                          error.detail,
                        ),
                    react.createElement(
                      'div',
                      { style: { marginTop: '5px', color: '#c9a0a0' } },
                      t('hintCommitOrStash'),
                    ),
                    // 只在"因未提交改动而被拒"时给出暂存入口：其它失败（例如目标分支
                    // 不存在）暂存也解决不了，给按钮反而误导。
                    // 判据用 host 的稳定 code，而不是去正则匹配 git 的英文原文——
                    // 后者在不同 git 版本/locale 下会变，且把语言绑死在断定逻辑里。
                    error.key === 'error_localChanges'
                      ? react.createElement(
                          'button',
                          {
                            type: 'button',
                            disabled: busy,
                            onClick: () => void switchTo(pendingBranch, { stash: true }),
                            style: {
                              marginTop: '7px',
                              width: '100%',
                              padding: '6px 8px',
                              borderRadius: '5px',
                              border: '1px solid #6b3b3b',
                              background: '#4a2f2f',
                              color: '#f0d0d0',
                              font: '11.5px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
                              cursor: busy ? 'default' : 'pointer',
                            },
                          },
                          busy ? t('stashing') : t('stashAndSwitch', { branch: pendingBranch }),
                        )
                      : null,
                  ),

              // 切换成功后的提示（stash 位置）。放在错误区之外，因为它是成功结果。
              notice === ''
                ? null
                : react.createElement(
                    'div',
                    {
                      style: {
                        margin: '0 4px 6px',
                        padding: '6px 9px',
                        borderRadius: '6px',
                        background: '#243a2a',
                        border: '1px solid #35603f',
                        color: '#b6e0c2',
                        fontSize: '11.5px',
                        lineHeight: 1.5,
                      },
                    },
                    notice,
                  ),

              branches.length === 0
                ? react.createElement(
                    'div',
                    { style: { padding: '6px 8px', fontSize: '12px', color: '#8a8a93' } },
                    t('noBranches'),
                  )
                : branches.map((branch) =>
                    react.createElement(
                      'button',
                      {
                        key: `${branch.isRemote ? 'r:' : 'l:'}${branch.name}`,
                        type: 'button',
                        disabled: busy || branch.current,
                        onClick: () => void switchTo(branch.name),
                        title: branch.isRemote ? t('remoteBranch') : t('localBranch'),
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          width: '100%',
                          textAlign: 'left',
                          padding: '6px 8px',
                          border: 'none',
                          borderRadius: '5px',
                          background: branch.current ? '#2d4a7c' : 'transparent',
                          color: branch.current ? '#cfe0ff' : '#d8d8de',
                          font: '12px ui-monospace, Consolas, monospace',
                          cursor: busy || branch.current ? 'default' : 'pointer',
                        },
                      },
                      // 远程分支加一个标记，否则 `origin/x` 与本地 `x` 在列表里难以区分。
                      branch.isRemote
                        ? react.createElement('span', { style: { opacity: 0.55, fontSize: '10px' } }, 'R')
                        : null,
                      react.createElement('span', null, branch.name),
                    ),
                  ),
            )
          : null,
      )
    }

    /**
     * 挂载插件。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      // 注册两套字典。与官方客户端插件同一做法：`locale` 是已提供的服务，
      // 字典挂在自定义命名空间下，`ctx.locale.bind(NS)` 得到按当前语言解析的 `t`。
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gitbar: dictionaries')

      // `slots.inject` 保证目标槽已声明；返回的函数是注销器，交给 `ctx.effect`
      // 绑定到插件生命周期——插件卸载时徽章自动消失。这是官方包一致的写法。
      // 这是 list 槽，注册项必须带 `id`（只有 `key` 会被拒绝：
      // "list slot ... requires options.id"）。`order` 决定它在列表中的位置。
      //
      // `locale: NS` 让槽知道本组件用哪个命名空间的字典；`inject` 里的 `t` 是
      // 按当前语言绑定的翻译函数，会作为 props 传给组件（官方 directory-picker 同此写法）。
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
              BranchChip,
            ),
          ),
        'dsh-client-ui-gitbar: branch chip',
      )
    }

    exports.name = name
    exports.apply = apply
    // 必须声明 inject：cordis 的服务是懒解析的，不声明就直接读 `ctx.slots` 会抛
    // "cannot get property \"slots\" without inject"，而且这个错误会让**整个界面**
    // 渲染失败（不只是本插件）——排查时页面是全白的，误导性很强。
    // `locale` 同理：不声明就取不到 `ctx.locale.register`。
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
