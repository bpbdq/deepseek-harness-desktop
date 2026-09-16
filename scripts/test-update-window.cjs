// Exercise the generated update page in Electron, including its sandboxed preload.
// Run with: npm run build && node scripts/test-update-window.cjs
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], {
    cwd: resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
    timeout: 30_000,
    windowsHide: true,
  })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow } = require('electron')
const { openUpdateWindow } = require('../dist/main/update-window')
const directory = mkdtempSync(join(tmpdir(), 'dsh-update-window-test-'))
app.setPath('userData', directory)
app.disableHardwareAcceleration()

const strings = {
  title: 'Update test', checking: 'Checking', sectionRuntime: 'Runtime', sectionShell: 'Shell',
  stateLatest: 'Up to date', stateAvailable: 'Available', stateUnknown: 'Unavailable',
  installedLabel: 'Installed', latestLabel: 'Latest', detailLabel: 'Details', buttonClose: 'Close',
  buttonRuntime: 'Update runtime', buttonShell: 'Update shell', shellUnavailable: 'Cannot install',
  shellProgress: 'Downloading {percent}%', buttonDownloading: 'Downloading {percent}%',
  shellFailedTitle: 'Update failed', runtimeLatestLabel: 'Channel version', shellLatestLabel: 'Release version',
}

async function run() {
  await app.whenReady()
  const parent = new BrowserWindow({ show: false })
  const actions = []
  const panel = openUpdateWindow(parent, directory, strings, action => actions.push(action))
  panel.window.hide()
  const contents = panel.window.webContents
  const errors = []
  contents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })

  const loaded = new Promise(resolve => contents.once('did-finish-load', resolve))
  // Both initial data and a fast check result can arrive before the page subscribes.
  panel.update({
    runtime: { installed: '0.1.5-rc.1', state: 'checking' },
    shell: { installed: '1.2.0', state: 'checking' },
    shellCanInstall: false,
  })
  const state = {
    runtime: { installed: '0.1.5-rc.1', latest: '0.1.5-rc.2', state: 'available' },
    shell: { installed: '1.2.0', state: 'unknown', reason: 'Development mode' },
    shellCanInstall: false,
  }
  panel.update(state)
  await loaded

  async function snapshot() {
    return contents.executeJavaScript(`(() => {
      const get = id => document.getElementById(id);
      return {
        installed: get('runtime-installed').textContent,
        latest: get('runtime-latest').textContent,
        status: get('runtime-status').textContent,
        shellInstalled: get('shell-installed').textContent,
        shellReason: get('shell-note').textContent,
        shellNoteHidden: get('shell-note').hidden,
        runtimeHidden: get('btn-runtime').hidden,
        runtimeDisabled: get('btn-runtime').disabled,
        runtimeText: get('btn-runtime').textContent,
        shellHidden: get('btn-shell').hidden,
        shellDisabled: get('btn-shell').disabled,
        shellText: get('btn-shell').textContent,
        progressHidden: get('progress-wrap').hidden,
        progress: get('progress-bar').style.width,
      };
    })()`)
  }

  // IPC delivery is asynchronous; wait for the observable DOM state, with a bound.
  async function expect(label, predicate) {
    const deadline = Date.now() + 2000
    let actual
    do {
      actual = await snapshot()
      if (predicate(actual)) {
        console.log(`PASS ${label}`)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    assert.fail(`${label}: ${JSON.stringify(actual)}; renderer errors: ${errors.join('; ')}`)
  }

  await expect('preload receives the latest state sent before page load', s =>
    s.installed === '0.1.5-rc.1' && s.latest === '0.1.5-rc.2' && s.status === 'Available' &&
    s.shellInstalled === '1.2.0' && s.shellReason === 'Development mode' && !s.shellNoteHidden &&
    !s.runtimeHidden && s.shellHidden)

  for (const percent of [0, 42]) {
    panel.update({ ...state, runtimeProgress: percent })
    await expect(`runtime progress ${percent}% is visible`, s =>
      !s.progressHidden && s.progress === `${percent}%` && s.runtimeDisabled &&
      s.runtimeText === `Downloading ${percent}%`)
  }

  const shellState = {
    ...state,
    shell: { installed: '1.2.0', latest: '1.2.1', state: 'available' },
    shellCanInstall: true,
  }
  panel.update({ ...shellState, shellProgress: 65 })
  await expect('shell progress is visible and clears the previous reason', s =>
    !s.progressHidden && s.progress === '65%' && !s.shellHidden && s.shellDisabled &&
    s.shellText === 'Downloading 65%' && s.shellNoteHidden && !s.runtimeDisabled)

  panel.update(shellState)
  await expect('finishing a download resets progress and buttons', s =>
    s.progressHidden && !s.runtimeDisabled && !s.shellDisabled &&
    s.runtimeText === 'Update runtime' && s.shellText === 'Update shell')

  const reloaded = new Promise(resolve => contents.once('did-finish-load', resolve))
  contents.reload()
  await reloaded
  await expect('reloading restores the latest update state', s =>
    s.installed === '0.1.5-rc.1' && !s.shellHidden && s.progressHidden)

  await contents.executeJavaScript("document.getElementById('btn-close').click()")
  const actionDeadline = Date.now() + 2000
  while (actions.length === 0 && Date.now() < actionDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.deepEqual(actions, ['close'])
  assert.deepEqual(errors, [])
  console.log('PASS close button sends its action; no renderer errors')
}

run().then(() => finish(0), error => { console.error(error); finish(1) })

function finish(code) {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  // Electron can still hold cache files open on Windows until the process exits.
  try {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    rmSync(directory, { recursive: true, force: true })
  } catch {}
  app.exit(code)
}
