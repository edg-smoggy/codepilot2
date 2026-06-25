# M3 Web Client

M3 adds a local web client on top of the existing agent server. It keeps the
single-page CodePilot visual design from the provided mockup, but connects the
UI to the real task API.

## Run

```bash
npm run agent:serve -- --port 8765
```

In sandboxed development, use a project-local product home:

```bash
npm run agent:serve -- --port 8765 --product-home .runtime-home
```

Open:

```text
http://127.0.0.1:8765/
```

## Implemented

- Choose workspace, provider, model, and approval mode.
- Submit a task from the bottom input.
- Stream task events through SSE.
- Show final agent result.
- Show task history grouped by workspace.
- Open historical task details after server restart.
- Show artifact/error/raw normalized events.
- Show git diff, including simple pseudo-diffs for untracked files.
- Cancel running tasks through the existing interrupt endpoint.

## API Additions

- `GET /` serves `web/index.html`.
- `GET /v1/tasks?limit=80` lists persisted task summaries.
- `GET /v1/tasks/:id` returns the task artifact.
- `GET /v1/tasks/:id/diff` returns git status and diff data.

## Verification

- `npm run smoke:api`
- Browser UI mock task flow:
  - select `Local Mock Responses`
  - choose a workspace
  - submit prompt
  - confirm final result, history item, artifact panel, and diff panel
