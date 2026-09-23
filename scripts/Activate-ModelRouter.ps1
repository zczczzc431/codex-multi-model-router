<#
    .SYNOPSIS
        Make sure the router is running and healthy. Repairs common breakage.

    .DESCRIPTION
        Four jobs, in order:

          1. Detect a config.toml that points at a dead local proxy (some
             provider switchers rewrite it) and put codex_router back.
          2. Refresh the model catalog. The current official model list is
             re-fetched first, because Codex stops refreshing its own cache
             while model_catalog_json is set - see lesson 9 in
             docs/lessons-learned.md. Without this, models released after
             setup never reach the menu.
          3. Restart the router task when the router is unhealthy, the Codex
             CLI version changed, or the router files changed on disk.
          4. Wait for /health. If it never comes up, fall back to the built-in
             provider so the app stays usable instead of pointing at a dead
             port.

        The launch scripts call this. It is safe to run by hand.
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

# --- 1. repair a config that points at a dead local proxy ------------------
function Get-ActiveModelProvider {
    param([string]$Text)
    $m = [regex]::Match($Text, '(?m)^\s*model_provider\s*=\s*[''"]([A-Za-z0-9_.\-]+)[''"]\s*$')
    if (-not $m.Success) { return $null }
    $name = $m.Groups[1].Value
    $baseUrl = ''
    $section = [regex]::Match($Text, ('(?ms)^\s*\[model_providers\.' + [regex]::Escape($name) + '\]\s*$.*?(?=^\s*\[|\z)'))
    if ($section.Success) {
        $u = [regex]::Match($section.Value, 'base_url\s*=\s*[''"]([^''"]+)[''"]')
        if ($u.Success) { $baseUrl = $u.Groups[1].Value }
    }
    return [pscustomobject]@{ Name = $name; BaseUrl = $baseUrl }
}

function Test-LoopbackPortOpen {
    param([string]$Url)
    $uri = $null
    if (-not [uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) { return $null }
    if (@('127.0.0.1', 'localhost', '::1') -notcontains $uri.Host) { return $null }
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
        $connected = $pending.AsyncWaitHandle.WaitOne(800)
        if ($connected) { $client.EndConnect($pending) }
        return $connected
    } catch { return $false } finally { $client.Close() }
}

try {
    if (Test-Path -LiteralPath $CodexConfig) {
        $configText = [IO.File]::ReadAllText($CodexConfig)
        $active = Get-ActiveModelProvider -Text $configText
        if ($active -and $active.Name -ne 'codex_router' -and $active.BaseUrl) {
            if ((Test-LoopbackPortOpen -Url $active.BaseUrl) -eq $false) {
                $backup = "$CodexConfig.before-provider-repair.$(Get-Date -Format yyyyMMdd-HHmmss).bak"
                Copy-Item -LiteralPath $CodexConfig -Destination $backup -Force
                $pattern = '(?m)^(\s*model_provider\s*=\s*)[''"]' + [regex]::Escape($active.Name) + '[''"]\s*$'
                $repaired = [regex]::Replace($configText, $pattern, ('${1}' + "'codex_router'"))
                [IO.File]::WriteAllText($CodexConfig, $repaired, (New-Object System.Text.UTF8Encoding($false)))
                Write-RouterLog "active provider '$($active.Name)' at $($active.BaseUrl) was not listening; restored 'codex_router' (backup: $(Split-Path -Leaf $backup))"
                Write-Host "The configured provider pointed at a dead local port ($($active.BaseUrl)); restored the built-in router." -ForegroundColor Yellow
            }
        }
    }
} catch {
    Write-RouterLog "provider repair skipped: $($_.Exception.Message)"
}

# --- 2. refresh the model menu --------------------------------------------
# Best effort: a stale menu is far better than a launcher that refuses to
# start, so every failure here is logged and then ignored.
try {
    Write-RouterLog "catalog sync: $(Sync-ModelCatalog)"
} catch {
    Write-RouterLog "catalog sync skipped: $($_.Exception.Message)"
}

# --- 3. restart the task when needed --------------------------------------
$parts = @($RouterEntry, $RelayConfig, $SyncScript, $WorkbuddyAdapter, $WorkbuddyConfig, $DeepseekConfig)
function Get-RouterFingerprint {
    $hashes = foreach ($part in $parts) {
        if (Test-Path -LiteralPath $part) { (Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash } else { 'missing' }
    }
    return ($hashes -join '|')
}

if (-not (Test-Path -LiteralPath $DeepseekKeyFile)) {
    throw "The encrypted DeepSeek API key is not configured. Run: $(Join-Path $PSScriptRoot 'Set-DeepSeekApiKey.ps1')"
}

$task = Get-ScheduledTask -TaskName $RouterTaskName -ErrorAction Stop
$currentVersion = Get-CodexCliVersion
$recordedVersion = if (Test-Path -LiteralPath $CliVersionFile) { (Get-Content -LiteralPath $CliVersionFile -Raw).Trim() } else { '' }
$versionChanged = $currentVersion -and ($currentVersion -ne $recordedVersion)
$currentFingerprint = Get-RouterFingerprint
$recordedFingerprint = if (Test-Path -LiteralPath $FingerprintFile) { (Get-Content -LiteralPath $FingerprintFile -Raw).Trim() } else { '' }
$filesChanged = $currentFingerprint -ne $recordedFingerprint
$healthy = Test-RouterUp

if (-not $healthy -or $versionChanged -or $filesChanged) {
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $task.TaskName }
    # The node child notices its supervisor is gone within two seconds. Wait
    # for the port to be released, then force-clear anything left over so the
    # replacement cannot fail with EADDRINUSE.
    for ($i = 0; $i -lt 24; $i++) {
        if ((Get-RouterPortOwner).Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }
    if ((Get-RouterPortOwner).Count -gt 0) {
        [void](Clear-RouterPort)
        Start-Sleep -Milliseconds 400
    }
    Start-ScheduledTask -TaskName $task.TaskName
}

# --- 4. wait for health, else fall back -----------------------------------
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    if (Test-RouterUp) { $ready = $true; break }
    if ($i -eq 20 -or $i -eq 40) { [void](Clear-RouterPort) }
    Start-Sleep -Milliseconds 500
}

if (-not $ready) {
    # Never leave Codex pointing at a dead local port.
    Write-RouterLog 'router did not become ready within 30s; falling back to the built-in provider'
    try {
        & (Join-Path $PSScriptRoot 'Use-OfficialProvider.ps1') -Quiet | Out-Null
        Write-Host 'Router failed to start; switched back to the built-in provider so Codex still opens.' -ForegroundColor Yellow
        Write-Host 'Fix the problem, then run this launcher again to re-enable the model menu.'
    } catch {
        Write-Host 'Router failed AND the fallback failed.' -ForegroundColor Red
        Write-Host $_.Exception.Message
    }
    return
}

Set-Content -LiteralPath $FingerprintFile -Value $currentFingerprint -Encoding ascii

Write-Host ''
Write-Host 'Local model router is ready.' -ForegroundColor Green
Write-Host 'You can close this window; closing it does not stop the router.'
