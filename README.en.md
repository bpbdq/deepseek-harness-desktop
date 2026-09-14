# dsh-desktop

**English (this page) | [中文文档](README.md)**

A desktop client for **DeepSeek Harness (`dsh`)**.

It bundles the official agent runtime, so an end user needs **no Node.js and no
npm**: install the app, launch it, use the full harness. The official Web UI is
reused verbatim, which means everything `dsh web` has — tools, sandboxing,
sessions, jobs, subagents, workflows, skills, MCP — plus what only a desktop shell
can add: a real window, a tray that keeps long-running work alive, OS-keychain
credentials, and self-updating of the agent runtime.

[![release](https://img.shields.io/badge/release-GitHub%20Releases-blue)](../../releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## Why this design

Three facts from the official `@deepseek-ai/dsh` package drive the whole
architecture. They are findings, not preferences:

| Finding | Source | Consequence |
|---|---|---|
| The `desktop` profile name is *reserved for the Electron application* | `dsh/README.md:20`, and `dsh/lib/bin.js:29` refuses it | We are the intended owner of a profile named `desktop`. We do not patch or fork `dsh`. |
| `loadProfileDirectory()` exists for *"application-owned profiles whose package project and lifecycle belong to that application"* | `@deepseek-ai/dsh-app-boot` | The app boots the tree through public APIs; it never shells out to the `dsh` CLI. |
| `dsh web` accepts `--no-open` and `--port 0` | `@deepseek-ai/dsh-web-app/lib/startup.js` | The shell owns the window and lets the OS pick a free port. |

The runtime also needs **Node 22.13+/24** (`zlib.createZstdCompress`,
`util.getSystemErrorMessage`, `module.stripTypeScriptTypes`) — newer than the Node
inside Electron 33. So a pinned portable Node ships next to Electron rather than
being borrowed from it.

---

## Features

Inherited from the official Web UI (because that UI *is* what runs inside the window):

- Every tool: file read/write, search, PowerShell/Bash, web search and fetch, subagents, workflows, Ralph loops, goals, skills, MCP
- Filesystem sandboxing and permission presets
- Session persistence and resume, background jobs, schedules
- **Right sidebar**: workspace file tree + document preview (Markdown, code, images, PDF, HTML), with line-level jumps from tool output
- **Open In…**: open the workspace in an editor, terminal, or file manager
- Chinese and English UI, following the system language

Added by the shell:

- A real desktop window with remembered geometry
- **A tray that keeps work alive** — goals, background jobs, and subagents keep running after the window closes
- Automatic discovery and installation of newer agent runtimes, with automatic rollback
- Credentials encrypted with the OS keychain (DPAPI / Keychain / libsecret)
- A separate harness home, so a command-line `dsh` install can coexist untouched
- Native directory picker, native menus, single instance, external links to the real browser

---

## Download

Grab the file for your platform from [Releases](../../releases).

| Platform | File |
|---|---|
| Windows | `DeepSeek Harness-<version>-x64.exe` (NSIS installer) |
| Windows | `DeepSeek Harness-<version>-x64.msi` (managed deployment) |
| Linux | `DeepSeek Harness-<version>-x64.AppImage`, `.deb`, `.rpm` |
| macOS | `DeepSeek Harness-<version>-x64.dmg` (Intel) |
| macOS | `DeepSeek Harness-<version>-arm64.dmg` (Apple silicon) |

macOS builds are **unsigned**, so Gatekeeper quarantines them. Open once via
**right-click → Open**, or clear the flag:

```bash
xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
```

### Installer language

The installer UI language differs per platform, because only one platform has an
installer UI to localize:

| Platform | Installer | Language |
|---|---|---|
| Windows `setup.exe` | NSIS wizard | **Simplified Chinese** |
| Windows `.msi` | Windows Installer wizard | English (see below) |
| Linux `.deb` / `.rpm` / AppImage | none — `dpkg -i`, or run directly | n/a |
| macOS `.dmg` | none — drag to Applications | n/a |

The NSIS installer is pinned to Simplified Chinese via two options in
`electron-builder.yml`:

```yaml
nsis:
  language: 2052               # LCID decimal, NOT a language name
  installerLanguages: [zh_CN]  # language name, mapped to NSIS's SimpChinese
```

The MSI remains English: electron-builder's MsiTarget exposes no language option,
and the WiX toolchain it fetches ships `WixUIExtension.dll` without any localized
`.wxl` files. A Chinese MSI would need a custom WiX UI extension; not implemented.

> That is the **installer** language. The installed app's own UI is a separate
> mechanism — it follows the system language (Chinese/English) and is controlled by
> `src/main/i18n.ts`.

On first launch the app asks for an API key. It is encrypted with the OS keychain
into this app's own data directory — never written as plaintext.

---

## Where "check for updates" lives

The official web UI has no such control; it is shell-level, so it lives in the
shell's own chrome:

| Surface | Entry |
|---|---|
| Window menu bar | **Update → Check for Agent Runtime Updates…** (`Ctrl+Shift+U`) |
| Window menu bar | Help → Check for Agent Runtime Updates… |
| Tray icon (right-click) | Check for runtime updates… |

The menu bar is deliberately **not** auto-hidden: the runtime update is only
user-reachable from there.

---

## Architecture

```
Electron main process                        dsh server child process
──────────────────────────                   ─────────────────────────
single-instance gate                         cwd            = user workspace
window / tray / menu / deep links            DSH_HOME       = <userData>/home
credential decryption (OS keychain)          profile        = desktop
runtime updater                              bundles        = dsh-base + dsh-web-app
      │                                             │
      │  spawn (pinned Node)                        │  loadProfileDirectory()
      └────────────────────────────────────────────►│  healProfilesModuleFallback()
                                                    │  boot() + provideCmdline()
      ◄──── stdout: "dsh web: http://127.0.0.1:PORT/?token=…"
      ◄──── stdout: "[dsh-desktop] ready"
```

Everything that executes agent code lives in the child process, so a crashed or
OOM-killed agent never takes the window down.

Each server process mints a random launch token, accepted **only** on `GET /`,
where it is exchanged for a signed HttpOnly cookie before redirecting to a clean
`/`. The window loads the token URL exactly once, so no credential stays in the
address bar.

`runtime/` must stay outside `app.asar`: the harness creates real directory
junctions at boot, spawns native helpers, and loads native addons by path.

**The boot script must run from `<runtime>/server.mjs`**, not from
`resources/server/`. Node resolves bare specifiers upward from the *script's own
directory*, so the shipped copy under `resources/server/` walks up to the drive
root and dies with `ERR_MODULE_NOT_FOUND` on install paths such as
`D:\Program Files\…`. The main process copies it beside the runtime's
`node_modules` before spawning.

---

## Building

Node 20+ and npm are needed on the **build machine only**.

```bash
npm install
npm run stage      # stage the dsh runtime and the pinned Node
npm run icon       # generate build/icon.png (replace with real branding)
npm run dist:win   # Windows: setup.exe + .msi
```

Or use the batch wrappers on Windows:

```bat
build.bat          Windows (setup.exe + .msi)
build.bat msi      only the .msi
build.bat linux    prints why Linux cannot be built on Windows
build.bat mac      prints why macOS cannot be built on Windows
build.bat clean    wipe dist and the current version dir, then a full Windows build
build.bat help     full usage
```

#### Artifacts are grouped per version

One directory per version, and **no version number in the file names**:

```
release/
  1.0.0/
    DeepSeek Harness-x64.exe          <- NSIS installer
    DeepSeek Harness-x64.exe.blockmap
    DeepSeek Harness-x64.msi
    latest.yml                        <- electron-updater metadata
  1.0.1/
    ...
  latest.txt                          <- names the newest version directory
```

Multiple versions coexist per platform without overwriting each other, and download
URLs stay stable across releases instead of changing with the version.

`build.bat clean` clears **only the current version directory**, never the others —
that is the point of splitting them.

### Per-platform buildability (verified, not assumed)

| Target | Buildable on Windows | Why |
|---|---|---|
| `setup.exe` (NSIS) | ✅ | |
| `.msi` | ✅ | needs WiX; electron-builder fetches it automatically |
| `.AppImage` | ❌ | needs the Linux `mksquashfs`; fails with `appimage-12.0.1/linux-x64/mksquashfs: file does not exist` |
| `.deb` / `.rpm` | ❌ | needs `fpm`; fails with `fpm: executable file not found in %PATH%` |
| `.dmg` / `.zip` (macOS) | ❌ | needs `hdiutil` / `codesign` / `productbuild`, which exist only on macOS |

**Linux and macOS artifacts cannot be produced on Windows** — missing toolchain,
not configuration. `build.bat linux` and `build.bat mac` stop immediately and print
the alternatives instead of downloading hundreds of megabytes before failing.

Use [`.github/workflows/release.yml`](.github/workflows/release.yml), which builds
all three platforms on their own runners.

---

## Versioning

Versions live in `package.json` (`package-lock.json` is kept in sync, otherwise
`npm ci` fails); `electron-builder` reads them from there and uses them in the
artifact directory name.

### Packaging bumps automatically

**Every `build.bat` increments the version by one**, so consecutive builds land in
their own directories:

```
build.bat   ->  1.0.0 -> release/1.0.0/
build.bat   ->  1.0.1 -> release/1.0.1/
build.bat   ->  1.0.2 -> release/1.0.2/
```

The increment rule carries into the minor version after patch `.9`:

```
1.0.0 -> 1.0.1 -> ... -> 1.0.8 -> 1.0.9 -> 1.1.0 -> 1.1.1 -> ...
```

**Rebuild without changing the version**: pass `--no-bump` (useful after editing
packaging configuration and wanting to re-verify the same version).

```bat
build.bat win --no-bump
```

**Debugging does not burn version numbers**: repeated builds within 5 minutes do not
increment again. Use `version.bat next --force` to bypass that.

### Manual control

```bat
version.bat              show current and next version
version.bat next         bump (subject to the 5-minute throttle)
version.bat next --force bump regardless of the throttle
version.bat list         list the release sequence
version.bat 1.0.3        set explicitly
```

Check that all three places agree (a mismatch breaks CI's `npm ci`):

```bat
node scripts\check-version.mjs
```

A typical local build and release:

```bat
build.bat                          :: bumps the version and packages into release\<new version>\
git add -A && git commit -m "release v1.0.1"
git tag v1.0.1 && git push origin v1.0.1
```

Pushing a `v*` tag makes GitHub Actions build all three platforms and **publish** the
Release directly (not a draft). CI takes the version from `package.json` at the tagged
commit, so the tag name should match it.

> Note: `build.bat` bumps the version, so the version produced locally is normally the
> one you tag. Do not build locally again after tagging, or the version advances while
> the tag still points at the old one.

### Before publishing

1. `publish.owner` / `publish.repo` in
   [`electron-builder.yml`](electron-builder.yml) are already set to this
   repository, so pushing a `v*` tag publishes directly.
2. For signed builds, add repository secrets: `MAC_CERT_P12`,
   `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`.

Unsigned builds work fine but trigger SmartScreen (Windows) and Gatekeeper (macOS).

---

## Project layout

| Path | Role |
|---|---|
| `src/main/index.ts` | lifecycle: single instance, wiring, tray, update dialogs, IPC |
| `src/main/i18n.ts` | shell localization catalog (system-locale driven) |
| `src/main/dsh-server.ts` | spawns and supervises the server child; parses its readiness line |
| `src/main/window.ts` | `BrowserWindow`, token handshake, navigation fence, geometry |
| `src/main/paths.ts` | runtime/toolchain resolution for dev and packaged layouts |
| `src/main/updater.ts` | npm registry checks, versioned installs, junction activation, rollback |
| `src/main/credentials.ts` | `safeStorage`-backed sealed credential store |
| `src/main/tray.ts` | tray menu and close-to-tray |
| `src/server/server.mjs` | the boot chain, run by the child process |
| `scripts/build.mjs` | packaging orchestration (the `.bat` files only forward) |
| `scripts/version.mjs` | version management |
| `scripts/stage-runtime.mjs` | stages `@deepseek-ai/dsh` into `runtime/` |
| `scripts/stage-node.mjs` | downloads and checksum-verifies the pinned Node |
| `build.bat` / `version.bat` | one-command packaging / versioning |

### Diagnostic scripts

Build-machine helpers, not shipped. They exist because every claim in this README
was verified rather than assumed:

| Script | Purpose |
|---|---|
| `scripts/test-i18n.cjs` | asserts the locale mapping and catalog key parity |
| `scripts/probe-web.mjs` | boots the runtime headlessly and reports the URL it serves |
| `scripts/probe-ui.mjs` | drives the live UI over CDP: dump controls, click, evaluate |
| `scripts/probe-locale.cjs` | prints what the Electron locale APIs report |
| `scripts/probe-tray.cjs` | verifies the tray icon loads and a `Tray` constructs |
| `scripts/capture-window.cjs` | screenshots the window, to verify layout claims |

---

## Known limitations

- **Only Windows has been verified end to end.** Linux and macOS build
  configuration is in place and CI produces artifacts, but neither has been
  installed on real hardware here.
- **Shell self-update is wired but unproven** — `electron-updater` needs a signed
  build and a real release host.
- **Runtime updates depend on npm.** The installer carries npm (~5 MB) and drives
  it with Electron's own Node. Reimplementing semver resolution and peer hoisting
  would risk a tree that boots but misbehaves.
- **The built-in `desktop` profile cannot be customized from the CLI.**
  `dsh --profile desktop` is refused by design; edit
  `$DSH_HOME/profiles/desktop/cordis.patch.yml` instead, which hot-reloads.
- **First build needs network** — Electron, the portable Node, and
  `@deepseek-ai/dsh` total roughly 700 MB, cached afterwards.

---

## Troubleshooting

**A dialog says `Error launching app` with a path that looks like JavaScript source.**
Electron has no `-e` flag — that one belongs to Node. Running
`npx electron -e "…"` makes Electron treat the source text as an *application
path*, fail, and raise that dialog. Use a script file instead. The dialog is a
native Windows message box, so it outlives the process that spawned it.

**A development run exits immediately with code 0 and prints nothing.**
The single-instance lock is held by an already-running copy.
`DSH_DESKTOP_HOME` does *not* change the lock scope — Electron derives it from
`app.getPath('userData')` before that override is read.

**Packaging fails with `remove …\resources\app.asar: The process cannot access the
file because it is being used by another process`.**
Windows Defender or the search indexer is holding the just-written asar. Build to a
different output directory, or retry after a pause.

**`.bat` output is mangled, or `'xxx' is not recognized as an internal or external command`.**
`cmd.exe` reads a `.bat` byte by byte and splits multi-byte UTF-8 characters into
bogus commands, so every `.bat` here is **pure ASCII** and all localized output
comes from `scripts/*.mjs`. Keep it that way when editing them.

---

## License

MIT. Bundles the MIT-licensed official DeepSeek Harness runtime:
<https://github.com/deepseek-ai/deepseek-harness>
