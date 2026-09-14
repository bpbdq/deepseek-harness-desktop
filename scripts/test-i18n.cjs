// Unit check for the shell locale mapping. Run: node scripts/test-i18n.cjs
const i18n = require('../dist/main/i18n.js')

let allPass = true
function check(locale, expectedMenuUpdate) {
  const catalog = i18n.catalogFor(locale)
  const pass = catalog.menuUpdate === expectedMenuUpdate
  if (!pass) allPass = false
  const label = locale === undefined ? 'undefined' : JSON.stringify(locale)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(14)} -> menuUpdate=${JSON.stringify(catalog.menuUpdate)}`)
}

// Chinese locales must all resolve to the Chinese catalog.
check('zh-CN', '更新')
check('zh-Hans-CN', '更新')
check('zh-TW', '更新')
check('zh', '更新')
// Everything else falls back to English.
check('en-US', 'Update')
check('de-DE', 'Update')
check('', 'Update')
check(undefined, 'Update')

const zh = i18n.catalogFor('zh-CN')
console.log('\nChinese samples:')
for (const key of ['menuFile', 'menuEdit', 'menuView', 'menuHelp', 'itemCheckUpdates', 'trayQuit', 'updateUpToDateTitle']) {
  console.log(`  ${key.padEnd(24)} ${zh[key]}`)
}

console.log('\nPlaceholder rendering:')
console.log('  ' + i18n.format(zh.updateAvailableTitle, { version: '0.1.5-rc.3' }))

// Every key must exist in both catalogs, or a lookup renders "undefined" in the UI.
const en = i18n.catalogFor('en')
const missing = Object.keys(en).filter((key) => typeof zh[key] !== 'string')
console.log(`\nKey parity en/zh: ${missing.length === 0 ? 'OK' : 'MISSING ' + missing.join(', ')}`)
if (missing.length > 0) allPass = false

console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES'}`)
process.exit(allPass ? 0 : 1)
