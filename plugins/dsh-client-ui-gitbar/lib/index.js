/**
 * gitbar 的 host 半边。
 *
 * 目前是空实现：这一个阶段只验证客户端半边能否渲染进输入框工具栏。
 * 提供 git 数据与切换能力需要注册 webServer 路由，放到验证通过之后再加——
 * 先确认最高风险的一环（客户端 bundle 能否加载并落到正确的扩展位）。
 */
export const name = 'dsh-client-ui-gitbar'

/** 不依赖任何服务，纯 UI 插件。 */
export const inject = []

/** 目前不需要 host 侧行为。 */
export function apply() {
  // 有意为空。
}
