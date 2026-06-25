# M2 Ark Provider And Usable API Plan

M2 is the first version that should feel directly usable, not just a runtime
smoke. The goal is:

> A user installs our package, sets `ARK_API_KEY`, chooses one of our supported
> models, submits a coding task through CLI or HTTP API, watches streamed
> events, and receives final artifacts without installing official Codex.

The provided Ark call shape is treated as the first production provider target:

```bash
curl https://ark-cn-beijing.bytedance.net/api/v3/responses \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "ep-20260427114346-pfqwk",
    "input": [{
      "role": "user",
      "content": [
        {
          "type": "input_image",
          "image_url": "https://ark-project.tos-cn-beijing.volces.com/doc_image/ark_demo_img_1.png"
        },
        {
          "type": "input_text",
          "text": "你看见了什么？"
        }
      ]
    }]
  }'
```

## Main Product Surface

M2 should expose both CLI and HTTP API. The HTTP API is the contract future UI
and automations can use.

### Simple Task API

```http
POST /v1/tasks
Content-Type: application/json
```

```json
{
  "workspacePath": "/absolute/path/to/repo",
  "prompt": "Add a unit test for the parser and run it.",
  "model": "ep-20260427114346-pfqwk",
  "provider": "ark",
  "sandbox": "workspace-write",
  "approvalPolicy": "on-request"
}
```

Response:

```json
{
  "taskId": "task_...",
  "threadId": "019...",
  "turnId": "019...",
  "eventsUrl": "/v1/tasks/task_.../events",
  "artifactUrl": "/v1/tasks/task_.../artifact"
}
```

### OpenAI/Ark-Style Multimodal Input

The API must also accept the Ark/OpenAI-style `input` array so callers can reuse
existing request builders:

```json
{
  "workspacePath": "/absolute/path/to/repo",
  "model": "ep-20260427114346-pfqwk",
  "provider": "ark",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_image", "image_url": "https://..." },
        { "type": "input_text", "text": "你看见了什么？" }
      ]
    }
  ]
}
```

Adapter rule:

- `input_text` becomes app-server `UserInput.Text`.
- `input_image.image_url` becomes app-server `UserInput.Image`.
- local file images later become app-server `UserInput.LocalImage`.
- unsupported content types are rejected with a clear validation error.

### Event Stream

```http
GET /v1/tasks/:taskId/events
Accept: text/event-stream
```

Events are normalized from app-server notifications:

- `task.started`
- `thread.started`
- `turn.started`
- `item.started`
- `item.completed`
- `tool.started`
- `tool.completed`
- `approval.requested`
- `approval.resolved`
- `turn.diff.updated`
- `turn.completed`
- `turn.failed`

The raw app-server JSON-RPC message is preserved in the artifact log, but API
consumers should rely on normalized event names.

### Artifact API

```http
GET /v1/tasks/:taskId/artifact
```

Artifact includes:

- original request
- resolved provider/model/sandbox
- normalized events
- raw app-server transcript
- command outputs
- approval decisions
- final assistant message
- final git diff
- errors, retry metadata, timings

## Provider Config Strategy

M2 should use Codex's existing custom provider support first, avoiding upstream
patches unless Ark deviates from the OpenAI Responses protocol.

Generated `config.toml` for the happy path:

```toml
model = "ep-20260427114346-pfqwk"
model_provider = "ark"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
model_catalog_json = "/.../config/model-catalogs/ark.json"

[model_providers.ark]
name = "Volcengine Ark"
base_url = "https://ark-cn-beijing.bytedance.net/api/v3"
env_key = "ARK_API_KEY"
env_key_instructions = "Set ARK_API_KEY to a valid Volcengine Ark API key."
wire_api = "responses"
request_max_retries = 2
stream_max_retries = 1
stream_idle_timeout_ms = 300000
supports_websockets = false
```

Why this should match the provided curl:

- Codex appends `/responses` to provider `base_url`.
- `base_url = ".../api/v3"` therefore calls `.../api/v3/responses`.
- `env_key = "ARK_API_KEY"` resolves to `Authorization: Bearer <value>`.
- `wire_api = "responses"` selects the OpenAI-compatible Responses wire format.

Extensibility retained:

- `query_params` for Azure-style or gateway-specific query parameters.
- `http_headers` for static required headers.
- `env_http_headers` for header values sourced from environment variables.
- `[model_providers.<id>.auth]` for command-backed bearer tokens.
- `experimental_bearer_token` only for controlled programmatic tests, not user
  config.

## Compatibility Probe

Before declaring Ark provider support complete, M2 must run a direct probe:

1. Non-streaming text response with the user-provided curl shape.
2. Streaming Responses API response, because Codex expects streamed events.
3. Image input response using `input_image`.
4. Tool-call response compatibility, because coding tasks depend on shell,
   patch, and file-search tool calls.
5. Error shape compatibility for 401, 429, 5xx, and invalid model.

If Ark's `/responses` endpoint differs from Codex's expected SSE events, M2
must include an internal Ark Responses shim:

```text
Codex app-server
  -> local shim /v1/responses
  -> Ark /api/v3/responses
  -> normalize response/events/tool calls back to Codex-compatible SSE
```

This keeps Codex runtime unchanged while still supporting Ark variants.

## Deliverables

### 1. Provider Registry

Add a product-owned provider registry outside upstream:

- `config/providers/ark.json`
- `config/model-catalogs/ark.json`
- `scripts/render-runtime-config.mjs`

The registry should support:

- provider id
- display name
- base URL
- auth mode: env key, bearer token, command-backed token
- wire API
- websocket support
- default model
- model aliases
- model capability flags
- retry/timeouts
- optional headers/query params

### 2. Runtime API Service

Add `src/agent-server` or `scripts/agent-server.mjs`:

- owns product home, for example `~/.internal-codex-runtime`
- generates isolated `CODEX_HOME`
- starts `codex-app-server`
- exposes `/v1/health`
- exposes `/v1/models`
- exposes `/v1/tasks`
- exposes `/v1/tasks/:id/events`
- exposes `/v1/tasks/:id/artifact`
- supports interrupt in `/v1/tasks/:id/interrupt`
- persists transcripts under product home

### 3. CLI

Add a thin CLI over the API service:

```bash
internal-codex run \
  --workspace /path/to/repo \
  --model ep-20260427114346-pfqwk \
  --prompt "Fix failing tests"
```

Also support raw JSON:

```bash
internal-codex run --json request.json
```

### 4. Input Adapter

Implement request normalization:

- simple `prompt`
- OpenAI/Ark-style `input`
- mixed text/image content
- later: file attachments and local images
- reject unsupported content types before app-server sees them

### 5. Secret Redaction

M2 must never write secrets into transcripts:

- redact `ARK_API_KEY`
- redact `Authorization`
- redact provider bearer tokens
- redact configured secret header values
- avoid storing raw user env dumps

### 6. Real Ark Smoke

Add:

```bash
npm run smoke:ark:direct
npm run smoke:ark:turn
npm run smoke:ark:coding
```

Expected:

- direct Ark probe returns a text answer
- app-server turn reaches `turn/completed`
- a tiny coding task modifies a disposable repo and produces a diff

### 7. Packaging Baseline

M2 should provide one installable developer path:

```bash
npm install
npm run build:runtime
npm run agent:serve
```

The user should not install official Codex.

## Definition Of Done

M2 is done when all of these pass:

- `npm run smoke:app-server:turn` still passes with mock provider.
- `ARK_API_KEY=... npm run smoke:ark:direct` passes.
- `ARK_API_KEY=... npm run smoke:ark:turn` reaches `turn/completed`.
- `ARK_API_KEY=... npm run smoke:ark:coding` edits a disposable repo and
  returns a final diff.
- `POST /v1/tasks` works with both `prompt` and Ark-style `input`.
- `GET /v1/tasks/:id/events` streams normalized events.
- `GET /v1/tasks/:id/artifact` returns transcript, final answer, and diff.
- No official Codex install is required.
- Upstream mirror remains clean unless a deliberate fork patch is documented.

## Initial Assumptions To Validate

- Ark supports `stream: true` or equivalent SSE for `/api/v3/responses`.
- Ark tool-call event shape is OpenAI Responses-compatible enough for Codex
  tools.
- Model `ep-20260427114346-pfqwk` supports the capabilities we need for coding
  tasks, especially tool calls.
- Corporate TLS/CA works from the runtime process, or M2 adds explicit CA
  configuration.
