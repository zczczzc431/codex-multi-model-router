param(
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$routerLog = 'C:\Users\Administrator\.codex\codex-model-router.log'

function Test-RouterUp {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18763/health' -TimeoutSec 3
        return $health.status -eq 'ok'
    } catch {
        return $false
    }
}

function Get-CodexProcesses {
    return @(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue)
}

function Start-CodexApp {
    Write-Host '正在启动 Codex...' -ForegroundColor Green
    Start-Process -FilePath 'explorer.exe' -ArgumentList 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'
}

# Codex 的后端 codex.exe（MCP 宿主）和挂在它下面的 node.exe（workbuddy 桥接）
# 不会因为 ChatGPT.exe 退出而自动结束。只关 ChatGPT.exe 的话，桥接会带着旧代码
# 继续活着，改过的 workbuddy-bridge.mjs 就永远不生效。
# 这里只收「父进程是桌面 App」的 codex.exe，避免误伤用户自己开的 CLI 会话。
function Get-CodexBackendProcesses {
    param([int[]]$ParentPids = @())

    $found = New-Object System.Collections.ArrayList
    try {
        $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    } catch {
        return @()
    }

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

    # 先收桥接（子），再收 codex.exe（父），免得父进程退出时又拉起一个新的桥接。
    $ordered = @($before | Where-Object { $_.Kind -eq 'bridge' }) + @($before | Where-Object { $_.Kind -eq 'codex' })
    foreach ($t in $ordered) {
        try { Stop-Process -Id $t.Id -Force -ErrorAction Stop } catch { }
    }

    # Windows 上进程退出是异步的，等它们真正消失。
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (@(Get-CodexBackendProcesses -ParentPids $ParentPids).Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }

    $after = @(Get-CodexBackendProcesses -ParentPids $ParentPids)
    return ($before.Count - $after.Count)
}

# Close Codex gracefully first. Forcing it down immediately can leave the thread
# store locked, which produces "already has an active writer" on the next start.
function Stop-CodexApp {
    $procs = Get-CodexProcesses
    $appPids = @($procs | ForEach-Object { [int]$_.Id })

    if ($procs) {
        Write-Host '正在关闭 Codex...' -ForegroundColor Yellow
        foreach ($proc in $procs) {
            try { [void]$proc.CloseMainWindow() } catch { }
        }

        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if (-not (Get-CodexProcesses)) { break }
            Start-Sleep -Milliseconds 500
        }

        $left = Get-CodexProcesses
        if ($left) {
            Write-Host 'Codex 未在 15 秒内退出，改为强制结束。' -ForegroundColor Yellow
            foreach ($proc in $left) {
                try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
            }
            Start-Sleep -Seconds 2
        }
    }

    # 关键一步：把后端和桥接也一起收掉，否则桥接脚本的改动不会重新加载。
    $stopped = Stop-CodexBackends -ParentPids $appPids
    if ($stopped -gt 0) {
        Write-Host ("已一并结束 $stopped 个 Codex 后端 / 模型桥接进程。") -ForegroundColor Yellow
    }

    try {
        Add-Content -LiteralPath $routerLog -Value "$(Get-Date -Format o) restart: closed desktop app and $stopped backend/bridge process(es)"
    } catch { }
}

$routerWasUp = Test-RouterUp

& (Join-Path $PSScriptRoot 'Activate-ModelRouter.ps1')

$routerUp = Test-RouterUp
if (-not $routerUp) {
    Write-Host ''
    Write-Host '警告：本地模型路由未就绪。Codex 将以官方 GPT 通道启动。' -ForegroundColor Yellow
    Write-Host "详细日志：$routerLog"
}

if ($Restart) {
    Stop-CodexApp
}

if (Get-CodexProcesses) {
    Write-Host 'Codex 已经在运行；模型路由已检查完成。' -ForegroundColor Green
    if (-not $routerWasUp -and $routerUp) {
        Write-Host '注意：模型路由刚刚重启过，建议重启 Codex 以重新连接。' -ForegroundColor Yellow
        Write-Host '用桌面上的 "Codex 重启修复" 快捷方式可以一键重启。'
    }
} else {
    Start-CodexApp
}
