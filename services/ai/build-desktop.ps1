<#
.SYNOPSIS
  Builds the SCIP AI desktop sidecar (dist\scip-ai\scip-ai.exe) with PyInstaller.

.DESCRIPTION
  Idempotent: reuses services\ai\.venv-build when it exists, reinstalls pinned dependencies
  (a no-op when already satisfied) and rebuilds from a clean build\ and dist\scip-ai\.

  Python 3.12 is used on purpose: every pinned wheel (numpy 2.2.2, scipy 1.15.1, ortools 9.11...)
  exists for cp312 on Windows, so nothing falls back to a source build and the pins in
  requirements.txt need no desktop-specific exceptions.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File services\ai\build-desktop.ps1
#>
[CmdletBinding()]
param(
  # Interpreter selector for the py launcher.
  [string]$PythonVersion = '3.12',
  [string]$PyInstallerVersion = '6.19.0'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$venv = Join-Path $root '.venv-build'
$python = Join-Path $venv 'Scripts\python.exe'

function Invoke-Checked {
  param([string]$File, [string[]]$Arguments)
  # PyInstaller and pip log INFO lines to stderr; under Windows PowerShell 5.1 with 'Stop' that
  # becomes a terminating NativeCommandError as soon as output is redirected (CI, log files).
  # Success is judged by the exit code instead.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $File @Arguments 2>&1 | ForEach-Object { "$_" } }
  finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

Push-Location $root
try {
  if (-not (Test-Path $python)) {
    Write-Host "Creating build venv with Python $PythonVersion..."
    Invoke-Checked 'py' @("-$PythonVersion", '-m', 'venv', $venv)
  }

  # Runtime dependencies only: the "# Dev / test" block of requirements.txt (pytest...) is
  # stripped so it cannot end up in the bundle. The filtered copy lives in build\.
  New-Item -ItemType Directory -Force (Join-Path $root 'build') | Out-Null
  $runtimeReqs = Join-Path $root 'build\requirements-runtime.txt'
  $lines = Get-Content (Join-Path $root 'requirements.txt')
  $cut = [Array]::IndexOf($lines, '# Dev / test')
  if ($cut -ge 0) { $lines = $lines[0..($cut - 1)] }
  Set-Content -Path $runtimeReqs -Value $lines -Encoding utf8

  Write-Host 'Installing runtime dependencies...'
  # --no-compile: in a deep worktree path pip's byte-compilation step trips over the Windows
  # 260-character path limit (AssertionError on a missing .pyc). PyInstaller compiles what it
  # bundles itself, so skipping it here costs nothing.
  Invoke-Checked $python @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile', '-q',
    '-r', $runtimeReqs, "pyinstaller==$PyInstallerVersion")

  Write-Host 'Running PyInstaller...'
  Invoke-Checked $python @('-m', 'PyInstaller', '--noconfirm', '--clean',
    '--distpath', (Join-Path $root 'dist'), '--workpath', (Join-Path $root 'build\pyinstaller'),
    (Join-Path $root 'scip-ai.spec'))

  $out = Join-Path $root 'dist\scip-ai'
  $bytes = (Get-ChildItem $out -Recurse -File | Measure-Object -Property Length -Sum).Sum
  Write-Host ("Built {0}\scip-ai.exe ({1:N0} MB)" -f $out, ($bytes / 1MB))
}
finally {
  Pop-Location
}
