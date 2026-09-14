// Capture the main window to a PNG so layout/menu-bar claims can be verified
// instead of assumed. Build-machine helper; not shipped.
//   npx electron scripts/capture-window.cjs <out.png> [waitMs]
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

const out = resolve(process.argv[2] ?? 'window.png')
const waitMs = Number(process.argv[3] ?? 6000)

app.whenReady().then(() => {
  setTimeout(async () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) {
      console.log('[capture] no window')
      app.exit(1)
      return
    }
    const image = await window.capturePage()
    if (image.isEmpty()) {
      console.log('[capture] empty image')
      app.exit(1)
      return
    }
    writeFileSync(out, image.toPNG())
    console.log(`[capture] wrote ${out} ${JSON.stringify(image.getSize())}`)
    app.exit(0)
  }, waitMs)
})
