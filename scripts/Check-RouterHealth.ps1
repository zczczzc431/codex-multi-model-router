<#
    .SYNOPSIS
        Check that the local model router is still healthy.

    .DESCRIPTION
        Run this after a Codex update. Everything the router depends on lives
        outside Codex, and a Codex update moves two of those things: the CLI is
        installed into a new hashed bin directory, and it may rewrite parts of
        config.toml.

        The check covers, in order:

          1. the codex.exe the router resolves to, and its version;
          2. the router process, its /health endpoint and the supervisor task;
          3. the generated model catalog, per provider group;
          4. the three root keys in config.toml;
          5. the WorkBuddy bridge, including its configured codex.exe path.

        Exit code is 0 when nothing failed, 1 otherwise, so it can be run from
        a script or a scheduled task. The only write is the one described
        below, and it is skipped unless it is needed.

        A Codex update installs the CLI into a new hashed directory and deletes
        the previous one, so any stored path goes stale. When config.toml still
        points WORKBUDDY_CODEX_EXE at a codex.exe from an older install, this
        refreshes it to the current one after backing config.toml up.

    .EXAMPLE
        .\scripts\Check-RouterHealth.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_common.ps1')

$okCount = 0
$warnCount = 0
$failCount = 0

function Write-Section { param([string]$Title) Write-Host ''; Write-Host "== $Title ==" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) $script:okCount++;   Write-Host "  [OK]   $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) $script:warnCount++; Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) $script:failCount++; Write-Host "  [FAIL] $Message" -ForegroundColor Red }

Write-Host ("Codex model-router health check   " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

$configText = if (Test-Path -LiteralPath $CodexConfig) { [IO.File]::ReadAllText($CodexConfig) } else { '' }

# --- 1. the codex.exe the router resolves to -------------------------------
Write-Section '1. codex.exe'
$codexExe = Resolve-CodexExe
if (-not $codexExe) {
    Write-Fail 'no codex.exe found; the router cannot fetch the official model list'
} else {
    $cliVersion = (& $codexExe --version 2>&1 | Out-String).Trim()
    Write-Ok "codex.exe: $codexExe"
    Write-Ok "version: $cliVersion"
    if (Test-Path -LiteralPath $CliVersionFile) {
        $recorded = ([IO.File]::ReadAllText($CliVersionFile)).Trim()
        if ($recorded -ne $cliVersion) { Write-Warn "version changed: '$recorded' -> '$cliVersion'" }
        else { Write-Ok 'version matches the recorded one' }
    }
}

# --- 2. router process, health, supervisor ---------------------------------
Write-Section '2. router'
Write-Ok "endpoint: $RouterUrl"
$healthy = $false
try {
    $health = Invoke-RestMethod -Uri "$RouterUrl/health" -TimeoutSec 8
    if ($health.status -eq 'ok') { $healthy = $true; Write-Ok "health: status=ok pid=$($health.pid)" }
    else { Write-Warn "health: $($health | ConvertTo-Json -Compress)" }
} catch {
    Write-Fail "cannot reach the router: $($_.Exception.Message)"
}

$task = Get-ScheduledTask -TaskName $RouterTaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Fail "scheduled task '$RouterTaskName' not found" }
elseif ($task.State -ne 'Running') { Write-Warn "scheduled task state: $($task.State) (expected Running)" }
else { Write-Ok 'scheduled task is Running' }

# --- 3. the generated catalog ----------------------------------------------
Write-Section '3. model catalog'
if (-not (Test-Path -LiteralPath $RouterModels)) {
    Write-Fail "missing $RouterModels"
} else {
    try {
        $catalog = Read-JsonFile -Path $RouterModels
        $slugs = @($catalog.models | ForEach-Object { $_.slug })
        if ($slugs.Count -lt 2) { Write-Warn "only $($slugs.Count) entries in the catalog" }
        else { Write-Ok "catalog entries: $($slugs.Count)" }

        foreach ($provider in @(
            @{ Name = 'built-in GPT';   Pattern = 'gpt-' }
            @{ Name = 'DeepSeek';       Pattern = 'deepseek-' }
            @{ Name = 'relays';         Pattern = 'relay-' }
            @{ Name = 'WorkBuddy';      Pattern = 'wb-' }
        )) {
            $count = @($slugs | Where-Object { $_ -like ($provider.Pattern + '*') }).Count
            if ($count -eq 0) { Write-Warn "no $($provider.Name) entries (all $($provider.Pattern)* entries are missing)" }
            else { Write-Ok "$($provider.Name): $count" }
        }
    } catch {
        Write-Fail "catalog is not valid JSON: $($_.Exception.Message)"
    }
}

if (Test-Path -LiteralPath $OfficialCatalog) {
    $age = (Get-Date) - (Get-Item -LiteralPath $OfficialCatalog).LastWriteTime
    if ($age.TotalDays -gt 14) { Write-Warn "the official model list is $([int]$age.TotalDays) days old" }
    else { Write-Ok 'the official model list is fresh' }
} else {
    Write-Warn 'no official model list yet; the first launch will create it'
}

# --- 4. the root keys in config.toml ---------------------------------------
Write-Section '4. config.toml'
if (-not (Test-Path -LiteralPath $CodexConfig)) {
    Write-Fail "missing $CodexConfig"
} else {
    $quote = [char]39
    $checks = @(
        @{ Label = 'model_provider'; Pattern = "(?m)^[ \t]*model_provider[ \t]*=[ \t]*" + $quote + 'codex_router' + $quote + '[ \t]*\r?$'; Expect = $null }
        @{ Label = 'model_catalog_json'; Pattern = '(?m)^[ \t]*model_catalog_json[ \t]*='; Expect = $null }
        @{ Label = 'model'; Pattern = '(?m)^[ \t]*model[ \t]*='; Expect = $null }
    )
    foreach ($check in $checks) {
        $match = [regex]::Match($configText, $check.Pattern)
        if ($match.Success) { Write-Ok "$($check.Label): $($match.Value.Trim())" }
        else { Write-Fail "$($check.Label) is missing; run a launcher to restore it" }
    }
}

# --- 5. the WorkBuddy bridge -----------------------------------------------
Write-Section '5. WorkBuddy bridge'
if (Test-Path -LiteralPath $WorkbuddyConfig) {
    Write-Ok "provider config: $WorkbuddyConfig"
} else {
    Write-Warn 'WorkBuddy is not configured; wb-* models are absent from the menu'
}

$exePattern = '(?m)^[ \t]*WORKBUDDY_CODEX_EXE[ \t]*=[ \t]*' + $quote + '([^' + $quote + ']*)' + $quote + '[ \t]*\r?$'
$configuredExe = [regex]::Match($configText, $exePattern)
if (-not $configuredExe.Success) {
    Write-Warn 'config.toml has no WORKBUDDY_CODEX_EXE; the bridge will scan for codex.exe itself'
} elseif (Test-Path -LiteralPath $configuredExe.Groups[1].Value) {
    Write-Ok "WORKBUDDY_CODEX_EXE is valid: $($configuredExe.Groups[1].Value)"
} elseif (-not $codexExe) {
    Write-Fail 'WORKBUDDY_CODEX_EXE points at a removed path and no replacement was found'
} else {
    $stale = $configuredExe.Groups[1].Value
    Write-Warn "WORKBUDDY_CODEX_EXE points at a removed path: $stale"
    $backup = Join-Path $CodexHome ('config.toml.before-exe-refresh.' + (Get-Date -Format yyyyMMdd-HHmmss) + '.bak')
    Copy-Item -LiteralPath $CodexConfig -Destination $backup -Force
    $replacement = 'WORKBUDDY_CODEX_EXE = ' + $quote + $codexExe + $quote
    $updatedText = [regex]::Replace($configText, $exePattern, $replacement)
    [IO.File]::WriteAllText($CodexConfig, $updatedText, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "refreshed to $codexExe (backup: $(Split-Path -Leaf $backup)); restart Codex for it to take effect"
}

# --- summary ---------------------------------------------------------------
Write-Host ''
Write-Host '======================================'
if ($failCount -eq 0) {
    Write-Host "Result: healthy ($okCount passed, $warnCount warning(s))" -ForegroundColor Green
    exit 0
}
Write-Host "Result: $failCount failure(s), $warnCount warning(s), $okCount passed" -ForegroundColor Red
Write-Host 'Fix the failures above, then run this again.'
Write-Host "Log: $RouterLog"
exit 1
