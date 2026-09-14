// Probe: does the tray icon actually get created from the shipped PNG?
// Run with: npx electron scripts/probe-tray.cjs
const { app, Tray, nativeImage, Menu } = require('electron')
const { join } = require('node:path')

app.whenReady().then(() => {
  const iconPath = join(__dirname, '..', 'build', 'icon.png')
  const image = nativeImage.createFromPath(iconPath)
  console.log('[probe] createFromPath empty =', image.isEmpty(), 'size =', JSON.stringify(image.getSize()))

  const resized = image.resize({ width: 16, height: 16 })
  console.log('[probe] resize empty =', resized.isEmpty(), 'size =', JSON.stringify(resized.getSize()))

  try {
    const tray = new Tray(resized)
    tray.setToolTip('probe')
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'probe item' }]))
    console.log('[probe] Tray constructed OK; visible =', !tray.isDestroyed())
  } catch (error) {
    console.log('[probe] Tray FAILED:', error.message)
  }

  setTimeout(() => app.exit(0), 6000)
})
