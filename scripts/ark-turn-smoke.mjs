#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { loadDotEnvLocal } from "../src/runtime/env-file.mjs";
import { TaskManager, publicTaskArtifact } from "../src/agent-server/task-manager.mjs";

loadDotEnvLocal();

async function main() {
  if (!process.env.ARK_API_KEY) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "ARK_API_KEY is not set" }, null, 2));
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "internal-codex-ark-turn-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "# Ark turn smoke\n");

  const manager = new TaskManager({ productHome: path.join(root, "home") });
  const task = await manager.startTask({
    workspacePath: workspace,
    provider: "ark",
    model: process.env.ARK_MODEL || "ep-20260427114346-pfqwk",
    prompt: "Reply with one short sentence saying the Ark Codex turn completed.",
    approvalPolicy: "never",
    turnTimeoutMs: 120000,
  });

  await task.runPromise;
  const artifact = publicTaskArtifact(task);
  console.log(JSON.stringify({
    ok: artifact.status === "completed",
    status: artifact.status,
    finalMessage: artifact.finalMessage,
    artifactPath: artifact.artifactPath,
  }, null, 2));
  if (artifact.status !== "completed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
