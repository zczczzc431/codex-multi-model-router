#Requires -Version 5.1
<#
    .SYNOPSIS
        Register the router supervisor as a per-user Scheduled Task.

    .DESCRIPTION
        The task runs Start-ModelRouter.ps1 at logon and keeps it running.
        The supervisor in turn runs router.js and restarts it if it exits.

        Per-user, no elevation: the credentials are DPAPI-encrypted for this
        account, so the task must run as this account anyway.

    .PARAMETER TaskName
        Scheduled Task name. Default: Codex Model Router

    .PARAMETER Force
        Re-register even if the task already exists.
#>

[CmdletBinding()]
param(
    [string]$TaskName = 'Codex Model Router',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $repoRoot 'scripts\Start-ModelRouter.ps1'

if (-not (Test-Path -LiteralPath $entry)) { throw "Supervisor not found: $entry" }

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not $Force) {
    Write-Host "Task '$TaskName' already exists. Use -Force to replace it." -ForegroundColor Yellow
    exit 0
}
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed the existing task."
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $entry + '"')

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Keeps the local multi-model router running so Codex can reach every configured provider.' | Out-Null

Write-Host "Registered '$TaskName'." -ForegroundColor Green
Write-Host 'Starting it now...'
Start-ScheduledTask -TaskName $TaskName

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18763/health' -TimeoutSec 2
        if ($health.status -eq 'ok') { $ready = $true; break }
    } catch { }
}

if ($ready) {
    Write-Host 'Router is up.' -ForegroundColor Green
} else {
    Write-Host 'Router did not answer /health within 30s. Check the log:' -ForegroundColor Yellow
    Write-Host "  $env:USERPROFILE\.codex\codex-model-router.log"
}
