# Codex Replica Development Spec

## Product Goal

Build an internal coding agent that can run the same class of tasks Codex runs
today: understand a repository, plan changes, edit files, run commands and
tests, recover from failures, stream progress, ask for approvals, and preserve a
replayable task history.

The product should be API-first. A user or internal system should be able to
submit a coding task through an API/SDK, attach a local workspace, and receive a
stream of events plus final artifacts. A UI can exist later, but the first
product contract is programmatic task execution.

The reason to replicate Codex is pragmatic:

- Codex is open source in the parts we need for a local runtime.
- The existing Codex behavior already satisfies the target day-to-day coding
  workflow.
- Reusing its runtime reduces risk versus designing a new agent loop from
  scratch.

## Baseline

- Upstream: `openai/codex`
- Local mirror: `upstream/openai-codex`
- Selected tag: `rust-v0.140.0`
- Selected commit: `6506579001c322927a3e4bd440563267a7ac6c1f`
- License: Apache-2.0
- Verified locally:
  - `cargo build -p codex-app-server`
  - `env RUST_MIN_STACK=67108864 cargo test -p codex-app-server in_process_start_initializes_and_handles_typed_v2_request -- --nocapture`

Do not build from upstream `main` until it is revalidated. The first inspected
`main` commit built, but had a state migration conflict in the app-server smoke.

## Product Shape

The first usable product is not a new IDE, desktop app, or TUI. It is a local
runtime plus API surface:

```text
Caller / UI / Automation
        |
        v
Internal Agent API / SDK
        |
        v
Codex App Server Protocol Adapter
        |
        v
Forked Codex Runtime
        |
        +-- model provider: OpenAI-compatible / Ark / company gateway
        +-- tools: shell, patch, file search, MCP, web search
        +-- sandbox: filesystem, network, approvals
        +-- store: threads, turns, items, artifacts, audit
```

The first integration should use Codex app-server because it already exposes the
right primitives: `initialize`, `thread/start`, `turn/start`, event streaming,
approvals, conversation history, and server notifications.

## Replication Strategy

We should not rewrite Codex. We should fork/vendor it and keep a clean patch
discipline:

1. Keep `upstream/openai-codex` as an exact pinned mirror.
2. Create our own fork or patch workspace for internal changes.
3. Keep upstream changes small, reviewable, and grouped by purpose.
4. Put product API and packaging outside the upstream mirror when possible.
5. Only patch upstream modules when a real integration boundary requires it.

## What We Can Directly Reuse

| Area | Upstream modules | Reuse level | Why |
| --- | --- | --- | --- |
| App-server runtime | `codex-rs/app-server` | Direct | Already designed for rich clients and programmatic integrations. |
| App-server protocol | `codex-rs/app-server-protocol` | Direct | JSON-RPC thread/turn/item protocol is exactly the client-runtime contract we need. |
| Core agent loop | `codex-rs/core` | Direct | Contains turn lifecycle, model/tool loop, event mapping, tool planning, and policy integration. |
| Protocol types | `codex-rs/protocol` | Direct | Thread, turn, item, approval, sandbox, user input, and config types should remain upstream-compatible. |
| Shell execution | `codex-rs/exec-server`, `codex-rs/shell-command`, `codex-rs/shell-escalation` | Direct first | Codex command execution and escalation flow are core product behavior. |
| Patch editing | `codex-rs/apply-patch` | Direct | File patching semantics are already battle-tested. |
| Sandboxing | `codex-rs/sandboxing`, `linux-sandbox`, `windows-sandbox-rs` | Direct first | Reuse default OS-enforced sandbox rather than inventing a new one. |
| Permissions model | `codex-rs/config`, `codex-rs/execpolicy` | Direct first | Existing sandbox/approval/config model is close to our desired trust boundary. |
| State and history | `codex-rs/state`, `codex-rs/thread-store`, `codex-rs/rollout` | Direct first | Gives replayable local history and thread metadata. |
| File search | `codex-rs/file-search` | Direct | Useful and low-risk local capability. |
| Tool registry and exposure | `codex-rs/tools`, `codex-rs/ext/extension-api` | Direct first | Lets us add/disable tools without changing the whole loop. |
| MCP support | `codex-rs/codex-mcp`, `rmcp-client`, `ext/mcp` | Direct later | Keep for ecosystem compatibility, enable after core API path is stable. |
| Web search extension | `codex-rs/ext/web-search` | Reuse with adaptation | Schema and event model are useful, but provider/backend assumptions need review. |
| SDK ideas | `sdk/python`, `sdk/typescript` | Reference or reuse | Useful model for API ergonomics; first internal SDK may be thinner. |

## What Needs Thin Adaptation

| Area | Adaptation | Notes |
| --- | --- | --- |
| Product name and visible identity | Replace user-visible branding in our client/API layer. Preserve upstream attribution. | Do not represent the product as official OpenAI Codex. |
| App-server transport | Start with stdio or localhost WebSocket; wrap in our own API service. | Upstream supports stdio, Unix socket, and WebSocket. |
| Client API | Add a small HTTP/SDK facade over app-server JSON-RPC. | This is our main product surface. |
| Config defaults | Set our default model provider, sandbox, approval, web search, log paths. | Avoid surprising full-access defaults. |
| Build and packaging | Provide internal scripts for building pinned `codex-app-server`. | Keep generated build artifacts out of source. |
| Logs and telemetry | Disable or redirect upstream telemetry paths; add internal audit logs. | Must avoid leaking company code or secrets. |
| Artifact format | Normalize turn event streams, diffs, command output, and final answers into our artifact contract. | Upstream history is useful, but product consumers need stable output. |
| Web search | Decide whether to use upstream web search endpoint, internal search, or GitHub/search tools. | Do not assume OpenAI-hosted web search works with company gateway. |
| Skills/plugins | Keep upstream capability but gate rollout. | Useful later, but increases product surface and security review scope. |
| State location | Put runtime state under our product home directory. | Avoid colliding with user's official `$CODEX_HOME`. |
| Error messages | Keep low-level errors but wrap product-level failures in our API response model. | Needed for automation callers. |

## What Must Be Modified

| Area | Required change | Reason |
| --- | --- | --- |
| Model provider | Add internal OpenAI-compatible provider config for Ark/company gateway. | Core product requirement: run through API/gateway, not only ChatGPT auth. |
| Auth | Support internal API keys, external bearer tokens, and secure local storage. | Upstream auth paths are OpenAI/ChatGPT-oriented. |
| TLS/CA | Support company CA without dev-only insecure TLS bypass. | Production runtime cannot depend on insecure TLS settings. |
| Model catalog/capabilities | Map company models to Codex expectations: reasoning, tool calling, parallel tools, web search support. | The agent loop depends on model capability metadata. |
| API task endpoint | Expose `create task`, `stream task`, `approve`, `interrupt`, `resume`, and `fetch artifacts`. | Product target is API-driven task execution. |
| Approval bridge | Convert app-server approval prompts into API events and API responses. | There may be no human UI in automation. |
| Artifact/audit schema | Define our own stable records for input, events, tools, approvals, command output, diff, final answer, metadata. | Needed for debugging, eval, and compliance. |
| Secret redaction | Add product-level redaction and deny-read defaults for `.env`, credentials, tokens, keys. | Company usage makes this non-negotiable. |
| Network policy | Default network off; allow scoped domains and methods when task requires it. | Mirrors Codex's security posture and reduces exfiltration risk. |
| GitHub/web tools | Add or adapt controlled GitHub/search/fetch tools if we need true GitHub lookup. | Upstream web search may not equal direct GitHub search. |
| Eval harness | Build repeatable tasks that verify real coding capability through our API. | We need proof that our fork still performs like Codex. |
| Licensing/trademark notices | Preserve Apache-2.0 license and upstream NOTICE; document modifications. | Required for responsible fork/vendor use. |

## What We Should Not Try To Copy

| Area | Reason |
| --- | --- |
| Closed Codex Web backend | Not open source. |
| OpenAI hosted cloud task infrastructure | Not part of the local open-source runtime. |
| Closed IDE extension code | Manual identifies IDE extension as not open source. |
| ChatGPT account entitlements and billing behavior | Product-specific OpenAI backend behavior. |
| Official OpenAI branding/trademark presentation | We need our own product identity. |
| OpenAI compliance/admin platform integrations | Replace with internal audit/compliance integrations if needed. |

## First API Contract

The minimum product API should be intentionally small:

### Create Task

Input:

- `workspace_path`
- `prompt`
- `model`
- `sandbox_profile`
- `approval_policy`
- optional `metadata`

Output:

- `thread_id`
- `turn_id`
- event stream URL or stream handle

### Stream Events

Events should include:

- thread started/resumed
- turn started
- agent message deltas
- reasoning summaries when available
- tool call started/completed/failed
- command stdout/stderr chunks or summaries
- file changes
- approval requested/resolved
- turn completed/failed/interrupted

### Approve Or Deny

Input:

- `thread_id`
- `turn_id`
- `approval_id`
- `decision`
- optional one-time or persistent policy scope

### Fetch Artifact

Output:

- user input
- event log
- tool call log
- command outputs
- file diff
- final message
- model/provider metadata
- sandbox and approval decisions
- errors and stderr

## Development Milestones

### M0: Baseline Pinning

Status: done.

Deliverables:

- Clone official source.
- Pin `rust-v0.140.0`.
- Verify app-server build.
- Verify app-server initialize smoke.

Exit criteria:

- `codex-app-server` builds locally.
- App-server protocol smoke passes.
- Baseline and license are documented.

### M1: Minimal API Wrapper

Status: in progress.

Deliverables:

- Internal process that launches `codex-app-server`.
- JSON-RPC client over stdio.
- API endpoint or CLI fixture for:
  - `initialize`
  - `thread/start`
  - `turn/start`
  - event stream read
  - interrupt

Current first cut:

- `scripts/app-server-smoke.mjs` launches pinned upstream app-server over
  `stdio://`.
- `npm run smoke:app-server` verifies `initialize` and `thread/start`.
- `npm run smoke:app-server:turn` starts a local mock Responses API, configures
  `mock_provider`, verifies `turn/start`, captures streamed item events, and
  waits for `turn/completed`.
- `node scripts/app-server-smoke.mjs --start-turn --real-provider` can still be
  used to probe the unresolved real-provider boundary before M2.
- Transcripts and summaries are written under `runs/`.

Exit criteria:

- A caller can submit a prompt to a local workspace and receive streamed events.
- No model-provider fork work is required yet; this may use upstream-compatible config.

### M2: Internal Provider

Status: in progress.

Deliverables:

- Internal provider config for Ark/company OpenAI-compatible gateway.
- Auth path using internal API key or bearer token.
- Company CA/TLS support.
- Model capability mapping.
- Unit tests around provider config and auth resolution.

Exit criteria:

- A real turn reaches the company gateway.
- No dev-only insecure TLS flag is required.
- Tool calling works with the selected model.

Expanded plan:

- See `docs/m2-ark-provider-api-plan.md`.
- M2 should be a directly usable release: provider registry, generated runtime
  config, HTTP/SSE task API, CLI entrypoint, Ark direct probe, Ark app-server
  turn smoke, and one disposable coding eval.

Implemented first slice:

- Provider registry for `ark` and `mock`.
- Runtime config renderer for custom Codex model providers.
- HTTP API service with `/v1/health`, `/v1/models`, `/v1/tasks`,
  `/v1/tasks/:id/events`, `/v1/tasks/:id/artifact`, and interrupt endpoint.
- CLI entrypoint through `npm run internal-codex`.
- Ark/OpenAI-style `input` adapter for `input_text` and `input_image`.
- Offline API and CLI smoke using the mock Responses provider.

### M3: Coding Task Loop

Deliverables:

- Workspace-write sandbox profile.
- Approval bridge.
- Shell, patch, file search, git diff, and test command support.
- Artifact capture for every turn.

Exit criteria:

- The agent can edit a repo, run tests, fix a failure, and produce a final diff
  through our API.

### M4: Eval Gate

Deliverables:

- Repeatable eval suite covering:
  - small code edit
  - multi-file refactor
  - real bug fix
  - test failure recovery
  - documentation update
  - safety refusal
  - approval flow
  - interrupt/resume
- JSON summary output.

Exit criteria:

- Eval passes on a clean local run.
- Failures preserve enough evidence to debug.

### M5: Search, GitHub, MCP, Skills

Deliverables:

- Decide web-search backend.
- Add controlled GitHub/search/fetch capability if needed.
- Gate MCP and skills behind explicit config.
- Add network allowlist policy.

Exit criteria:

- The agent can perform a task requiring external context without unrestricted
  network access.

### M6: Packaging And Dogfood

Deliverables:

- Build script for internal runtime binary.
- Product home directory separate from official Codex.
- Basic API/SDK docs.
- Dogfood task runner.

Exit criteria:

- A user can run the internal agent against a local repo without installing
  official Codex.

## Security Defaults

Default posture:

- Filesystem: workspace write only.
- Network: off.
- Secrets: deny-read for `.env`, token files, SSH keys, and configured secret globs.
- Approvals: on-request.
- Full access: disabled unless explicitly requested for trusted isolated runs.
- Artifacts: redact tokens and avoid storing raw credentials.

Network access should be task-scoped and domain-scoped. Prefer read-only HTTP
methods for search/fetch workflows unless a task explicitly needs more.

## Open Questions

- Should the first API be HTTP/SSE, local WebSocket, or a language SDK over stdio?
- Do we want to fork upstream in-place or maintain a clean mirror plus patch
  application scripts?
- Which company model is the first supported default?
- Does company gateway support the Responses API shape closely enough, or do we
  need a translation proxy?
- Should web search use upstream Codex web-search, company search, direct
  GitHub API, or a hybrid?
- What audit retention policy do we need for command outputs and diffs?

## Near-term Next Step

Build M1: a tiny internal app-server client that launches the pinned
`codex-app-server`, performs `initialize`, starts a thread, starts a turn, and
prints server notifications as JSONL.
