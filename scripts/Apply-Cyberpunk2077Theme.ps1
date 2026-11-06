[CmdletBinding()]
param(
    [switch]$OpenSettings
)

$ErrorActionPreference = 'Stop'
$sharePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs\cyberpunk2077-theme-share.txt'
if (-not (Test-Path -LiteralPath $sharePath)) { throw "Theme share file was not found: $sharePath" }

$share = (Get-Content -LiteralPath $sharePath -Raw).Trim()
if (-not $share.StartsWith('codex-theme-v1:')) { throw 'Theme share file has an invalid Codex theme prefix.' }
Set-Clipboard -Value $share
Write-Output 'Cyberpunk 2077 theme share string copied to the clipboard.'
Write-Output 'In Codex: Settings -> Appearance -> Advanced Appearance -> Import theme, paste and confirm.'

if ($OpenSettings) {
    Start-Process 'codex://settings'
    Write-Output 'Codex Settings was opened.'
}
