# Troubleshooting

**Start here: is the router answering?**

```powershell
Invoke-RestMethod http://127.0.0.1:18763/health
```

`status = ok` means the router is up. Anything else, read on.

## Codex cannot reach any model

Almost always the router is down while `config.toml` still points at it.

```powershell
# what is Codex actually pointed at?
Select-String -Path $env:USERPROFILE\.codex\config.toml -Pattern '^(model|model_provider|model_catalog_json)'
```

If `model_provider = 'codex_router'` and `/health` fails:

```powershell
.\scripts\Activate-ModelRouter.ps1     # repair, restart, or fall back
```

If that does not work, get out first and diagnose after:

```powershell
.\scripts\Use-OfficialProvider.ps1     # back to the built-in provider
```

Then read the log:

```powershell
Get-Content $env:USERPROFILE\.codex\codex-model-router.log -Tail 40
```

## The log says `EADDRINUSE`

Something else holds the port — usually a previous instance that has not
exited. `Activate-ModelRouter.ps1` handles this, but to do it by hand:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 18763 |
  Select-Object OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## Router is up but one provider returns 401 / 403

The credential for that provider is missing, or was stored by a different
Windows account (DPAPI is per-user).

```powershell
.\scripts\Set-DeepSeekApiKey.ps1
.\scripts\Set-RelayApiKey.ps1 -Provider <name>
```

The supervisor logs `relay key missing for <provider>` when a key file is not
where the config says it is.

## A model I added does not appear in the menu

The catalog only regenerates when the supervisor starts, or when the launcher
notices the fingerprint changed.

```powershell
.\scripts\Activate-ModelRouter.ps1     # notices the config change, restarts, resyncs
```

Then confirm it made it in:

```powershell
(Get-Content $env:USERPROFILE\.codex\router-models.json -Raw | ConvertFrom-Json).models.slug |
  Where-Object { $_ -like 'relay-*' }
```

If a provider config is unreadable, the sync keeps the previous entries for
that provider rather than dropping them — so a missing model usually means the
config never parsed. Check the log for `catalog sync`.

## I edited router.js and nothing changed

The router runs under the Scheduled Task supervisor, not under the app. It is
reloaded by the launcher's fingerprint check, so simply running the launcher
again is enough:

```powershell
.\scripts\start-codex.cmd
```

If the log still shows the old behaviour, confirm the router process actually
restarted, and check that the file is in the fingerprint set (the router
entry, the adapter, the sync script, and the provider configs):

```powershell
Get-Content $env:USERPROFILE\.codex\codex-router-files.sha256
Get-Content $env:USERPROFILE\.codex\codex-model-router.log -Tail 20
```

Verify the running code is actually new:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'workbuddy-bridge|router.js' } |
  Select-Object ProcessId, CreationDate
````

## Display names look like garbage (`GPT-5.4 (绀轰緥绔?`)

You are reading a UTF-8 config with a codepage-dependent reader. Use
`[IO.File]::ReadAllText`, not `Get-Content`. See
[lessons-learned.md](lessons-learned.md) item 4.

## How to get out completely

```powershell
.\scripts\Use-OfficialProvider.ps1
Stop-ScheduledTask -TaskName 'Codex Model Router'
Unregister-ScheduledTask -TaskName 'Codex Model Router' -Confirm:$false
```

Codex is then back to its normal single-provider setup, and the extra models
disappear from the menu on the next start.
