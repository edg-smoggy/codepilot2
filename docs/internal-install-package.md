# CodePilot Internal Install Package

This document describes the first internal installable package track. It is
intentionally scoped to packaging and runtime bootstrapping only. Login, audit,
admin policy, auto-update, and enterprise governance are left for later tracks.

## Target

The first installable package should let an internal user:

1. Install `CodePilot.app`.
2. Open it by double-clicking.
3. Have the local agent server start automatically.
4. Use the existing CodePilot web UI inside a native macOS window.
5. Store local state and API keys outside the app bundle.

## Build

Prerequisites on the build machine:

- macOS with `swiftc`.
- Node.js available for the build script.
- `upstream/openai-codex/codex-rs/target/debug/codex-app-server` already built.
- A standalone Node binary for bundling. By default the build script uses the
  Codex desktop runtime Node when available; set `CODEPILOT_BUNDLE_NODE` to
  override.

Build the `.app`:

```bash
npm run package:macos
```

Build a `.dmg` wrapper:

```bash
npm run package:macos:dmg
```

Build a small-scope internal test package with the current local `.env.local`
embedded into the first-launch template:

```bash
npm run package:macos:dmg -- --embed-local-env
```

Only use the embedded-env package for tightly controlled internal testing. The
keys can be extracted from the app bundle by anyone who has the DMG.

Outputs:

- `dist/CodePilot.app`
- `dist/CodePilot-internal-macos-<build-id>.dmg` when `--dmg` is used

The DMG volume name also includes the same build id. This avoids accidentally
opening an older mounted package when multiple internal builds are being tested
on the same machine.

## Runtime Layout

Inside `CodePilot.app`:

```text
Contents/
  MacOS/
    CodePilot
  Resources/
    runtime/
      src/
      web/
      config/
      upstream/openai-codex/codex-rs/models-manager/prompt.md
      upstream/openai-codex/codex-rs/target/debug/codex-app-server
    runtime-manifest.json
    build-info.json
    node/bin/node
```

User-writable state:

```text
~/Library/Application Support/CodePilot/
  .env.local
  desktop.log
  tasks/
  conversations/
  codex-home/
```

On first launch, the app creates `.env.local` in the user data directory from
the bundled `.env.local.example`.

When the package is built with `--embed-local-env`, startup also fills missing
or empty env keys in the user data `.env.local` from the bundled template. It
does not overwrite non-empty local values.

## Node Resolution

The macOS wrapper resolves Node.js in this order:

1. `CODEPILOT_NODE`
2. `CodePilot.app/Contents/Resources/node/bin/node`
3. `/opt/homebrew/bin/node`
4. `/usr/local/bin/node`
5. `/usr/bin/node`

The package script copies a standalone Node binary to `Resources/node/bin/node`
when one is available. The system paths are fallbacks for developer builds.

## Extension Points

The package keeps these surfaces as ordinary files so later builds can extend
without changing the desktop shell:

- Provider configs: `config/providers/*.json`
- Model catalogs: `config/model-catalogs/*.json`
- Frontend: `web/index.html`
- Backend entrypoint: `src/agent-server/server.mjs`
- App-server binary path:
  `upstream/openai-codex/codex-rs/target/debug/codex-app-server`
- User env: `~/Library/Application Support/CodePilot/.env.local`

## Current Limits

- macOS package only.
- The app is unsigned. Internal distribution may require right-click open or
  company signing/notarization later.
- API key setup is file-based through `.env.local`; a settings UI can be added
  later without changing the server.
