#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "internal-codex-ark-coding-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "README.md"),
    "# Ark coding smoke\n\nThe agent should create hello.txt.\n",
  );
  spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });

  const manager = new TaskManager({ productHome: path.join(root, "home") });
  const task = await manager.startTask({
    workspacePath: workspace,
    provider: "ark",
    model: process.env.ARK_MODEL || "ep-20260427114346-pfqwk",
    prompt:
      "Create a file named hello.txt containing exactly: hello from ark codex runtime. Then report the change.",
    approvalPolicy: "never",
    turnTimeoutMs: 180000,
  });

  await task.runPromise;
  const artifact = publicTaskArtifact(task);
  const helloPath = path.join(workspace, "hello.txt");
  const diff = spawnSync("git", ["diff", "--", "."], {
    cwd: workspace,
    encoding: "utf8",
  }).stdout;
  console.log(JSON.stringify({
    ok: artifact.status === "completed" && fs.existsSync(helloPath),
    status: artifact.status,
    fileCreated: fs.existsSync(helloPath),
    finalMessage: artifact.finalMessage,
    artifactPath: artifact.artifactPath,
    diffPreview: diff.slice(0, 2000),
  }, null, 2));
  if (artifact.status !== "completed" || !fs.existsSync(helloPath)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
