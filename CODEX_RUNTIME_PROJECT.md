# Codex Runtime Project Baseline

This file is intended to be copied into the separate Codex runtime project.

## Project

Internal Coding Agent Codex Runtime

## Purpose

Evaluate a source-level OpenAI Codex fork/vendor path without mixing that work
into the current Internal Coding Agent Client V0.87 product repo.

## Proposed Directory

`/Users/bytedance/Documents/codex1/internal-coding-agent-codex-runtime`

## Rules

- Keep this as a separate repo/project from `internal-coding-agent-client`.
- Preserve upstream license, commit, and patch provenance.
- Do not depend on a user-installed `Codex.app`.
- Do not move current product UI/runtime code into this repo.
- Keep patches small and auditable.

## First Milestones

1. Pin official OpenAI Codex upstream commit.
2. Import/fork source without build artifacts.
3. Build `codex-app-server` from source.
4. Run app-server protocol smoke.
5. Add Ark/OpenAI-compatible provider spike.
6. Document company CA/TLS path.
7. Produce a `runtime-cutover-decision.md` comparing this route with the V0.87 client runtime.

## Current Client Boundary

The current client repo remains focused on V0.87:

- workspace.mkdir
- workspace.move
- workspace.delete_file
- workspace.apply_patches
- failure artifact
- repeated failed-tool guard
- approval once/always
- natural-language approval routing
