# Runtime Replica Plan

## Objective

Build an internal Codex-like local coding agent by starting from the official
OpenAI Codex source tree, keeping upstream provenance intact, and layering only
the patches needed for internal model gateways, auth, TLS, product branding, and
client integration.

The detailed product and engineering plan is tracked in
`docs/codex-replica-development-spec.md`.

## Non-goals

- Do not depend on a user-installed `Codex.app`.
- Do not wrap `codex exec` as the product architecture.
- Do not migrate the existing `internal-coding-agent-client` code into this
  repo.
- Do not remove upstream license or NOTICE files.
- Do not make large unreviewable edits directly in upstream code.

## Architecture We Will Reuse First

- App-server as the long-running local runtime.
- App-server protocol for desktop/client communication.
- Core turn loop and event stream.
- Tool planning and tool dispatch.
- Approval and sandbox policy types.
- Thread and turn storage.
- Built-in patch/apply, shell execution, file search, and web search extension
  surfaces where they fit.

## Patch Areas

1. Provider gateway
   - Add or configure an internal OpenAI-compatible provider.
   - Support Ark/company model gateway base URL.
   - Keep API-key and external bearer auth paths auditable.

2. TLS and certificates
   - Document company CA handling.
   - Avoid dev-only insecure TLS bypass in formal runtime.

3. Product identity
   - Rename visible product identity in our client layer.
   - Avoid changing upstream names unless legally/product-wise required.
   - Preserve upstream attribution.

4. App-server protocol client
   - Build a minimal local client that can initialize, start a thread, start a
     turn, respond to approvals, and render events.

5. Policy and sandbox
   - Keep Codex sandbox defaults as the starting point.
   - Add internal approval profiles only as small patches.

6. Eval and audit
   - Keep every turn replayable: input, events, tool calls, approvals, stderr,
     git status, diff, model/provider metadata, and policy decisions.

## Milestones

1. Upstream mirror
   - Clone official source.
   - Pin release tag and commit.
   - Record license and provenance.

2. App-server source build
   - Build `codex-app-server` from source.
   - Run an app-server protocol smoke.

3. Minimal protocol client
   - Add a tiny local client/fixture for `initialize`.
   - Extend to `thread/start`.
   - Extend to one synthetic `turn/start` path with mocked provider or safe
     no-op flow.

4. Provider spike
   - Configure an OpenAI-compatible internal provider.
   - Verify request shape.
   - Add tests around auth resolution and base URL handling.

5. Real local turn
   - Run a local coding task through app-server.
   - Capture artifacts and approvals.
   - Compare behavior against our previous V0.9 large-task gate.

6. Cutover decision
   - Write `runtime-cutover-decision.md`.
   - Decide whether this source-level Codex route replaces, merges with, or
     stays separate from the V0.87 client runtime.

## Current Status

- Milestone 1: done.
- Milestone 2: app-server build done; protocol smoke passes with
  `RUST_MIN_STACK=67108864`.
- Milestone 3: next.
