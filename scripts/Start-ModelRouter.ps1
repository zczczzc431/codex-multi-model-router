<#
    .SYNOPSIS
        Supervisor for the local model router. Run by a Scheduled Task.

    .DESCRIPTION
        Responsibilities:

          1. Decrypt the provider credentials (Windows DPAPI) into the child
             process environment, so the router itself never has to read an
             encrypted blob.
          2. Regenerate the model catalog from Codex's own model cache plus
             each provider config.
          3. Run src/router.js and restart it if it ever exits.

        Why a supervisor instead of just running node directly: the router
        must never be down while config.toml points at it. If the process
        dies, every model call fails until something restarts it.

        The router also watches this process (its parent) and exits when the
        supervisor goes away, which keeps orphaned routers from holding the
        port.
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

# Keep the log from growing without bound.
if ((Test-Path -LiteralPath $RouterLog) -and (Get-Item -LiteralPath $RouterLog).Length -gt 1MB) {
    Move-Item -LiteralPath $RouterLog -Destination "$RouterLog.1" -Force
}

try {
    # --- DeepSeek ---------------------------------------------------------
    if (Test-Path -LiteralPath $DeepseekKeyFile) {
        $secure = Get-Content -LiteralPath $DeepseekKeyFile -Raw | ConvertTo-SecureString
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    } else {
        $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
    }
    if (-not $env:DEEPSEEK_API_KEY) { throw 'The encrypted DeepSeek API key is not configured. Run scripts/Set-DeepSeekApiKey.ps1.' }

    # --- OpenAI-compatible relays ----------------------------------------
    # Each provider keeps its key in a DPAPI file, so no plaintext secret is
    # stored on disk or in the user environment.
    if (Test-Path -LiteralPath $RelayConfig) {
        try {
            $relay = Read-JsonFile -Path $RelayConfig
            foreach ($provider in $relay.providers.PSObject.Properties) {
                $cfg = $provider.Value
                $keyEnv = [string]$cfg.apiKeyEnv
                if (-not $keyEnv -or -not $cfg.apiKeyFile) { continue }
                $keyFile = Resolve-RouterPath -Path ([string]$cfg.apiKeyFile)
                if (-not (Test-Path -LiteralPath $keyFile)) {
                    Write-RouterLog "relay key missing for $($provider.Name) ($keyFile)"
                    continue
                }
                $sk = Get-Content -LiteralPath $keyFile -Raw | ConvertTo-SecureString
                $p2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sk)
                try { Set-Item -Path "Env:$keyEnv" -Value ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p2)) }
                finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p2) }
            }
        } catch {
            Write-RouterLog "relay config skipped: $($_.Exception.Message)"
        }
    }

    # --- WorkBuddy / CodeBuddy -------------------------------------------
    if (Test-Path -LiteralPath $WorkbuddyTokenFile) {
        try {
            $wb = Get-Content -LiteralPath $WorkbuddyTokenFile -Raw | ConvertTo-SecureString
            $p3 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($wb)
            try { $env:WORKBUDDY_AUTH_JSON = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p3) }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p3) }
        } catch {
            Write-RouterLog "workbuddy token skipped: $($_.Exception.Message)"
        }
    } else {
        Write-RouterLog 'workbuddy token file not found; those models will return 503'
    }

    $node = Resolve-NodeExe -Preferred $NodeExe

    # --- detect a Codex upgrade ------------------------------------------
    # A Codex update can change the wire format or the model cache layout, so
    # record the CLI version and restart the router when it changes.
    $codexVersion = Get-CodexCliVersion
    if ($codexVersion) {
        $previous = if (Test-Path -LiteralPath $CliVersionFile) { (Get-Content -LiteralPath $CliVersionFile -Raw).Trim() } else { '' }
        if ($previous -ne $codexVersion) {
            Write-RouterLog "Codex CLI changed: '$previous' -> '$codexVersion'"
            Set-Content -LiteralPath $CliVersionFile -Value $codexVersion -Encoding utf8
        }
    }

    # --- sync the model catalog ------------------------------------------
    # The same routine the launcher uses: re-fetch the official model list,
    # then merge every provider config into the catalog Codex reads. Shared so
    # the two entry points cannot drift apart.
    try {
        try { [void](Repair-RouterConfigKeys) } catch { Write-RouterLog "router key repair skipped: $($_.Exception.Message)" }
        Write-RouterLog "catalog sync: $(Sync-ModelCatalog)"
        Save-RouterConfigSnapshot
    } catch {
        Write-RouterLog "catalog sync skipped: $($_.Exception.Message)"
    }

    while ($true) {
        # Record a fingerprint of the running files so the launcher can tell
        # when they have changed and a restart is needed.
        $parts = @($RouterEntry, $RelayConfig, $SyncScript, $WorkbuddyAdapter, $WorkbuddyConfig, $DeepseekConfig)
        $hashes = foreach ($part in $parts) {
            if (Test-Path -LiteralPath $part) { (Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash } else { 'missing' }
        }
        Set-Content -LiteralPath $FingerprintFile -Value ($hashes -join '|') -Encoding ascii

        Write-RouterLog "starting router with $node"
        & $node $RouterEntry
        $exit = $LASTEXITCODE
        Write-RouterLog "router stopped with exit code $exit; restarting in 1 second"
        Start-Sleep -Seconds 1
    }
} catch {
    Write-RouterLog "startup failed: $($_.Exception.Message)"
    exit 1
}
