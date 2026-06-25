# M1 App Server Client

This is the first executable layer around the pinned upstream Codex runtime.
It does not change upstream source code. It launches the debug
`codex-app-server` binary over `stdio://`, performs the JSON-RPC handshake,
starts an ephemeral thread in a disposable workspace, and writes a replayable
JSONL transcript under `runs/`.

## Commands

Build the upstream server when needed:

```bash
cd upstream/openai-codex/codex-rs
cargo build -p codex-app-server
```

Run the control-plane smoke:

```bash
npm run smoke:app-server
```

Optionally ask app-server to start a turn:

```bash
npm run smoke:app-server:turn
```

Turn mode starts a local mock Responses API by default, configures
`mock_provider`, and verifies a full offline turn through `turn/completed`.

To probe the real provider boundary instead:

```bash
node scripts/app-server-smoke.mjs --start-turn --real-provider
```

That mode is useful before M2, but it may emit retry/error events if OpenAI or
company provider auth/network is not configured.

## Output

Each run creates:

- `runs/m1_app_server_smoke_<timestamp>.jsonl`: client requests, server
  responses/notifications, process events, and stderr.
- `runs/m1_app_server_smoke_<timestamp>.summary.json`: compact pass/fail
  summary with the initialized Codex home, thread id, model, and provider.

Temporary `CODEX_HOME` and workspace directories live under `/tmp` and are
removed by default. Pass `--keep-temp` to keep them for debugging.
