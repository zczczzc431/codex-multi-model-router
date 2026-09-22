<#
    .SYNOPSIS
        Start (or fully restart) the Codex desktop app with the router ready.

    .DESCRIPTION
        Deliberately conservative, because the failure mode here is the app
        being unable to reach any model at all:

          * The router is brought up and verified BEFORE the app starts.
          * Closing the app is graceful first, with a force fallback, so the
            thread store is not left locked (which shows up as
            'thread ... already has an active writer' on the next start).
          * -Restart also closes the app's backend and its MCP child
            processes. A child process is NOT killed when its parent exits on
            Windows, so leaving them alive can mean edited code never gets
            reloaded.

        The app identity is overridable via CODEX_APP_AUMID and
        CODEX_APP_PROCESS, since the packaged app name can differ.

    .PARAMETER Restart
        Close the app (and its backends) first, then start it fresh.
#>

[CmdletBinding()]
param(
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$AppAumid = if ($env:CODEX_APP_AUMID) { $env:CODEX_APP_AUMID } else { 'OpenAI.Codex_2p2nqsd0c76g0!App' }
$AppProcessName = if ($env:CODEX_APP_PROCESS) { $env:CODEX_APP_PROCESS } else { 'ChatGPT' }

function Get-CodexProcesses {
    return @(Get-Process -Name $AppProcessName -ErrorAction SilentlyContinue)
}

function Start-CodexApp {
    Write-Host 'Starting Codex...' -ForegroundColor Green
    Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$AppAumid"
}

<#
    Backend processes that should go down with the app:

      codex.exe  - the app's own backend. Matched by parent pid so a CLI
                   session the user started themselves is left alone.
      node.exe   - MCP bridge children, matched by command line.

    Note: the router itself does NOT live here. It runs under the Scheduled
    Task supervisor, so it survives app restarts by design.
#>
function Get-CodexBackendProcesses {
    param([int[]]$ParentPids = @())
    $found = New-Object System.Collections.ArrayList
    try { $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) } catch { return @() }

    foreach ($p in $all) {
        if ($p.Name -eq 'node.exe' -and $p.CommandLine -and $p.CommandLine -match 'workbuddy-bridge') {
            [void]$found.Add([pscustomobject]@{ Kind = 'bridge'; Id = [int]$p.ProcessId })
            continue
        }
        if ($p.Name -eq 'codex.exe' -and $ParentPids.Count -gt 0 -and ($ParentPids -contains [int]$p.ParentProcessId)) {
            [void]$found.Add([pscustomobject]@{ Kind = 'codex'; Id = [int]$p.ProcessId })
        }
    }
    return $found.ToArray()
}

function Stop-CodexBackends {
    param([int[]]$ParentPids = @())

    $before = @(Get-CodexBackendProcesses -ParentPids $ParentPids)
    if ($before.Count -eq 0) { return 0 }

    # Children first, then the codex.exe parent, so the parent cannot respawn
    # a fresh bridge while we are still cleaning up.
    $ordered = @($before | Where-Object { $_.Kind -eq 'bridge' }) + @($before | Where-Object { $_.Kind -eq 'codex' })
    foreach ($t in $ordered) {
        try { Stop-Process -Id $t.Id -Force -ErrorAction Stop } catch { }
    }

    # Process exit is asynchronous on Windows; wait for them to actually go.
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (@(Get-CodexBackendProcesses -ParentPids $ParentPids).Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }

    $after = @(Get-CodexBackendProcesses -ParentPids $ParentPids)
    return ($before.Count - $after.Count)
}

function Stop-CodexApp {
    $procs = Get-CodexProcesses
    $appPids = @($procs | ForEach-Object { [int]$_.Id })

    if ($procs) {
        Write-Host 'Closing Codex...' -ForegroundColor Yellow
        foreach ($proc in $procs) { try { [void]$proc.CloseMainWindow() } catch { } }

        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if (-not (Get-CodexProcesses)) { break }
            Start-Sleep -Milliseconds 500
        }

        $left = Get-CodexProcesses
        if ($left) {
            Write-Host 'Codex did not exit within 15s; forcing.' -ForegroundColor Yellow
            foreach ($proc in $left) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { } }
            Start-Sleep -Seconds 2
        }
    }

    $stopped = Stop-CodexBackends -ParentPids $appPids
    if ($stopped -gt 0) {
        Write-Host "Closed $stopped backend/bridge process(es)." -ForegroundColor Yellow
    }
    Write-RouterLog "restart: closed desktop app and $stopped backend/bridge process(es)"
}

$routerWasUp = Test-RouterUp

& (Join-Path $PSScriptRoot 'Activate-ModelRouter.ps1')

if (-not (Test-RouterUp)) {
    Write-Host ''
    Write-Host 'WARNING: the local model router is not ready. Codex will start on the built-in provider.' -ForegroundColor Yellow
    Write-Host "Log: $RouterLog"
}

if ($Restart) { Stop-CodexApp }

if (Get-CodexProcesses) {
    Write-Host 'Codex is already running; router checked.' -ForegroundColor Green
    if (-not $routerWasUp -and (Test-RouterUp)) {
        Write-Host 'The router was just (re)started - restart Codex so it reconnects.' -ForegroundColor Yellow
    }
} else {
    Start-CodexApp
}