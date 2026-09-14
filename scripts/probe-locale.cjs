// Probe: what locale APIs report on this machine, and whether `-e` even works.
const { app } = require('electron')

app.whenReady().then(() => {
  console.log('[locale] getLocale                =', app.getLocale())
  console.log('[locale] getSystemLocale          =', app.getSystemLocale())
  console.log('[locale] getPreferredSystemLangs  =', JSON.stringify(app.getPreferredSystemLanguages()))
  console.log('[locale] getApplicationLocale     =', app.getApplicationLocale?.())
  console.log('[locale] getAppPath               =', app.getAppPath())
  app.exit(0)
})
