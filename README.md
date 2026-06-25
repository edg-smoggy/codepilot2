# Internal Coding Agent Codex Runtime

This project is the source-level Codex runtime track.

The goal is to use the official open-source OpenAI Codex codebase as the
reference and local baseline, then build an internal Codex-like runtime/client
that we can run, patch, audit, and adapt for company model gateways.

This is intentionally separate from `internal-coding-agent-client`.

## Current Baseline

- Upstream repository: <https://github.com/openai/codex>
- Local upstream clone: `upstream/openai-codex`
- Pinned tag: `rust-v0.140.0`
- Pinned commit: `6506579001c322927a3e4bd440563267a7ac6c1f`
- License: Apache-2.0, preserved in `upstream/openai-codex/LICENSE`

## Verified Locally

From `upstream/openai-codex/codex-rs`:

```bash
cargo build -p codex-app-server
env RUST_MIN_STACK=67108864 cargo test -p codex-app-server in_process_start_initializes_and_handles_typed_v2_request -- --nocapture
```

Results:

- `codex-app-server` builds successfully from source.
- The app-server in-process initialize/config-read smoke passes.
- `RUST_MIN_STACK=67108864` is required for this test on the current local
  macOS/Rust environment.

## First Runtime Smoke

The first local development entrypoint wraps upstream `codex-app-server`
without modifying upstream code:

```bash
npm run smoke:app-server
```

This starts app-server over `stdio://`, performs `initialize`, starts an
ephemeral thread in a disposable workspace, and writes transcripts to `runs/`.

Optional turn smoke:

```bash
npm run smoke:app-server:turn
```

Turn mode starts a local mock Responses API, configures `mock_provider`, and
verifies `turn/start`, streamed item events, and `turn/completed` without
requiring external network or model credentials. M2 will replace this mock with
an internal provider path.

## M2 API And CLI

M2 adds a usable wrapper layer:

```bash
npm run internal-codex -- models
npm run internal-codex -- run --provider mock --prompt "Say hello"
npm run internal-codex -- doctor --provider mock
npm run agent:serve -- --port 8765
```

Ark is configured through `config/providers/ark.json` and uses
`ARK_API_KEY` with `https://ark-cn-beijing.bytedance.net/api/v3/responses`.
See `docs/m2-usage.md`.

ModelHub GPT-5.5 is configured through `config/providers/modelhub-gpt55.json`.
Because that endpoint exposes a chat/messages-shaped `crawl` API rather than
OpenAI Responses directly, the runtime starts a local crawl-to-Responses adapter
and reads `MODELHUB_AK` from the environment.

## Direction

We are not writing a thin wrapper around an installed `codex` binary. The
target is a source-level fork/vendor route:

1. Keep an exact upstream mirror and pinned baseline.
2. Build app-server and protocol smoke tests from source.
3. Add a small internal patch layer for provider/auth/TLS/product branding.
4. Preserve upstream provenance and keep patches auditable.
5. Build our own local client surface on top of the app-server protocol.

See:

- `docs/upstream-baseline.md`
- `docs/m1-app-server-client.md`
- `docs/m2-ark-provider-api-plan.md`
- `docs/m2-usage.md`
- `docs/codex-replica-development-spec.md`
- `docs/runtime-replica-plan.md`
