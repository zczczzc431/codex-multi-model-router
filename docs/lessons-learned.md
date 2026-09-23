# Lessons learned

Every item here is a real failure hit while building and running this, not a
theoretical concern. The order is roughly "how much time it cost".

## 1. A localhost dependency in `config.toml` is a single point of failure

Once `model_provider = 'codex_router'` with
`base_url = 'http://127.0.0.1:18763'` is in `config.toml`, the app's ability
to talk to *any* model depends on one local process.

When that process is not up:

- every request fails
- the app cannot fix itself, because asking the model for help is the broken thing
- there is no error message that says "your local router is down"

**What we do about it:** the router must never be the reason the app is
unusable. Concretely: a supervisor restarts it, the launcher verifies
`/health` *before* opening the app, and if the router will not come up the
launcher rewrites `config.toml` back to the built-in provider rather than
leaving the app pointed at a dead port.

**Generalisation:** if you insert a local component into someone else's
critical path, you own the recovery path too.

## 2. An untested failure path is a broken failure path

The escape hatch — the script whose whole job is "get me out of a broken
state" — was silently non-functional. Two separate corruptions:

```powershell
# the path literal had lost every backslash
$configPath = 'C:UsersAdministrator.codexconfig.toml'

# and the patterns could never match: '(s*)' instead of '([ \t]*)'
$text = [regex]::Replace($text, "(?m)^(s*)model_providers*=s*'codex_router's*$", ...)
```

It threw `config.toml not found` immediately, every time it ran. Nobody
noticed, because it only runs when something else has already gone wrong.

It was found by actually running it during a review, not by reading it.

**What we do about it:** the fallback is now exercised deliberately, and
`Activate-ModelRouter.ps1` calls it on the real failure path so the two cannot
drift apart.

**Generalisation:** the recovery path needs a test at least as much as the
happy path — more, because it is only ever used when you are already in
trouble and have the least patience for debugging.

## 3. On Windows, closing an app does not kill its child processes

A `node.exe` MCP bridge runs as a child of `codex.exe`, which is itself a child
of the desktop app. Killing the desktop app does **not** necessarily kill that
tree.

Consequence: if you edit the bridge code and then "restart the app", the old
code may still be running and your change appears not to work.

The router has a different shape, and it is worth being precise about it: it
runs under the Scheduled Task supervisor, so it outlives the app entirely.
Edited router files are therefore *not* reloaded by restarting the app — the
launcher's fingerprint check is what reloads them.

**What we do about it:** the restart path also closes the backend by matching
`codex.exe` processes whose parent is the app (so a CLI session the user
started themselves is left alone) and `node.exe` processes whose command line
mentions the bridge.

**Nuance worth recording:** in practice the app *does* usually clean up its own
children, so the extra step reported "closed 0 processes". The code is a
guard for the cases where it does not — a forced kill, or a crash — not a fix
for something that always happens. It was worth keeping, but the honest
description is "belt and braces", not "necessary fix".

## 4. PowerShell reads files with the ANSI codepage, not UTF-8

`Get-Content -Path x -Raw` in Windows PowerShell 5.1 decodes using the system
ANSI codepage. On a Chinese-locale machine that is GBK. A UTF-8 file without a
BOM is then decoded wrongly.

Observed:

```
config contains : GPT-5.4 (示例站)
Get-Content gave: GPT-5.4 (绀轰緥绔?
```

That is not just cosmetic. A GBK lead byte consumes the *next* byte, so if the
byte after a multi-byte character happens to be a `"`, the quote is swallowed
and the JSON becomes unparseable:

```
Invalid object passed in, ':' or '}' expected. (15914)
```

This is invisible in PowerShell 7, which defaults to UTF-8 — so it reproduces
only when the script runs under `powershell.exe`, which is exactly what the
Scheduled Task and the `.cmd` wrapper use.

**What we do about it:** never parse a config with `Get-Content`. Use
`[IO.File]::ReadAllText($path)`, which defaults to UTF-8 with BOM detection.
Centralised as `Read-JsonFile` in `scripts/_common.ps1`.

**Generalisation:** "it works in my shell" is not a test when there are two
PowerShell editions with different defaults on the same machine.

## 5. A tool's config directory does not follow your working directory

The CodeBuddy CLI wrote its whole state tree to
`%USERPROFILE%\.codebuddy` — logs, per-project conversation copies, shell
snapshots, traces, and a 52 MB plugin cache. One dispatch added roughly
200 KB to several MB there.

Passing a different `cwd` changed nothing, because it is the CLI's *home*,
not its working directory. Measured: one real dispatch added **213 KB** to C:
while the intended output directory was on another drive entirely.

**What we do about it:** `CODEBUDDY_CONFIG_DIR` relocates the whole tree.
Set it in the child process environment:

```js
env: { ...process.env, CODEBUDDY_CONFIG_DIR: CODEBUDDY_HOME }
```

Verified after the change: the same dispatch added **0 bytes** to C: and the
entire state tree appeared under `codebuddy-home` on the other drive.

**Generalisation:** when you shell out to a tool, its disk footprint is
governed by its own configuration, not by where you point it. If disk usage
matters, look for the home-directory override — do not assume `cwd` covers it.

**And measure it:** the first guess about the cause was wrong. The residual
C-drive writes turned out to come from the vendor's *desktop app* keeping its
own heartbeat log — a steady ~1 line/minute that no amount of bridge
configuration could stop, and small enough to leave alone. Only a before/after
byte count with a no-op control separated the two.

## 6. Merging generators cannot bootstrap

The catalog sync merged provider models into the existing catalog, and threw
if the result contained no models for a provider. On a fresh install there is
no existing catalog, so it could not create one — the tool required the output
of a previous run to produce its output.

It worked on the machine it was written on precisely because that machine had
been set up by hand first.

**What we do about it:** a missing catalog is treated as empty, and each
provider group falls back to the provider config to seed itself. A provider
that is neither configured nor present is skipped with a warning instead of
failing the whole sync.

**Generalisation:** "works on my machine" often means "works on a machine that
was configured by hand before the automation existed". Test the first run, not
the second.

## 7. Stale listeners block replacements

When the router is restarted, the old process may still hold the port for a
moment. The replacement then dies with `EADDRINUSE`, and because
`config.toml` points at that port, the app is dead.

**What we do about it:** wait for the port with a bounded loop, then force-clear
whatever still holds it, then start the replacement. Measured effect: restart
time dropped from ~30 s to ~9 s, and the failure mode disappeared.

## 8. Log the version of the thing that can break your interop

The Codex-side wire format was determined by observation. A Codex update can
change it.

**What we do about it:** the supervisor records the CLI version at startup. If
it changed, the router is restarted and the change is written to the log. That
turns "it broke mysteriously after an update" into a line in a file.

## 9. Overriding a tool's file takes over everything that file's owner did

The catalog is generated from Codex's own model list, and the assumption was
that the list refreshes itself: the supervisor records the CLI version, notices
a Codex upgrade, and resyncs. That assumption was wrong, and it failed
silently.

Codex rewrites `models_cache.json` only when *it* fetches the remote catalog.
Once `model_catalog_json` redirects the model list to our generated file, that
fetch stops happening, and the cache is left frozen at whatever models existed
when the redirect was installed. So:

- a Codex upgrade does not refresh it — the fetch is triggered by the catalog
  request, not by the new binary
- models the vendor ships afterwards never reach the menu
- nothing errors; the menu is simply stale

Measured on the real machine: after a Codex app update plus restart, the cache
timestamp was unchanged, while two new models were already available to the
same account.

**What we do about it:** the launcher fetches the official list itself on every
start. It runs the CLI's catalog dump inside a throwaway `CODEX_HOME` seeded
with a copy of `auth.json`, which is unaffected by the redirect, and deletes
that directory — credential copy included — in a `finally` block. If the fetch
fails, it falls back to the existing cache so an offline machine keeps the menu
it already had.

**Generalisation:** if you override a file the tool normally maintains, assume
the tool stops maintaining it. Every refresh, migration and cleanup that used
to happen is now yours.

## 10. Another app's install path is not stable across updates

Codex installs its CLI into a directory named after a content hash:

```
%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
```

One update rotated that hash and deleted the previous directory. Anything still
holding the old path — a config value, a wrapper script, an environment
variable — now points at a file that does not exist.

The failure is confusing because it is *selective*. The app updates its own
`config.toml` entry automatically, so Codex itself keeps working, and only the
side integrations break. Nothing reports "the path you stored is gone"; you get
a file-not-found from an unrelated corner of the setup, minutes later.

**What we do about it:** resolve the executable at use time instead of storing
it — newest `bin\<hash>\codex.exe`, then `codex` on `PATH` as a fallback. Same
principle as resolving `CODEX_HOME` at runtime instead of baking in
`~/.codex`.

**Generalisation:** treat paths into another application's install directory as
a cache, not as configuration. Hash-suffixed and version-managed paths are
*expected* to move.

## 11. Capturing a process's output also decides how it gets decoded

The official-catalog fetch above worked perfectly when run by hand and failed
silently in the Scheduled Task. Same script, same CLI, same file.

Measured symptoms:

- the menu quietly reverted to the stale cache
- the new fetch had been written to log *why* — `official fetch threw: Invalid
  object passed in, ':' or '}' expected. (10335)` — but only after the first
  version was fixed to stop failing silently (see below)
- running the identical command from an interactive shell produced 9 models and
  parsed fine

The cause is in the capture, not the command. Windows PowerShell decodes a
native command's stdout using `[Console]::OutputEncoding`. Interactive shell:
UTF-8. Scheduled Task: the ANSI codepage, GBK here. The CLI emits UTF-8, so GBK
decoding mangles it, a lead byte consumes the following character, and
`ConvertFrom-Json` rejects valid JSON.

Control experiment, both arms in the same PowerShell 5.1 with
`[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)`:

| Capture | Result |
|---|---|
| `& $exe debug models \| Out-String` | parse fails at the same offset as the log (10335) |
| `Start-Process -RedirectStandardOutput $file`, then `[IO.File]::ReadAllText` | parses, 9 models |

That is lesson 4 one layer out: lesson 4 was reading *files* with the wrong
decoder, this is reading *process output* with the wrong decoder. The fix is
the same shape — bypass PowerShell's decoder, read the bytes as UTF-8.

**Second failure worth naming:** the fetch failure was silent. The helper
returned `$null`, the caller fell back to the cache, and the menu just looked
old. Nothing said "the fetch failed". A fallback that does not say it ran is
indistinguishable from the feature not existing. Every failure path in the
fetch now logs its reason.

**Generalisation:** when you capture another process's output you are also
choosing its encoding, and the default comes from your host, not from the
program. If the two disagree, you get corruption, not an error. Prefer handing
the child a file or a pipe you control.

**And:** when a fallback triggers, log it. Silent degradation trains everyone
to distrust the feature.

## Checklist distilled

If you are doing the same kind of thing:

- [ ] Assume the local component will be down while the user needs it. Design
      the fallback first.
- [ ] Actually run the recovery path. Corrupted-but-never-executed code is
      common.
- [ ] Know which of your processes survive a "restart". On Windows, children do.
- [ ] Read config as UTF-8 explicitly. `Get-Content` is not UTF-8.
- [ ] Find each external tool's home-directory override, and measure disk
      impact before/after with a control.
- [ ] Test the first run, not just the second.
- [ ] Bound and force-clear port waits.
- [ ] Record versions of anything you interoperate with.
- [ ] When you make a change, verify the *effect* with numbers, not that the
      change ran.
- [ ] If you override a file the tool maintains, take over whatever that
      maintenance used to do — and check that it was doing something.
- [ ] Never store another app's hashed install path. Resolve it when you use it.
- [ ] Test the *empty* case of a config, not just a populated one: an empty
      result must fall back, not silently wipe the thing it replaced.
- [ ] Never capture another process's output through a PowerShell pipeline when
      the payload is UTF-8 and the host may not be: redirect to a file instead.
- [ ] Log every fallback the moment it triggers, with the reason it triggered.
