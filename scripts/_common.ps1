<#
    Shared path + helper resolution for every script in this repo.

    Dot-source it from the top of another script:

        . (Join-Path $PSScriptRoot '_common.ps1')

    Everything the router touches lives in the Codex home directory, because
    that is what Codex itself uses. Resolution order:

        1. CODEX_ROUTER_HOME   explicit override (handy for testing)
        2. CODEX_HOME          Codex's own variable
        3. ~/.codex            Codex's default
#>

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:SrcDir   = Join-Path $RepoRoot 'src'

$script:CodexHome =
    if ($env:CODEX_ROUTER_HOME) { $env:CODEX_ROUTER_HOME }
    elseif ($env:CODEX_HOME)    { $env:CODEX_HOME }
    else                        { Join-Path $env:USERPROFILE '.codex' }

$script:RouterPort =
    if ($env:CODEX_ROUTER_PORT) { [int]$env:CODEX_ROUTER_PORT }
    else                        { 18763 }

$script:RouterUrl      = "http://127.0.0.1:$script:RouterPort"
$script:RouterTaskName = if ($env:CODEX_ROUTER_TASK) { $env:CODEX_ROUTER_TASK } else { 'Codex Model Router' }

# --- runtime files ---------------------------------------------------------
$script:RouterLog          = Join-Path $CodexHome 'codex-model-router.log'
$script:FingerprintFile    = Join-Path $CodexHome 'codex-router-files.sha256'
$script:CliVersionFile     = Join-Path $CodexHome 'codex-router-last-cli-version.txt'

# --- provider config -------------------------------------------------------
$script:RelayConfig        = Join-Path $CodexHome 'relay-models.json'
$script:WorkbuddyConfig    = Join-Path $CodexHome 'workbuddy-models.json'
$script:DeepseekConfig     = Join-Path $CodexHome 'deepseek-models.json'
$script:ModelsCache        = Join-Path $CodexHome 'models_cache.json'
$script:RouterModels       = Join-Path $CodexHome 'router-models.json'
$script:RouterLastGood     = Join-Path $CodexHome 'router-models.last-good.json'

# --- encrypted credentials -------------------------------------------------
$script:DeepseekKeyFile    = Join-Path $CodexHome 'deepseek-api-key.dpapi'
$script:WorkbuddyTokenFile = Join-Path $CodexHome 'workbuddy-token.dpapi'

# --- Codex's own config ----------------------------------------------------
$script:CodexConfig        = Join-Path $CodexHome 'config.toml'

# --- source entry points ---------------------------------------------------
$script:RouterEntry        = Join-Path $SrcDir 'router.js'
$script:SyncScript         = Join-Path $SrcDir 'sync-model-catalog.js'
$script:WorkbuddyAdapter   = Join-Path $SrcDir 'workbuddy-adapter.js'
$script:NodeExe            = if ($env:CODEX_ROUTER_NODE) { $env:CODEX_ROUTER_NODE } else { 'node' }

<#
    Resolve a path that may be stored relative to the Codex home. Provider
    configs use relative paths so the repo stays portable between machines.
#>
function Resolve-RouterPath {
    param([Parameter(Mandatory)][string]$Path)
    if ([IO.Path]::IsPathRooted($Path)) { return $Path }
    return (Join-Path $CodexHome $Path)
}

function Write-RouterLog {
    param([string]$Message)
    try { Add-Content -LiteralPath $RouterLog -Value "$(Get-Date -Format o) $Message" } catch { }
}

function Test-RouterUp {
    try {
        $health = Invoke-RestMethod -Uri "$RouterUrl/health" -TimeoutSec 3
        return $health.status -eq 'ok'
    } catch {
        return $false
    }
}

function Get-RouterPortOwner {
    try {
        $conn = Get-NetTCPConnection -State Listen -LocalPort $RouterPort -ErrorAction SilentlyContinue
        if ($conn) { return @($conn | Select-Object -ExpandProperty OwningProcess -Unique) }
    } catch { }
    return @()
}

<#
    A previous router instance that is slow to exit keeps the port, which makes
    the replacement die with EADDRINUSE. Without this, a stale listener leaves
    the whole app unusable because config.toml points at a dead local port.
#>
function Clear-RouterPort {
    $owners = Get-RouterPortOwner
    foreach ($ownerPid in $owners) {
        if (-not $ownerPid -or $ownerPid -eq 0) { continue }
        try {
            Stop-Process -Id $ownerPid -Force -ErrorAction Stop
            Write-RouterLog "stopped stale listener pid=$ownerPid holding port $RouterPort"
        } catch { }
    }
    return $owners.Count
}

function Get-CodexCliVersion {
    $cmd = Get-Command codex -ErrorAction SilentlyContinue
    if (-not $cmd) { return '' }
    return (& $cmd.Source --version 2>&1 | Out-String).Trim()
}

<#
    Resolve the node executable, falling back to PATH lookup and then to a
    bundled runtime if one is present.
#>
function Resolve-NodeExe {
    param([string]$Preferred)
    $candidates = @($Preferred, $NodeExe, 'node')
    foreach ($c in $candidates) {
        if (-not $c) { continue }
        try {
            $cmd = Get-Command $c -ErrorAction Stop
            return $cmd.Source
        } catch { }
    }
    throw 'Node.js was not found. Install Node or set CODEX_ROUTER_NODE to node.exe.'
}

<#
    Read a JSON file as UTF-8 explicitly.

    Get-Content falls back to the ANSI codepage in Windows PowerShell. For a
    UTF-8 file without a BOM that mangles non-ASCII display names, and a stray
    lead byte can even swallow the following quote, making the JSON unparseable.

    [IO.File]::ReadAllText defaults to UTF-8 with BOM detection, which matches
    how every config in this repo is written.
#>
function Read-JsonFile {
    param([Parameter(Mandatory)][string]$Path)
    return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}
