# Verify that the COMMITTED content compiles.
#
#   powershell -ExecutionPolicy Bypass -File scripts/verify-committed-build.ps1
#
# Why this exists: a local build sees the WORKING TREE, while CI sees what was
# COMMITTED. When those differ - a new file never `git add`ed, an edited file never
# committed - local passes and CI dies at "compile TypeScript". This repository lost
# two CI rounds to exactly that:
#   * src/main/{git,module-heal,project-info}.ts were never committed
#   * src/main/tray.ts's TrayActions.projectInfo was never committed
# Each round cost minutes of CI plus a log-fetching detour. This makes it seconds.
#
# Uses `git worktree add` to materialize HEAD, which is more reliable on Windows than
# piping `git archive` into tar (that reported "Damaged tar archive").
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5 decodes a BOM-less .ps1 as
# ANSI, which corrupts non-ASCII text and turns comments into syntax errors.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$temp = Join-Path $env:TEMP ("dsh-verify-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

Write-Output "[verify] materializing HEAD into $temp"

Push-Location $root
try {
  # --detach: do not create or move a branch. Files come from the committed tree only.
  git worktree add --detach --quiet $temp HEAD
  if ($LASTEXITCODE -ne 0) { throw "git worktree add failed with $LASTEXITCODE" }
} finally {
  Pop-Location
}

# Reuse the installed node_modules and runtime: they are not committed but compilation needs them.
Write-Output "[verify] linking node_modules and runtime"
cmd /c mklink /J "$temp\node_modules" "$root\node_modules" | Out-Null
if (Test-Path "$root\runtime") { cmd /c mklink /J "$temp\runtime" "$root\runtime" | Out-Null }

Write-Output "[verify] compiling ..."
Push-Location $temp
try {
  & npx.cmd tsc -p tsconfig.json --noEmit
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

# Remove the junctions before the worktree, otherwise the recursive delete follows them.
foreach ($link in @("$temp\node_modules", "$temp\runtime")) {
  if (Test-Path $link) { cmd /c rmdir "$link" | Out-Null }
}
Push-Location $root
try { git worktree remove --force $temp } finally { Pop-Location }
git worktree prune
Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue

if ($code -eq 0) {
  Write-Output "[verify] PASS: the committed content compiles on its own."
} else {
  Write-Output "[verify] FAIL: committed content does not compile - a file was probably not committed."
}
exit $code
