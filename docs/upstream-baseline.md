# Upstream Baseline

## Source

- Repository: <https://github.com/openai/codex>
- Local clone: `upstream/openai-codex`
- Selected baseline: `rust-v0.140.0`
- Commit: `6506579001c322927a3e4bd440563267a7ac6c1f`
- License: Apache-2.0

The GitHub repository describes Codex CLI as a local coding agent and lists
Apache-2.0 as the repository license. The local clone preserves the upstream
`LICENSE` and `NOTICE` files.

## Why Not Main HEAD

The first clone landed on upstream `main`:

- Commit: `e2f074e16c522bfa55d9bcd344a5ea0ba5a4580f`
- Observation: app-server built, but app-server state initialization failed in
  a smoke test because `codex-rs/state/migrations` contained two `0038_*.sql`
  migrations.

That makes `main` a poor local runtime baseline for this project. We pin to the
latest stable Rust release tag found locally, `rust-v0.140.0`.

## Local Build Verification

Working directory:

```bash
cd upstream/openai-codex/codex-rs
```

Build:

```bash
cargo build -p codex-app-server
```

Result:

- Passed.
- Produced `target/debug/codex-app-server`.

Protocol smoke:

```bash
env RUST_MIN_STACK=67108864 cargo test -p codex-app-server in_process_start_initializes_and_handles_typed_v2_request -- --nocapture
```

Result:

- Passed.
- Without `RUST_MIN_STACK`, this test stack-overflows in the current local
  macOS/Rust environment.

## Relevant Upstream Modules

- `codex-rs/app-server`: local service process used by app/IDE/client surfaces.
- `codex-rs/app-server-protocol`: JSON-RPC style app-server protocol types.
- `codex-rs/protocol`: lower-level thread, turn, item, approval, sandbox, and
  auth model types.
- `codex-rs/core`: turn loop, tool planning, tool dispatch, policy, sandbox
  integration, and event mapping.
- `codex-rs/model-provider`: provider abstraction and provider auth resolution.
- `codex-rs/state`: SQLite-backed local runtime state.
- `codex-rs/thread-store`: thread history persistence.
- `codex-rs/sandboxing`, `linux-sandbox`, `windows-sandbox-rs`: sandbox
  implementation layer.
- `codex-rs/ext/web-search`: built-in web search extension.
- `codex-rs/tools`: tool schemas and tool exposure helpers.

## Immediate Implications

- We should fork from `rust-v0.140.0`, not `main`.
- The first executable target is `codex-app-server`, not the TUI.
- The first client integration target is app-server protocol handshake, then
  `thread/start`, then `turn/start`.
- Provider work should start at `model-provider`, `login`, and config parsing.
- Web/search work should inspect `ext/web-search` before adding a new tool.
