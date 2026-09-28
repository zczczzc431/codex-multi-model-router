[CmdletBinding()]
param(
    [string]$CodexHome = (Join-Path $env:USERPROFILE '.codex'),
    [switch]$RestoreLatestBackup
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $CodexHome 'config.toml'
$backupRoot = 'G:\gaoshuacodex\codex-multi-model-router\backups'

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Codex config was not found: $configPath"
}
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

if ($RestoreLatestBackup) {
    $backup = Get-ChildItem -LiteralPath $backupRoot -Filter 'config.toml.before-cyberpunk-*.bak' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $backup) { throw "No Cyberpunk theme backup was found in $backupRoot" }
    Copy-Item -LiteralPath $backup.FullName -Destination $configPath -Force
    Write-Output "Restored $($backup.FullName) to $configPath"
    exit 0
}

$content = Get-Content -LiteralPath $configPath -Raw
$managedKeys = @('appearanceTheme', 'appearanceDarkCodeThemeId', 'appearanceDarkChromeTheme')
$existing = @($managedKeys | Where-Object { $content -match "(?m)^\s*$([regex]::Escape($_))\s*=" })
if ($existing.Count -gt 0) {
    throw "Theme keys already exist ($($existing -join ', ')). Use the restore switch or edit them through Codex Settings; no changes were made."
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $backupRoot "config.toml.before-cyberpunk-$stamp.bak"
Copy-Item -LiteralPath $configPath -Destination $backupPath -Force

$block = @'

# Deep Dive Protocol / Cyberpunk 2077 inspired appearance.
appearanceTheme = "dark"
appearanceDarkCodeThemeId = "monokai"
appearanceDarkChromeTheme = { accent = "#ff4b4b", accentSource = "custom", contrast = 68, fonts = { code = 'Consolas, "Cascadia Mono", monospace', ui = 'Bahnschrift, "Segoe UI", sans-serif' }, ink = "#f5e9e2", opaqueWindows = true, semanticColors = { diffAdded = "#28f0c0", diffRemoved = "#ff4b68", skill = "#ffd166" }, surface = "#120d12" }
'@

Set-Content -LiteralPath $configPath -Value ($content.TrimEnd() + $block + "`r`n") -Encoding utf8NoBOM

$python = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = (Get-Command python -ErrorAction Stop).Source }
$null = & $python -c "import tomllib; tomllib.load(open(r'$configPath','rb'))"
if ($LASTEXITCODE -ne 0) {
    Copy-Item -LiteralPath $backupPath -Destination $configPath -Force
    throw "The edited config did not pass TOML validation; it was restored from $backupPath"
}

Write-Output "Applied Cyberpunk 2077 inspired dark theme."
Write-Output "Backup: $backupPath"
Write-Output "Restart Codex to load the theme."
