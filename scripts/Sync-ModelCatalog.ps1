<#
    .SYNOPSIS
        Rebuild the model menu from the current official model list.

    .DESCRIPTION
        Two steps:

          1. Fetch the current official model list from Codex.
          2. Merge it with the DeepSeek / relay / WorkBuddy provider configs
             into router-models.json, the file the picker reads.

        The launcher already does this on every start, so running this by hand
        is only useful when you want the new models without restarting
        anything - typically right after a Codex update, or after adding a
        provider.

        Codex reads the catalog when it starts, so restart the app to see the
        result in the menu.

    .EXAMPLE
        .\scripts\Sync-ModelCatalog.ps1
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

try {
    $summary = Sync-ModelCatalog
} catch {
    Write-Host "Catalog sync failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-RouterLog "manual catalog sync: $summary"

$catalog = Read-JsonFile -Path $RouterModels
$all = @($catalog.models)
$visible = @($all | Where-Object { $_.visibility -eq 'list' })

Write-Host ''
Write-Host $summary -ForegroundColor Green
Write-Host ("Menu: {0} entries, {1} shown in the picker." -f $all.Count, $visible.Count)
Write-Host ''
$visible | Sort-Object priority | ForEach-Object { Write-Host ("  {0,-30} {1}" -f $_.slug, $_.display_name) }
Write-Host ''
Write-Host 'Restart Codex to pick up this list.'
