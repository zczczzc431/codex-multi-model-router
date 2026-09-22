<#
    .SYNOPSIS
        Persist a WorkBuddy/CodeBuddy token bundle, DPAPI encrypted.

    .DESCRIPTION
        Reads {"accessToken": "...", "refreshToken": "..."} from stdin and
        writes it DPAPI encrypted, so no plaintext secret is left on disk.

        Called by src/workbuddy-adapter.js when it refreshes an expired token.
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { Write-Error 'no input on stdin'; exit 1 }

$parsed = $raw | ConvertFrom-Json
if (-not $parsed.accessToken -or -not $parsed.refreshToken) {
    Write-Error 'token bundle is incomplete'
    exit 1
}

$json = $parsed | ConvertTo-Json -Compress
$secure = ConvertTo-SecureString -String $json -AsPlainText -Force
$encrypted = $secure | ConvertFrom-SecureString
[IO.File]::WriteAllText($WorkbuddyTokenFile, $encrypted)
exit 0