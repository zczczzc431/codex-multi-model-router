<#
    .SYNOPSIS
        Store (or replace) the DeepSeek API key.

    .DESCRIPTION
        The key is encrypted with Windows DPAPI, so it is only readable by the
        account that stored it. No plaintext secret ever touches the disk or
        the user environment.

        After saving, the router is restarted so it picks up the new key.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

Write-Host 'Enter the DeepSeek API key. Input is hidden:'
$secureKey = Read-Host -AsSecureString
$protectedKey = $secureKey | ConvertFrom-SecureString
[IO.File]::WriteAllText($DeepseekKeyFile, $protectedKey, [Text.Encoding]::ASCII)

$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $DeepseekKeyFile /inheritance:r /grant:r "*$sid`:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null

Stop-ScheduledTask -TaskName $RouterTaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName $RouterTaskName

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-RouterUp) { $ready = $true; break }
}
if (-not $ready) { throw 'The model router did not come up with the new key.' }

Write-Host 'DeepSeek key stored (DPAPI encrypted); router restarted.' -ForegroundColor Green