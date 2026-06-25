# CodePilot AI Handoff Analysis

Last updated: 2026-06-24

## 1. Executive Summary

CodePilot is an internal desktop client that wraps the open-source OpenAI Codex app-server/runtime and routes model calls to internal providers such as ModelHub GPT-5.5 and Volcengine Ark.

The product direction is sound: reuse Codex's local agent runtime, tool loop, workspace access, diff/history model, and desktop client behavior, while replacing the model provider and adding company-specific packaging, provider config, and local UX.

The current blocker is not the frontend. The core reliability issue is:

> The runtime sometimes treats a model's intermediate natural-language message as task completion, even when required artifacts were not actually produced.

This is especially visible on compound tasks such as:

```text
写个html小游戏吧，再把游戏介绍写个飞书文档和md文件，都要
```

In a 10-run real test against ModelHub GPT-5.5, the task completed successfully 0/10 times. Some runs timed out at ModelHub, while others entered the tool loop but failed to deliver all required artifacts.

The next version should focus on completion verification and ModelHub adapter robustness, not on adding more UI features.

## 2. Current Architecture

CodePilot currently has these layers:

```text
Desktop/Web UI
  -> Node agent server
  -> OpenAI Codex app-server binary
  -> Codex core tool loop
  -> Provider config
  -> Ark Responses API OR local ModelHub crawl adapter
  -> Internal model
```

Important paths:

| Area | Path |
|-|-|
| Task lifecycle | `src/agent-server/task-manager.mjs` |
| Local HTTP server | `src/agent-server/server.mjs` |
| Codex app-server bridge | `src/runtime/app-server-client.mjs` |
| ModelHub adapter | `src/runtime/modelhub-crawl-adapter.mjs` |
| Provider config | `config/providers/*.json` |
| Web frontend | `web/app.js`, `web/styles.css`, `web/index.html` |
| macOS wrapper | `desktop/macos/CodePilotApp.swift` |
| Upstream Codex source | `upstream/openai-codex/` |

Both Ark and ModelHub providers currently set:

```json
"codexInstructions": "upstream-default"
```

That means CodePilot is already using upstream Codex base instructions, not a completely custom prompt.

## 3. Prompt Analysis

Codex's "prompt" is not just one Markdown file. It is assembled at runtime.

The visible base prompt is here:

```text
upstream/openai-codex/codex-rs/models-manager/prompt.md
```

But the actual model-visible context also includes:

- developer messages for permissions and sandbox rules
- collaboration mode instructions
- personality instructions
- available skills
- available plugins
- apps/connectors instructions
- AGENTS.md / project instructions
- environment context such as cwd, shell, date, filesystem permissions
- tool schemas
- conversation history and turn context

The runtime assembly path is mainly:

```text
upstream/openai-codex/codex-rs/core/src/session/mod.rs
```

Therefore, copying only the static base prompt is insufficient. Codex works because it combines prompt, context, tools, runtime events, approvals, sandbox, history, and artifact tracking.

CodePilot already inherits much of this through the Codex app-server, but ModelHub introduces an adapter layer that can weaken the protocol semantics.

## 4. ModelHub Adapter Risk

ModelHub GPT-5.5 is reached through:

```text
src/runtime/modelhub-crawl-adapter.mjs
```

This adapter converts Codex Responses-style requests into ModelHub crawl/chat-style requests and converts tool calls back.

Known risks:

- Responses `input` items are translated into chat messages.
- `developer` and `system` semantics may be flattened.
- tool call and tool result ordering is more fragile than native Responses.
- stream/timeout behavior is unstable.
- final text after tool context may be mistaken for task completion.
- a successful read command can look like progress even when no artifact was delivered.

The adapter currently adds a tool-use directive:

```text
Tool-use contract for the local coding agent:
- If the user asks to create, edit, write, generate, save, or inspect files, use the available tools to perform the actual work.
- Do not answer only with a plan such as "I will create..." when a file, command, document, or artifact is required.
- Continue using tools until the requested artifact exists or the requested operation has genuinely completed.
- Only provide the final answer after tool execution results confirm the work is done, or after clearly reporting a tool/runtime failure.
```

This helps but is not enough. Prompting can reduce failures, but cannot guarantee completion.

## 5. Completion Bug Root Cause

The previous completion logic effectively treated this as success:

```text
model stopped
+ no pending tool call
+ no obvious unfinished plan
= completed
```

This is wrong.

The correct rule should be:

```text
expected artifacts verified
= completed
```

For example, if the user asks for:

```text
写个html小游戏吧，再把游戏介绍写个飞书文档和md文件，都要
```

the task should not complete unless all of these are true:

- an `.html` file exists in the selected workspace
- an `.md` file exists in the selected workspace
- a Feishu/Lark doc was created successfully, with a valid `larkoffice.com/docx/...` URL
- the final answer references the actual local files and the doc link

The model is not intentionally "lying"; it is producing intermediate progress text such as "I will continue..." or "I will create..." and the runtime previously lacked a strong enough verifier to reject it.

## 6. Current Partial Fix

The current code has added an auto-continuation guard in:

```text
src/agent-server/task-manager.mjs
```

It can detect unfinished plans and retry. It also rejects some cases where continuation still produces no completion evidence.

This is useful, but still incomplete because:

- it does not create an explicit expected-artifacts contract at task start
- it relies on plan/events after the fact
- it does not deeply verify file paths, file contents, or Lark doc links
- it does not classify compound tasks into required deliverables
- it does not robustly handle ModelHub timeouts/retries

## 7. Recommended Next Actions

### Priority 1: Artifact Contract

Add an `expectedArtifacts` extraction step at task start.

For a user prompt, infer required deliverables:

| User intent | Expected artifact |
|-|-|
| HTML / webpage / game | local `.html` file |
| Markdown / md | local `.md` file |
| Feishu/Lark document | `larkoffice.com/docx/...` URL and successful creation command |
| CSV / spreadsheet | local `.csv` or Lark sheet, depending on wording |
| code change | git diff or changed file evidence |
| pure Q&A / explanation | final text only, no artifact required |

Persist this contract in the task artifact so frontend, logs, and verifier can all inspect it.

### Priority 2: Completion Verifier

Make `completed` depend on verifier result, not model final text.

The verifier should check:

- required local files exist
- files are inside the selected workspace, not inside the app bundle
- required file extensions match the prompt
- required Lark/Feishu links exist and are clickable
- tool failures were followed by successful recovery
- final response references real artifacts

If verification fails:

- auto-continue with a clear internal instruction
- if retry budget is exhausted, mark task as failed
- never show unfinished progress text as final result

### Priority 3: Tool Error Handling

Treat tool errors as strong incomplete signals.

Examples:

- `apply_patch` invalid payload
- shell command failed
- `lark-cli` failed
- ModelHub stream timeout

If a tool error happens and no later successful artifact evidence appears, the turn must not complete.

### Priority 4: Zero-Progress Guard

Track consecutive turns with no meaningful progress.

Meaningful progress should include:

- new file created
- file changed
- successful delivery command
- valid Lark doc created
- plan step actually completed

If there are N consecutive no-progress turns, fail the task instead of looping forever.

### Priority 5: ModelHub Robustness

Improve the ModelHub adapter:

- add request retry/backoff for `ModelHub crawl request timed out`
- distinguish upstream timeout from model final answer
- preserve developer/system semantics more carefully
- preserve tool call IDs and ordering strictly
- log `final_text_after_tool_context` as a high-risk completion signal
- consider splitting compound prompts into subturns: local files first, Lark doc second

### Priority 6: Regression Suite

Create a repeatable real-task suite with expected artifacts.

Minimum cases:

| Case | Expected |
|-|-|
| HTML game only | `.html` exists |
| Markdown only | `.md` exists |
| Lark doc only | doc URL exists |
| HTML + MD + Lark doc | all three exist |
| pure Q&A | final answer only |
| tool failure recovery | no fake complete |
| ModelHub timeout | task failed, not completed |
| multi-turn follow-up | same conversation/thread |

Target acceptance before internal beta:

```text
HTML + MD + Lark doc compound task >= 7/10 complete
pure Q&A false failure rate <= 1/20
fake completion rate = 0
```

## 8. GitHub Publishing Notes

The current project is inside a parent git repository:

```text
/Users/bytedance/Documents/codex1
```

The CodePilot project directory is currently untracked from that parent repo:

```text
internal-coding-agent-codex-runtime/
```

The parent repo remote is:

```text
https://github.com/edg-smoggy/codex.git
```

Important: do not run broad commands such as:

```bash
git add .
```

from the parent repo, because there are many unrelated modified and untracked sibling projects.

Safe staging should be scoped to:

```bash
git add internal-coding-agent-codex-runtime
```

or, if creating a standalone GitHub repository, initialize/push only this folder.

Files that must not be pushed:

- `.env.local`
- `.runtime-home/`
- `runs/`
- `dist/`
- `upstream/openai-codex/**/target/`
- any local logs containing raw prompts, keys, or credentials

The local `.gitignore` already excludes the main risky paths:

```text
.env.local
.runtime-home/
runs/
dist/
upstream/openai-codex/codex-rs/target/
upstream/openai-codex/target/
```

Before pushing to GitHub, run:

```bash
git status --short -- internal-coding-agent-codex-runtime
git diff --cached --stat
```

and scan for secrets.

There is one more important detail: `upstream/openai-codex/` is itself a nested git checkout:

```text
upstream/openai-codex -> https://github.com/openai/codex.git @ 6506579001
```

It currently has local modifications:

```text
codex-rs/core/src/session/turn.rs
codex-rs/Cargo.lock
```

The meaningful runtime patch changes several streaming delta edge cases from panic/error to warning/ignore behavior. If `upstream/openai-codex/` is pushed as a submodule, these local modifications will not be visible unless they are committed to a fork or exported as a patch file.

Recommended GitHub options:

| Option | Pros | Cons |
|-|-|-|
| Standalone private repo with vendored upstream source | Another AI can inspect everything in one repo | Larger repo; must avoid committing build output |
| Parent repo with `internal-coding-agent-codex-runtime/` folder and upstream as submodule | Cleaner and smaller | Another AI must fetch submodule; local upstream modifications need separate patch |
| Parent repo with only CodePilot wrapper code and upstream patch file | Smallest review surface | AI cannot inspect all upstream source inline |

For AI handoff, the best practical option is usually:

```text
standalone private repo
+ vendored source without build outputs
+ explicit upstream patch file
+ this handoff document
```

## 9. Suggested Implementation Order

1. Add `expectedArtifacts` data model.
2. Add prompt-to-artifact extractor with conservative rules.
3. Add verifier functions for local files, file extensions, diff, and Lark URLs.
4. Change task completion to require verifier success when artifacts are expected.
5. Treat tool errors followed by text-only final output as incomplete.
6. Add zero-progress turn counter.
7. Add ModelHub timeout retry/backoff.
8. Add real-task regression suite and run the 10x compound prompt again.
9. Only after reliability improves, rebuild the internal installer.

## 10. Key Product Decision

Do not try to solve this only with prompt changes.

Prompt changes are useful as guidance, but completion must be enforced by runtime verification.

The product should treat the model as an unreliable worker and the runtime as the inspector:

```text
model proposes and acts
runtime verifies
only verified work is shown as completed
```
