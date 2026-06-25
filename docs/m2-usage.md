# M2 Usage

M2 adds a usable product layer around the pinned Codex runtime. Users do not
need to install official Codex. Our Node wrapper starts the locally built
`codex-app-server`, writes an isolated `CODEX_HOME`, and exposes CLI plus HTTP
API surfaces.

## Provider Registry

Providers live under `config/providers/`.

- `ark`: Volcengine Ark, using `ARK_API_KEY` and
  `https://ark-cn-beijing.bytedance.net/api/v3/responses`.
- `mock`: local mock Responses API for offline development and CI.

List providers:

```bash
npm run internal-codex -- models
```

Check local readiness:

```bash
npm run doctor
npm run internal-codex -- doctor --provider mock
```

Create a local env file for Ark credentials:

```bash
cp .env.local.example .env.local
```

Then set `ARK_API_KEY=...` in `.env.local`. The CLI, HTTP server, doctor, and
Ark smoke commands load `.env.local` automatically from the project root.
`npm run doctor` checks Ark by default and reports `ARK_API_KEY missing` until
the key is present. That is expected on machines that are only running offline
mock verification.

## CLI

Offline mock run:

```bash
npm run internal-codex -- run \
  --provider mock \
  --workspace /path/to/repo \
  --prompt "Say hello"
```

Ark run:

```bash
npm run internal-codex -- run \
  --provider ark \
  --model ep-20260427114346-pfqwk \
  --workspace /path/to/repo \
  --prompt "Inspect this repo and summarize it."
```

Raw JSON request:

```bash
npm run internal-codex -- run --json request.json
```

The JSON request may use either `prompt` or Ark/OpenAI-style `input`.

## HTTP API

Start the API server:

```bash
npm run agent:serve -- --port 8765
```

Create a task:

```bash
curl http://127.0.0.1:8765/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "workspacePath": "/path/to/repo",
    "provider": "mock",
    "prompt": "Say hello",
    "approvalPolicy": "never"
  }'
```

Stream events:

```bash
curl -N http://127.0.0.1:8765/v1/tasks/<taskId>/events
```

Fetch artifact:

```bash
curl http://127.0.0.1:8765/v1/tasks/<taskId>/artifact
```

## Ark-Style Input

The API accepts the input shape from the Ark Responses API:

```json
{
  "workspacePath": "/path/to/repo",
  "provider": "ark",
  "model": "ep-20260427114346-pfqwk",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_image",
          "image_url": "https://ark-project.tos-cn-beijing.volces.com/doc_image/ark_demo_img_1.png"
        },
        {
          "type": "input_text",
          "text": "What do you see?"
        }
      ]
    }
  ]
}
```

`input_text` becomes app-server text input. `input_image.image_url` becomes
app-server image input.

## Smoke Commands

```bash
npm run smoke:api
npm run smoke:ark:direct
npm run smoke:ark:turn
npm run smoke:ark:coding
```

The Ark smoke commands skip when `ARK_API_KEY` is not set. With a key, they
exercise direct Ark HTTP, an app-server turn, and a disposable coding task.

## Current Verification

Verified locally:

- `npm run internal-codex -- models`
- `npm run smoke:api`
- `npm run internal-codex -- run --provider mock --prompt "..."`
- `npm run internal-codex -- doctor --provider mock`
- `npm run smoke:ark:direct` skips cleanly without `ARK_API_KEY`
- `npm run smoke:ark:turn` skips cleanly without `ARK_API_KEY`
- `npm run smoke:ark:coding` skips cleanly without `ARK_API_KEY`
- `npm run doctor` reports missing `ARK_API_KEY` when the Ark key is absent

Real Ark turn/coding verification still requires `ARK_API_KEY` and network
access.
