<#
    .SYNOPSIS
        Point Codex back at its built-in provider. Emergency escape hatch.

    .DESCRIPTION
        While the router is active, config.toml contains:

            model_provider     = 'codex_router'
            model_catalog_json = '<codex home>/router-models.json'
            model              = '<some router-only slug>'

        and codex_router.base_url points at http://127.0.0.1:18763.

        If that local process is not running, EVERY model call fails and the
        app cannot recover from inside itself. This script removes the
        dependency by commenting out those three keys, so Codex falls back to
        its built-in ChatGPT provider and stays usable.

        It is called automatically by Activate-ModelRouter.ps1 when the router
        fails to come up, and it is safe to run by hand at any time.

    .PARAMETER ProviderName
        Name of the model provider block to disable. Defaults to codex_router.
#>

[CmdletBinding()]
param(
    [string]$ProviderName = 'codex_router',
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

if (-not (Test-Path -LiteralPath $CodexConfig)) {
    throw "config.toml not found: $CodexConfig"
}

$original = [IO.File]::ReadAllText($CodexConfig)
$text = $original
$escaped = [regex]::Escape($ProviderName)

# Comment out the three keys that bind Codex to the router. Leaving the model
# slug in place would fail too, because that slug only exists in the router
# catalog, so all three have to go together.
$providerPattern = '(?m)^([ \t]*)model_provider[ \t]*=[ \t]*[''\"]' + $escaped + '[''\"][ \t]*$'
$text = [regex]::Replace($text, $providerPattern, '$1# model_provider disabled by official-provider fallback')

$catalogPattern = '(?m)^([ \t]*)model_catalog_json[ \t]*=[ \t]*[''\"].*[''\"][ \t]*$'
$text = [regex]::Replace($text, $catalogPattern, '$1# model_catalog_json disabled by official-provider fallback')

$modelPattern = '(?m)^([ \t]*)model[ \t]*=[ \t]*[''\"].*[''\"][ \t]*$'
$text = [regex]::Replace($text, $modelPattern, '$1# model disabled by official-provider fallback')

if ($text -eq $original) {
    if (-not $Quiet) { Write-Output 'config.toml already points at the built-in provider; nothing to change.' }
    exit 0
}

$backup = $CodexConfig + '.before-official-fallback.' + (Get-Date -Format yyyyMMdd-HHmmss) + '.bak'
Copy-Item -LiteralPath $CodexConfig -Destination $backup -Force
[IO.File]::WriteAllText($CodexConfig, $text, (New-Object System.Text.UTF8Encoding($false)))

Write-RouterLog ("switched config.toml back to the built-in provider (backup: " + (Split-Path -Leaf $backup) + ')')
if (-not $Quiet) { Write-Output ("Codex now uses its built-in provider. Backup: " + $backup) }