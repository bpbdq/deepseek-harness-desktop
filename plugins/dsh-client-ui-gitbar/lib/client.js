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

    /** 状态轮询间隔：分支会在外部被切换（终端里 git checkout），所以要定期对齐。 */
    const POLL_MS = 15000

    /**
     * 请求 host 侧的 git 路由。
     * @param path - 相对 API 前缀的路径，如 'status'。
     * @param init - 可选的 fetch 选项。
     * @returns 解析后的 JSON；失败时抛出。
     */
    async function call(path, init) {
      const response = await fetch(`${API}/${path}`, {
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
      if (!response.ok) throw new Error(payload?.detail ?? payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    /**
     * 分支徽章 + 切换菜单。
     *
     * 用函数组件 + hooks 而不是类：与官方包的写法一致，且 hooks 的生命周期更容易和
     * 插件的 effect 对齐。
     */
    function BranchChip() {
      const [status, setStatus] = react.useState(null)
      const [branches, setBranches] = react.useState([])
      const [open, setOpen] = react.useState(false)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
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
          setStatus(await call('status'))
          setError('')
        } catch (cause) {
          setError(String(cause.message ?? cause))
        }
      }, [])

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
            const payload = await call('branches')
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
            if (alive) setError(String(cause.message ?? cause))
          }
        })()
        return () => {
          alive = false
        }
      }, [open])

      const switchTo = react.useCallback(
        async (branch, options) => {
          setBusy(true)
          // 记下目标分支：失败时错误面板要靠它给出"暂存并切换到 X"的入口。
          setPendingBranch(branch)
          try {
            const next = await call('checkout', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(options?.stash === true ? { branch, stash: true } : { branch }),
            })
            setStatus(next)
            setError('')
            // 暂存过就把 stash 位置告诉用户——否则他会以为改动丢了。
            setNotice(
              next?.stash?.stashed === true
                ? `改动已存入 stash ${next.stash.ref}，可用 git stash pop 恢复`
                : '',
            )
            // 只有成功才关闭菜单。失败时保持打开，否则用户看不到原因、也不知道
            // 该重试哪个分支——实测中最常见的失败是有未提交改动（git 会拒绝覆盖）。
            setOpen(false)
          } catch (cause) {
            // 把 git 的原始拒绝原因给用户看，而不是替他 stash——那会动到他的工作区。
            setError(String(cause.message ?? cause))
          } finally {
            setBusy(false)
          }
        },
        [],
      )

      // 重新打开菜单时清掉上一次的错误与提示：旧信息留到新一次尝试里只会造成混淆。
      const toggleOpen = react.useCallback(() => {
        setOpen((value) => {
          if (!value) {
            setError('')
            setNotice('')
          }
          return !value
        })
      }, [])

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
        { style: { position: 'relative', display: 'inline-flex' } },
        react.createElement(
          'button',
          {
            type: 'button',
            title: error === '' ? `Git: ${label}${flags.length ? ' ' + flags.join(' ') : ''}` : error,
            onClick: toggleOpen,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0 8px',
              height: '28px',
              borderRadius: '6px',
              border: `1px solid ${error === '' ? '#3d3d45' : '#6b3b3b'}`,
              background: '#2a2a31',
              color: error === '' ? '#c8c8d0' : '#e6b0b0',
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
                  position: 'absolute',
                  bottom: '34px',
                  left: 0,
                  zIndex: 50,
                  minWidth: '220px',
                  maxHeight: '300px',
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
                busy ? '切换中…' : '切换分支',
              ),

              // 失败原因必须显示在菜单里。原先只写进按钮的 hover 提示，而菜单照常
              // 关闭——用户看到的就是"点了没反应"。
              error === ''
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
                        // git 的报错是多行文本，保留换行才有可读性。
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        maxHeight: '130px',
                        overflowY: 'auto',
                      },
                    },
                    error,
                    react.createElement(
                      'div',
                      { style: { marginTop: '5px', color: '#c9a0a0' } },
                      '提交这些改动，或用下方的「暂存并切换」。',
                    ),
                    // 只在"因未提交改动而被拒"时给出暂存入口：其它失败（例如目标分支
                    // 不存在）暂存也解决不了，给按钮反而误导。
                    /local changes|would be overwritten/iu.test(error)
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
                          busy ? '暂存并切换中…' : `暂存改动并切换到 ${pendingBranch}`,
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
                    '没有可切换的分支',
                  )
                : branches.map((branch) =>
                    react.createElement(
                      'button',
                      {
                        key: `${branch.isRemote ? 'r:' : 'l:'}${branch.name}`,
                        type: 'button',
                        disabled: busy || branch.current,
                        onClick: () => void switchTo(branch.name),
                        title: branch.isRemote ? '远程分支（切换时会自动创建本地跟踪分支）' : '本地分支',
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
      // `slots.inject` 保证目标槽已声明；返回的函数是注销器，交给 `ctx.effect`
      // 绑定到插件生命周期——插件卸载时徽章自动消失。这是官方包一致的写法。
      // 这是 list 槽，注册项必须带 `id`（只有 `key` 会被拒绝：
      // "list slot ... requires options.id"）。`order` 决定它在列表中的位置。
      ctx.effect(
        () =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register({ name: SLOT, id: ID, order: ORDER }, BranchChip),
          ),
        'dsh-client-ui-gitbar: branch chip',
      )
    }

    exports.name = name
    exports.apply = apply
    // 必须声明 inject：cordis 的服务是懒解析的，不声明就直接读 `ctx.slots` 会抛
    // "cannot get property \"slots\" without inject"，而且这个错误会让**整个界面**
    // 渲染失败（不只是本插件）——排查时页面是全白的，误导性很强。
    exports.inject = ['slots']
    return module.exports
  },
})
