# November 2026 maintenance

Validated on Windows with Codex CLI `0.166.0-alpha.6` on 2026-11-06.
The local health check and desktop/theme integration passed. Automated routing
tests cover DSML translation, tool-output replay, foreign item IDs, provider
reasoning formats and catalog changes. They do not establish live availability
or account access for every upstream model.

## Switching models

- Visible messages and tool results are retained by the bounded in-process
  context bridge where available. Provider-specific encrypted reasoning is not
  portable between providers.
- The bridge is in memory, bounded to 128 entries / 32 MiB by default. After a
  restart or eviction, an incremental continuation may require complete history
  to be resent. A reported missing-history error must not be treated as success.
- An entry in the model menu does not grant upstream account access.
- The launcher and supervisor now share the same ordered fingerprint file list,
  including `context-switch.js`, `dsml.js` and `paths.js`. Reopening the launcher
  should not restart the router merely because their file lists disagree.

## Slow requests

`/health` checks the local process only. It does not test upstream inference.
`upstream overloaded` and `ECONNRESET` indicate errors observed on the upstream
connection; they do not by themselves distinguish network, proxy and server
causes. GPT/relay overload retries currently allow up to three total attempts.
Before the stream is committed, initial events can be buffered for up to 20
seconds; reasoning/text/tool output commits it sooner. No automatic switch to
another provider is performed, avoiding an unrequested billing or context change.

## Appearance

The separately distributed [Deep Dive theme](https://github.com/zczczzc431/codex-deep-dive-theme)
does not ship credentials or routing configuration. Its runtime injection needs
to be reapplied after a Codex restart. A successful structural check is not a
guarantee of compatibility with future Codex releases.
