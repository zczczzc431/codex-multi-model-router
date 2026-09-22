# Adding a provider

## Case 1: an OpenAI-compatible relay (no code)

Most third-party gateways speak the same shape. Add an entry to
`relay-models.json`:

```json
{
  "providers": {
    "my-relay": {
      "host": "relay.example.com",
      "apiKeyEnv": "ROUTER_MY_RELAY_API_KEY",
      "apiKeyFile": "my-relay-api-key.dpapi"
    }
  },
  "modelDefaults": { },
  "models": [
    {
      "slug": "relay-gpt-5.4",
      "display_name": "GPT-5.4 (My Relay)",
      "description": "GPT-5.4 through my relay.",
      "router": { "provider": "my-relay", "upstream_model": "gpt-5.4" }
    }
  ]
}
```

The important fields:

- `slug` — what the model menu shows and what Codex sends back. Keep it
  prefixed so the sync knows it is router-managed.
- `router.provider` — key into the `providers` map
- `router.upstream_model` — the name the upstream expects
- `router` is stripped before the entry reaches the catalog; Codex never sees it.

`apiKeyFile` may be relative, in which case it is resolved against the Codex
home.

Then store the key and activate:

```powershell
.\scripts\Set-RelayApiKey.ps1 -Provider my-relay
.\scripts\Activate-ModelRouter.ps1
```

## Case 2: a quota channel with a different protocol

If the upstream speaks something else — plain `chat/completions` streaming, or
a vendor-specific shape — copy `src/workbuddy-adapter.js`. It is a complete
worked example of:

- accepting a Responses API request
- converting it to another request shape, tool calls included
- streaming the upstream response back as Responses API SSE events
- emitting `response.failed` correctly when things go wrong mid-stream

One design point worth copying: it does **not** write SSE headers until the
upstream has answered with 200. Writing headers first means an upstream error
can only be reported by truncating the stream, which the client sees as a
generic failure instead of the real error.

## Case 3: a plan-backed provider

Models that use the existing Codex auth are forwarded as-is in `router.js` —
no translation needed. This is how the built-in GPT models keep working
alongside the others.

## Provider config reference

```json
{
  "providers": {
    "<name>": {
      "host": "upstream.example.com",
      "apiKeyEnv": "ENV_VAR_THE_ROUTER_READS",
      "apiKeyFile": "relative/or/absolute/path.dpapi"
    }
  },
  "modelDefaults": {
    "context_window": 200000,
    "max_context_window": 200000,
    "default_reasoning_level": "medium"
  },
  "models": [
    {
      "slug": "prefix-something",
      "display_name": "Shown in the menu",
      "description": "Shown as the model description.",
      "priority": 30,
      "router": { "provider": "<name>", "upstream_model": "upstream-name" }
    }
  ]
}
```

`modelDefaults` is merged into every entry, so shared settings are written
once. Entries generated this way inherit the shape of a real Codex model entry
from `models_cache.json`, which is what makes them render correctly in the
picker.
