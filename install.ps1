# Install dsh-console into a DSH profile.
#
# Usage:
#   .\install.ps1                       # install into the "desktop" profile
#   .\install.ps1 -Profile web          # install into another profile
#   .\install.ps1 -Tarball .\dsh-console-1.0.1.tgz
param(
  [string]$Profile = 'desktop',
  [string]$Tarball = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Tarball -eq '') {
  $candidate = Get-ChildItem -Path $here -Filter 'dsh-console-*.tgz' | Select-Object -First 1
  if ($null -eq $candidate) { throw "No dsh-console-*.tgz found next to install.ps1; pass -Tarball <path>." }
  $Tarball = $candidate.FullName
}
$Tarball = (Resolve-Path $Tarball).Path

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'The "dsh" command is not on PATH. Run this script from a DSH environment, or add the DSH launcher to PATH.'
}

Write-Host "Installing $Tarball into profile '$Profile' ..."
& dsh plugin --profile $Profile add "file:$Tarball"
$code = $LASTEXITCODE

if ($code -ne 0) {
  Write-Host ''
  Write-Host 'The plugin package was fetched, but pnpm refused to run a dependency install script'
  Write-Host '(usually: @serialport/bindings-cpp, the serial-port native binding).'
  Write-Host 'Approve that one build script for this profile, then run this installer again:'
  Write-Host ''
  Write-Host "  dsh plugin --profile $Profile approve-builds"
  Write-Host ''
  Write-Host 'If approve-builds is unavailable, add the package under pnpm-workspace.yaml allowBuilds:'
  Write-Host "  $env:DSH_HOME\profiles\$Profile\pnpm-workspace.yaml"
  Write-Host '  -> allowBuilds:'
  Write-Host '       "@serialport/bindings-cpp": true'
  throw "dsh plugin add failed with exit code $code."
}

Write-Host ''
Write-Host 'Installed. Restart DSH once to load the plugin, then open the sidebar entry "设备控制台" / "Device console".'
Write-Host 'Uninstall with: dsh plugin --profile <profile> remove dsh-console'
