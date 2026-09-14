// gitbar 的客户端半边。
//
// 这个文件刻意手写，不引入打包链：客户端 bundle 的契约很简单——
// 调用 shell 提供的 `window.__ModuleLoader__.load({ id, factory })`，在 factory
// 里 require shell 的共享模块表（react 等基线模块）并导出插件的应用函数。
// 官方包（如 dsh-client-ui-sidebar-files/lib/client.js）用的就是这个格式。
//
// 本阶段只做一件事：往 `conversation.input.right` 插一个静态徽章，验证
// "第三方客户端插件能否渲染进输入框工具栏"。数据接入与切换分支在验证通过后加。
window.__ModuleLoader__.load({
  id: 'dsh-client-ui-gitbar',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    /** 稳定的插件名，用于注册与诊断。 */
    const name = 'dsh-client-ui-gitbar'

    /** 输入框工具栏右侧，发送按钮之前。 */
    const SLOT = 'conversation.input.right'

    /** 这个占位徽章的注册 key。 */
    const KEY = 'dsh-client-ui-gitbar:chip'

    /**
     * 占位徽章：仅用于验证扩展位可用。
     *
     * 用 `react.createElement` 而不是 JSX：手写 bundle 里没有编译步骤，
     * createElement 免掉一次转译，也让"没有隐藏依赖"这件事在代码里可见。
     */
    function GitBadge() {
      return react.createElement(
        'span',
        {
          title: 'gitbar 占位：扩展位连通性验证',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '0 8px',
            height: '28px',
            borderRadius: '6px',
            border: '1px solid #3d3d45',
            background: '#2a2a31',
            color: '#cfe0ff',
            fontSize: '12px',
            fontFamily: 'ui-monospace, Consolas, monospace',
            whiteSpace: 'nowrap',
          },
        },
        'gitbar OK',
      )
    }

    /**
     * 挂载插件。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      // `slots.inject` 保证依赖的槽已声明；`effect` 把注册的生命周期绑到插件上，
      // 插件卸载时自动撤销——这是官方包一致使用的写法。
      ctx.effect(
        () => ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, key: KEY }, GitBadge)),
        'dsh-client-ui-gitbar: chip',
      )
    }

    exports.name = name
    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
