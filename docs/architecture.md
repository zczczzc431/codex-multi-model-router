# Architecture

## The core trick

Codex resolves a model slug through a catalog file, then sends the request to
one configured provider. It does not know that different slugs belong to
different upstreams.

So: define one provider whose `base_url` is local, and let that local server
decide where each request goes.

```toml
model = "deepseek-flash"
model_catalog_json = '<codex home>/router-models.json'
model_provider = 'codex_router'

[model_providers.codex_router]
base_url = 'http://127.0.0.1:18763'
name = 'GPT + DeepSeek'
requires_openai_auth = true
wire_api = 'responses'
```

The catalog is the model menu. It is generated, not hand-written:

```
models_cache.json   (Codex's own model list, refreshed by Codex)
        +
deepseek-models.json / relay-models.json / workbuddy-models.json
        │
        ▼
  sync-model-catalog.js
        │
        ▼
  router-models.json   ← what the picker shows
```

Generated entries inherit the *shape* of a real Codex model entry, so the
picker renders them like anything else.

## Request flow

```
Codex ──POST /v1/responses──▶ router.js
                                 │
                    which slug is in the body?
                                 │
      ┌──────────────────────────┼───────────────────────────┐
      ▼                          ▼                           ▼
  a plan model            deepseek-* / relay-*            wb-*
      │                          │                           │
  forward to the          forward to the              translate to
  Codex backend           OpenAI-compatible           chat/completions,
  with the user's         upstream with that          stream back as
  existing auth           provider's key              Responses SSE
```

`workbuddy-adapter.js` is the interesting one: it is a bidirectional
translation between the Responses API and a plain streaming
`chat/completions` endpoint — request shape, tool calls, and incremental
events in both directions.

## Process model

```
Scheduled Task "Codex Model Router"
        │
        ▼
Start-ModelRouter.ps1          supervisor, runs forever
        │  decrypts credentials into the child env
        │  regenerates the catalog
        │  records a fingerprint of the running files
        ▼
    router.js  (node)          restart loop: exits are restarted
        │
        │  watches its parent: if the supervisor dies, it exits too,
        │  so an orphan cannot hold the port
        ▼
  127.0.0.1:18763
```

Why a supervisor at all: the router being down means the app is down. The
supervisor makes that a transient condition rather than a broken install.

## Why credentials are decrypted by the supervisor

Provider keys are stored with Windows DPAPI, so they are readable only by the
account that stored them.

The supervisor decrypts them and passes them to the child **through the
environment**, so `router.js` never opens an encrypted blob and no plaintext
secret is written to disk or to the user's environment.

## Restart semantics

`Activate-ModelRouter.ps1` restarts the router when any of these is true:

- `/health` does not answer
- the Codex CLI version changed (interop may have changed)
- the fingerprint of `router.js`, the adapter, the sync script, or any
  provider config changed

That last one exists because restarting the app does **not** reload the
router: the router lives under the Scheduled Task, so it is the fingerprint
check — not the app restart — that picks up an edited file. See lesson 3 in
[lessons-learned.md](lessons-learned.md).

## State and paths

Everything lives in the Codex home:

| Path | What |
|---|---|
| `router-models.json` | generated catalog (the model menu) |
| `router-models.last-good.json` | previous catalog, written before each overwrite |
| `relay-models.json`, `workbuddy-models.json`, `deepseek-models.json` | provider definitions |
| `codex-model-router.log` | router + supervisor log |
| `codex-router-files.sha256` | fingerprint of the running files |
| `*.dpapi` | DPAPI-encrypted credentials |

Resolution order is `CODEX_ROUTER_HOME`, then `CODEX_HOME`, then
`~/.codex`. Override with `CODEX_ROUTER_PORT` if 18763 is taken.
