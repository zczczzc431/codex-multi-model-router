# codex-multi-model-router

Put DeepSeek, Kimi, GLM, Hunyuan and any OpenAI-compatible relay into Codex's
own model picker, next to the GPT models you already have — and switch between
them mid-task without restarting the app.

Codex reads its model list from a catalog file and sends every request to a
single configured provider. This project runs a small local server that *is*
that provider, holds the real credentials, and forwards each request to
whichever upstream the selected model belongs to. To Codex it looks like one
provider with a lot of models.

    ┌──────────────┐   model slug    ┌────────────────────┐
    │  Codex app   │ ──────────────▶ │  localhost:18763   │
    │  (any model  │                 │  router            │
    │   in the     │ ◀────────────── │                    │
    │   menu)      │   SSE stream    └─────────┬──────────┘
    └──────────────┘                           │
                                               ├─▶ ChatGPT / Codex backend   (your plan)
                                               ├─▶ DeepSeek API              (own key)
                                               ├─▶ any OpenAI-compatible relay
                                               └─▶ CodeBuddy / WorkBuddy      (cheap quota)

## Why this exists

The point is not "more models". It is **not losing your work when you switch**.

Without this, trying a different model means editing `config.toml` and
restarting Codex, which drops the conversation you were in the middle of.
With this, the model picker just works, and switching keeps the task open.

The second reason is cost. Cheaper models are perfectly good at a lot of
tasks. Having them one menu click away makes it practical to use them.

## What you get

- A model menu that mixes plan-backed GPT models with key-backed and
  quota-backed ones
- Switching models inside a running task
- Per-provider model definitions in JSON, so adding a model is a config edit
- Credentials stored with Windows DPAPI, never in plaintext on disk
- A catalog that regenerates itself after a Codex upgrade

## Requirements

- Windows (the credential storage and launcher scripts are Windows-specific)
- Node.js 18+
- Codex desktop, tested against `0.155.x`

## Quickstart

```powershell
# 1. Put the provider configs where the router expects them
Copy-Item .\examples\deepseek-models.json  $env:USERPROFILE\.codex\
Copy-Item .\examples\relay-models.json     $env:USERPROFILE\.codex\
Copy-Item .\examples\workbuddy-models.json $env:USERPROFILE\.codex\

# 2. Store your DeepSeek key (hidden prompt, DPAPI encrypted)
.\scripts\Set-DeepSeekApiKey.ps1

# 3. Register the supervisor as a Scheduled Task
.\install\Register-RouterTask.ps1

# 4. Point Codex at the router
#    Append examples\config.toml.snippet to $env:USERPROFILE\.codex\config.toml

# 5. Start
.\scripts\start-codex.cmd
```

Use `start-codex.cmd restart` when you change router code: closing the desktop
app does **not** kill the `codex.exe` backend that hosts the router, so edited
code would otherwise never be reloaded.

## The part that actually matters: not bricking the app

Once `config.toml` says `model_provider = 'codex_router'`, every model call
goes to `127.0.0.1:18763`. If that process is not running, **Codex cannot talk
to any model at all**, and you cannot fix it from inside the app, because the
thing you would ask for help is the thing that is broken.

This is not hypothetical. It is the failure this project spent the most effort
on. The design that came out of it:

| Guard | What it prevents |
|---|---|
| Supervisor process that restarts the router if it exits | A crash leaving a dead port |
| Launcher verifies `/health` **before** opening the app | Starting the app into a broken state |
| Stale-port reaper (`EADDRINUSE`) | A half-dead old instance blocking the new one |
| Automatic fallback to the built-in provider when the router will not start | Being locked out |
| `Use-OfficialProvider.ps1` escape hatch | Manual recovery, always available |
| Startup repair of a `config.toml` that points at a dead local proxy | Third-party switchers rewriting your config |

Read [docs/lessons-learned.md](docs/lessons-learned.md). It documents each of
these as a concrete bug that was hit in practice, including two that were
silently broken for a long time because the failure path was never exercised.

## Repository layout

    src/
      router.js                 the local provider: routing + Responses API passthrough
      workbuddy-adapter.js      Responses API  <->  chat/completions translation
      sync-model-catalog.js     rebuilds the model catalog Codex reads
      paths.js                  every path, resolved from CODEX_HOME
    scripts/
      _common.ps1               shared path + helper resolution
      Start-ModelRouter.ps1     supervisor (Scheduled Task runs this)
      Activate-ModelRouter.ps1  health check, restart, repair, fallback
      Start-Codex-WithModels.ps1 launcher, including full restart
      Use-OfficialProvider.ps1  escape hatch back to the built-in provider
      Set-*.ps1, Save-*.ps1     credential entry points
      start-codex.cmd           double-clickable wrapper
    install/                    Scheduled Task registration
    examples/                   provider config templates + config.toml snippet
    docs/                       architecture, lessons, troubleshooting

Every path resolves from `CODEX_HOME` (or `CODEX_ROUTER_HOME`, or
`~/.codex`). Nothing is hardcoded to a user or a machine.

## Adding a provider

Three cases, in increasing order of effort:

1. **OpenAI-compatible relay** — add an entry to `relay-models.json`. No code.
2. **Another cheap quota channel** — copy `workbuddy-adapter.js`; it is a
   complete worked example of translating between two streaming protocols.
3. **A provider with its own protocol** — add a branch in `router.js`.

See [docs/adding-a-provider.md](docs/adding-a-provider.md).

## Honest limitations

- **Windows only.** DPAPI and the launcher scripts. The Node router itself is
  portable, but the credential handling is not.
- **Interop, not an official API.** The Codex-side behaviour was determined by
  observation. A Codex update can change the wire format. That is why the
  supervisor records the CLI version and restarts on change, and why the
  fallback path exists.
- **The WorkBuddy adapter talks to a specific vendor endpoint** that may change
  without notice. It is included as a worked example and as something the
  author actually uses; treat it as the least stable part.
- **Not affiliated with OpenAI, DeepSeek or Tencent.** Model names and
  endpoints belong to their owners. You supply your own keys and are
  responsible for complying with each provider's terms.

## License

MIT. See [LICENSE](LICENSE).
