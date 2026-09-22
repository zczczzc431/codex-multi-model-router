<#
    .SYNOPSIS
        Store (or replace) the API key for an OpenAI-compatible relay.

    .DESCRIPTION
        Reads the relay provider definitions, prompts for the key of the
        selected provider, stores it DPAPI encrypted at that provider's
        apiKeyFile, then restarts the router.

        apiKeyFile may be relative, in which case it is resolved against the
        Codex home.

    .PARAMETER Provider
        Provider name from relay-models.json. Prompted for when omitted.
#>

[CmdletBinding()]
param(
    [string]$Provider
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

if (-not (Test-Path -LiteralPath $RelayConfig)) {
    throw "Relay config not found: $RelayConfig"
}

$relayConfig = Read-JsonFile -Path $RelayConfig
$providers = @($relayConfig.providers.PSObject.Properties)
if ($providers.Count -eq 0) { throw 'No relay providers are defined.' }

$chosen = $null
if ($Provider) {
    $chosen = $providers | Where-Object { $_.Name -eq $Provider } | Select-Object -First 1
    if (-not $chosen) { throw "No relay provider named '$Provider'." }
} elseif ($providers.Count -eq 1) {
    $chosen = $providers[0]
} else {
    Write-Host 'Which relay do you want to update?'
    for ($i = 0; $i -lt $providers.Count; $i++) {
        Write-Host "  [$($i + 1)] $($providers[$i].Name) - $($providers[$i].Value.host)"
    }
    $answer = Read-Host 'Number'
    $index = 0
    if (-not [int]::TryParse($answer, [ref]$index) -or $index -lt 1 -or $index -gt $providers.Count) {
        throw 'Invalid selection.'
    }
    $chosen = $providers[$index - 1]
}

if (-not $chosen.Value.apiKeyFile) { throw 'That provider has no apiKeyFile configured.' }
$keyFile = Resolve-RouterPath -Path ([string]$chosen.Value.apiKeyFile)

Write-Host "Enter the API key for $($chosen.Name) ($($chosen.Value.host)). Input is hidden:"
$secureKey = Read-Host -AsSecureString
$protected = $secureKey | ConvertFrom-SecureString
[IO.File]::WriteAllText($keyFile, $protected, [Text.Encoding]::ASCII)

$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $keyFile /inheritance:r /grant:r "*$sid`:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null

& (Join-Path $PSScriptRoot 'Activate-ModelRouter.ps1')
Write-Host "$($chosen.Name) key stored; router restarted." -ForegroundColor Green