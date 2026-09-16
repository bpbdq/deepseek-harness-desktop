import z from '@deepseek-ai/schemastery'

export const name = 'ui-typography'
export const NAMESPACE = 'desktop-ui-typography'
export const SettingsSchema = z.object({
  fontSize: z.number().step(1).min(12).max(20).default(14),
})

export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NAMESPACE, SettingsSchema)
  })
  // The Host settings document survives restarts, port changes and workspace switches.
  ctx.on('webserver/index-inject', (table) => {
    const size = ctx.get('settings')?.get(NAMESPACE)?.fontSize ?? 14
    table.push({
      kind: 'script',
      placement: 'body',
      text: `document.documentElement.dataset.dshUiFontSize = ${JSON.stringify(String(size))}`,
    })
  })
}
