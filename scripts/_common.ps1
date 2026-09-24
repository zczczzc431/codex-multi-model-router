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
$script:RouterKeySnapshot  = Join-Path $CodexHome 'codex-router-config-keys.snapshot'

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

# --- official model catalog ------------------------------------------------
$script:OfficialCatalog = Join-Path $CodexHome 'official-models.json'

<#
    Find the codex.exe that belongs to the installed desktop app.

    Every Codex update installs the CLI into a NEW hashed directory
    (<localappdata>\OpenAI\Codex\bin\<hash>\codex.exe) and deletes the old
    one, so any remembered path goes stale on the next update. Resolve it
    fresh instead: newest hashed directory, then PATH as a fallback.
#>
function Resolve-CodexExe {
    $binRoot = $null
    if ($env:LOCALAPPDATA) { $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin' }
    if ($binRoot) {
        try {
            $newest = Get-ChildItem -LiteralPath $binRoot -Directory -ErrorAction Stop |
                ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
                Where-Object { Test-Path -LiteralPath $_ } |
                Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending |
                Select-Object -First 1
            if ($newest) { return $newest }
        } catch { }
    }
    $cmd = Get-Command codex -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

<#
    Fetch the CURRENT official model list into $OfficialCatalog.

    Codex only rewrites its own models_cache.json when it fetches the remote
    catalog itself. While model_catalog_json points at our generated catalog
    that fetch does not happen, so models_cache.json freezes at whatever
    models existed the last time it did - and models released afterwards never
    reach the menu. It is not enough to notice a Codex upgrade.

    The fetch runs the CLI's model-catalog dump inside a throwaway CODEX_HOME
    seeded with a copy of auth.json, so it is unaffected by the catalog
    override. Returns the catalog path, or $null if the fetch failed - callers
    then fall back to the on-disk cache.

    Output is captured through FILES, never through a pipeline. Windows
    PowerShell decodes a native command's stdout with [Console]::OutputEncoding,
    which is the ANSI codepage (GBK on a Chinese system) when this runs from a
    Scheduled Task. The CLI emits UTF-8, so a pipeline capture mangles it - a
    GBK lead byte consumes the next character, and ConvertFrom-Json then reports
    "Invalid object passed in, ':' or '}' expected" on perfectly valid JSON.
    That is the same class of failure as lesson 4, one layer further out.
    Redirecting to a file skips the decode entirely; the file is read back as
    UTF-8.
#>
function Update-OfficialModelCatalog {
    $codexExe = Resolve-CodexExe
    if (-not $codexExe) {
        Write-RouterLog 'official fetch skipped: no codex.exe found'
        return $null
    }
    $authFile = Join-Path $CodexHome 'auth.json'
    if (-not (Test-Path -LiteralPath $authFile)) {
        Write-RouterLog "official fetch skipped: auth.json missing at $authFile"
        return $null
    }

    $tempRoot = [IO.Path]::GetTempPath()
    $stamp = [Guid]::NewGuid().ToString('N')
    $probeHome = Join-Path $tempRoot ('codex-catalog-' + $stamp)
    $outFile = Join-Path $tempRoot ('codex-fetch-out-' + $stamp + '.json')
    $errFile = Join-Path $tempRoot ('codex-fetch-err-' + $stamp + '.log')
    $previousCodexHome = $env:CODEX_HOME
    try {
        New-Item -ItemType Directory -Force -Path $probeHome | Out-Null
        Copy-Item -LiteralPath $authFile -Destination (Join-Path $probeHome 'auth.json') -Force
        $env:CODEX_HOME = $probeHome

        $proc = Start-Process -FilePath $codexExe -ArgumentList @('debug', 'models') `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        if ($proc.ExitCode -ne 0) {
            $detail = ''
            if (Test-Path -LiteralPath $errFile) {
                $detail = (([IO.File]::ReadAllText($errFile) -replace "\r?\n", ' ').Trim())
                if ($detail.Length -gt 200) { $detail = $detail.Substring(0, 200) }
            }
            Write-RouterLog "official fetch failed: exit=$($proc.ExitCode) stderr=$detail"
            return $null
        }
        if (-not (Test-Path -LiteralPath $outFile)) {
            Write-RouterLog "official fetch failed: no output at $outFile"
            return $null
        }
        $raw = [IO.File]::ReadAllText($outFile)
        if (-not $raw) {
            Write-RouterLog 'official fetch failed: empty output'
            return $null
        }
        $parsed = $raw | ConvertFrom-Json
        if (-not $parsed.models -or @($parsed.models).Count -eq 0) {
            Write-RouterLog 'official fetch failed: parsed catalog has no models'
            return $null
        }
        [IO.File]::WriteAllText($OfficialCatalog, $raw, (New-Object System.Text.UTF8Encoding($false)))
        Write-RouterLog "official fetch ok: $(@($parsed.models).Count) models"
        return $OfficialCatalog
    } catch {
        # The message can embed the whole catalog; keep the log readable.
        $msg = $_.Exception.Message
        if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
        Write-RouterLog "official fetch threw: $msg"
        return $null
    } finally {
        $env:CODEX_HOME = $previousCodexHome
        # The probe home holds a copy of the auth token; never leave it behind.
        try {
            [IO.File]::Delete((Join-Path $probeHome 'auth.json'))
            [IO.Directory]::Delete($probeHome, $true)
            [IO.File]::Delete($outFile)
            [IO.File]::Delete($errFile)
        } catch { }
    }
}

<#
    Regenerate the catalog Codex reads - that is, the model menu.

    Merges the freshly fetched official list with the DeepSeek / relay /
    WorkBuddy provider configs. Falls back to models_cache.json when the fetch
    fails, so an offline machine keeps the menu it already had.
#>

<#
    The path handed to the sync script for a provider that is not configured.

    sync-model-catalog.js receives its provider configs as positional
    arguments, so omitting a missing one shifts every argument after it and
    silently reinterprets one provider's config as another's - a DeepSeek file
    would be read as the relay config, and the DeepSeek group would come out
    empty. A path that cannot exist keeps the positions fixed and reads, to the
    script, as "not configured".
#>
function Get-AbsentProviderArg {
    return (Join-Path $CodexHome '.provider-models-not-configured.json')
}

function Sync-ModelCatalog {
    $node = Resolve-NodeExe -Preferred $NodeExe
    $source = Update-OfficialModelCatalog
    if (-not $source) { $source = $ModelsCache }

    $relayArg     = if (Test-Path -LiteralPath $RelayConfig)     { $RelayConfig }     else { Get-AbsentProviderArg }
    $workbuddyArg = if (Test-Path -LiteralPath $WorkbuddyConfig) { $WorkbuddyConfig } else { Get-AbsentProviderArg }
    $deepseekArg  = if (Test-Path -LiteralPath $DeepseekConfig)  { $DeepseekConfig }  else { Get-AbsentProviderArg }

    $syncArgs = @(
        $SyncScript, $source, $RouterModels, $RouterLastGood,
        $relayArg, $workbuddyArg, $deepseekArg
    )

    # Keep the child's stderr out of the caller's console. On failure its first
    # lines are far more useful in the log than a raw stack trace on screen -
    # and the launcher's console may not be visible at all.
    $stderrFile = Join-Path ([IO.Path]::GetTempPath()) ('codex-sync-' + [Guid]::NewGuid().ToString('N') + '.log')
    try {
        $output = & $node @syncArgs 2>$stderrFile
        if ($LASTEXITCODE -ne 0) {
            $detail = ''
            if (Test-Path -LiteralPath $stderrFile) {
                # Windows PowerShell 5.1 renders a native command's stderr as an
                # error record before it reaches the file, so drop its
                # decoration and keep the first real message lines.
                $trace = @(
                    [IO.File]::ReadAllLines($stderrFile) |
                        ForEach-Object { $_.Trim() } |
                        Where-Object { $_ -and $_ -notmatch '^(At |\+|CategoryInfo|FullyQualifiedErrorId)' } |
                        Select-Object -First 2
                )
                if ($trace.Count -gt 0) { $detail = ': ' + (($trace | ForEach-Object { $_.Trim() }) -join ' | ') }
            }
            throw "catalog sync exited with code $LASTEXITCODE$detail"
        }
        return ($output -join ' ')
    } finally {
        try { [IO.File]::Delete($stderrFile) } catch { }
    }
}

function Get-RouterConfigKeyValue {
    param([string]$Name, [string[]]$Sources)
    $pattern = "(?m)^[ \t]*" + $Name + "[ \t]*=[ \t]*('[^']*'|\x22[^\x22]*\x22)[ \t]*\r?$"
    foreach ($source in $Sources) {
        if (-not $source -or -not (Test-Path -LiteralPath $source)) { continue }
        try {
            $match = [regex]::Match([IO.File]::ReadAllText($source), $pattern)
            if ($match.Success) { return $match.Groups[1].Value }
        } catch { }
    }
    return $null
}

function Get-RouterConfigSources {
    $sources = New-Object System.Collections.ArrayList
    if (Test-Path -LiteralPath $RouterKeySnapshot) { [void]$sources.Add($RouterKeySnapshot) }
    [void]$sources.Add($CodexConfig)
    try {
        $backups = @(Get-ChildItem -LiteralPath $CodexHome -Filter 'config.toml.before-*.bak' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -ExpandProperty FullName)
        foreach ($backup in $backups) { [void]$sources.Add($backup) }
    } catch { }
    return $sources.ToArray()
}

function Repair-RouterConfigKeys {
    if (-not (Test-Path -LiteralPath $CodexConfig)) { return $false }
    $text = [IO.File]::ReadAllText($CodexConfig)
    if (-not [regex]::IsMatch($text, '(?m)^[ \t]*\[model_providers\.codex_router\][ \t]*\r?$')) { return $false }

    # Respect an explicit switch to another provider.
    $active = [regex]::Match($text, '(?m)^[ \t]*model_provider[ \t]*=[ \t]*[''\x22]([^''\x22]+)[''\x22][ \t]*\r?$')
    if ($active.Success -and $active.Groups[1].Value -ne 'codex_router') { return $false }

    $quote = [char]39
    $providerPattern = "(?m)^[ \t]*model_provider[ \t]*=[ \t]*" + $quote + "codex_router" + $quote + "[ \t]*\r?$"
    $catalogPattern = '(?m)^[ \t]*model_catalog_json[ \t]*='
    $modelPattern = '(?m)^[ \t]*model[ \t]*='
    $marker = 'disabled by official-provider fallback'
    $healthy = [regex]::IsMatch($text, $providerPattern) -and [regex]::IsMatch($text, $catalogPattern) -and [regex]::IsMatch($text, $modelPattern) -and -not [regex]::IsMatch($text, $marker)
    if ($healthy) { return $false }

    $sources = Get-RouterConfigSources
    $providerLine = 'model_provider = ' + $quote + 'codex_router' + $quote
    $catalogValue = Get-RouterConfigKeyValue -Name 'model_catalog_json' -Sources $sources
    if (-not $catalogValue) { $catalogValue = $quote + $RouterModels + $quote }
    $catalogLine = 'model_catalog_json = ' + $catalogValue

    $available = @()
    if (Test-Path -LiteralPath $RouterModels) {
        try { $available = @((Read-JsonFile -Path $RouterModels).models | ForEach-Object { $_.slug }) } catch { }
    }
    $modelValue = Get-RouterConfigKeyValue -Name 'model' -Sources $sources
    $modelName = if ($modelValue) { $modelValue.Trim([char]39, [char]34) } else { '' }
    if (-not $modelName -or ($available.Count -gt 0 -and $available -notcontains $modelName)) {
        if ($available -contains 'deepseek-flash') { $modelName = 'deepseek-flash' }
        elseif ($available.Count -gt 0) { $modelName = $available[0] }
        else { $modelName = 'deepseek-flash' }
    }
    $modelLine = 'model = ' + $quote + $modelName + $quote

    $updated = $text
    $updated = [regex]::Replace($updated, '(?m)^[ \t]*#[ \t]*model_provider[ \t]+disabled by official-provider fallback[ \t]*\r?$', $providerLine)
    $updated = [regex]::Replace($updated, '(?m)^[ \t]*#[ \t]*model_catalog_json[ \t]+disabled by official-provider fallback[ \t]*\r?$', $catalogLine)
    $updated = [regex]::Replace($updated, '(?m)^[ \t]*#[ \t]*model[ \t]+disabled by official-provider fallback[ \t]*\r?$', $modelLine)
    $missing = @()
    if (-not [regex]::IsMatch($updated, $providerPattern)) { $missing += $providerLine }
    if (-not [regex]::IsMatch($updated, $catalogPattern)) { $missing += $catalogLine }
    if (-not [regex]::IsMatch($updated, $modelPattern)) { $missing += $modelLine }
    if ($missing.Count -gt 0) {
        $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        $block = ($missing -join $newline) + $newline
        $firstTable = [regex]::Match($updated, '(?m)^[ \t]*\[')
        if ($firstTable.Success) { $updated = $updated.Insert($firstTable.Index, $block) }
        else { $updated = $updated.TrimEnd() + $newline + $block }
    }
    if ($updated -eq $text) { return $false }

    $valid = [regex]::IsMatch($updated, $providerPattern) -and [regex]::IsMatch($updated, $catalogPattern) -and [regex]::IsMatch($updated, $modelPattern) -and -not [regex]::IsMatch($updated, $marker) -and $updated.Length -ge ($text.Length / 2)
    if (-not $valid) { Write-RouterLog 'router key repair refused to write an unusable config'; return $false }
    $backup = "$CodexConfig.before-key-repair.$(Get-Date -Format yyyyMMdd-HHmmss).bak"
    Copy-Item -LiteralPath $CodexConfig -Destination $backup -Force
    [IO.File]::WriteAllText($CodexConfig, $updated, (New-Object System.Text.UTF8Encoding($false)))
    Write-RouterLog "restored the router keys in config.toml (model=$modelName; backup: $(Split-Path -Leaf $backup))"
    return $true
}

function Save-RouterConfigSnapshot {
    try {
        if (-not (Test-Path -LiteralPath $CodexConfig)) { return }
        $text = [IO.File]::ReadAllText($CodexConfig)
        $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        $lines = @()
        foreach ($name in @('model', 'model_catalog_json', 'model_provider')) {
            $pattern = "(?m)^[ \t]*" + $name + "[ \t]*=[ \t]*('[^']*'|\x22[^\x22]*\x22)[ \t]*\r?$"
            $match = [regex]::Match($text, $pattern)
            if ($match.Success) { $lines += ($name + ' = ' + $match.Groups[1].Value) }
        }
        if ($lines.Count -eq 3) { [IO.File]::WriteAllText($RouterKeySnapshot, (($lines -join $newline) + $newline), (New-Object System.Text.UTF8Encoding($false))) }
    } catch { }
}
