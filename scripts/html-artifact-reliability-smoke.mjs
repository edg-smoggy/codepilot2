#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

const args = parseArgs(process.argv.slice(2));
const productHome = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-html-reliability-"));
const server = spawn(
  "node",
  [
    "src/agent-server/server.mjs",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--product-home",
    productHome,
  ],
  {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const stderr = readline.createInterface({ input: server.stderr });
stderr.on("line", (line) => console.error(`[server] ${line}`));

try {
  const startup = await readFirstJsonLine(server.stdout);
  const baseUrl = startup.url;
  const results = [];
  for (let index = 0; index < args.iterations; index += 1) {
    results.push(await runHtmlCase(baseUrl, index + 1));
  }
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  const noArtifact = results.filter((result) => !result.htmlFiles.length).length;
  const modelBehaviorCounts = countBy(results.flatMap((result) => result.modelBehaviors));
  const summary = {
    ok: failed === 0,
    productHome,
    provider: args.provider,
    model: args.model,
    iterations: args.iterations,
    passed,
    failed,
    noArtifact,
    modelBehaviorCounts,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exitCode = 1;
  }
} finally {
  server.kill("SIGTERM");
}

function parseArgs(argv) {
  const parsed = {
    iterations: 3,
    provider: "modelhub-gpt55",
    model: process.env.MODELHUB_MODEL || "gpt-5.5-2026-04-24",
    timeoutMs: 15 * 60 * 1000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--iterations") {
      parsed.iterations = Number.parseInt(requireValue(argv, (index += 1), arg), 10);
    } else if (arg === "--provider") {
      parsed.provider = requireValue(argv, (index += 1), arg);
    } else if (arg === "--model") {
      parsed.model = requireValue(argv, (index += 1), arg);
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number.parseInt(requireValue(argv, (index += 1), arg), 10);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(parsed.iterations) || parsed.iterations <= 0) {
    throw new Error("--iterations must be a positive integer");
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

async function runHtmlCase(baseUrl, index) {
  const workspace = makeWorkspace(`html-case-${index}`);
  const expectedName = `codepilot_visual_report_${index}.html`;
  const prompt = [
    `请创建一个独立静态 HTML 文件 ${expectedName}。`,
    "内容是一页可视化小报告，包含标题、三张指标卡、一个简单列表和一点 CSS 样式。",
    "必须实际写入 HTML 文件，不要只描述计划。",
    "完成后告诉我文件路径。",
  ].join("");
  const create = await postJson(`${baseUrl}/v1/tasks`, {
    workspacePath: workspace,
    provider: args.provider,
    model: args.model,
    prompt,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  });
  const artifact = await waitForArtifact(baseUrl, create.artifactUrl, args.timeoutMs);
  const htmlFiles = listHtmlFiles(workspace);
  const expectedPath = path.join(workspace, expectedName);
  const events = Array.isArray(artifact.events) ? artifact.events : [];
  const modelBehaviors = modelBehaviorEvents(path.join(productHome, "tasks", create.taskId, "raw.jsonl"));
  return {
    case: index,
    ok: artifact.status === "completed" && fs.existsSync(expectedPath),
    taskId: create.taskId,
    status: artifact.status,
    error: artifact.error,
    finalMessage: artifact.finalMessage,
    workspace,
    expectedPath,
    htmlFiles,
    eventTypes: [...new Set(events.map((event) => event.type))],
    toolItemTypes: [...new Set(events.map((event) => event.params?.item?.type).filter(Boolean))],
    modelBehaviors,
  };
}

function makeWorkspace(name) {
  const workspace = path.join(productHome, "workspaces", name);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), `# ${name}\n`);
  spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`POST ${url} failed ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function waitForArtifact(baseUrl, artifactUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let artifact = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}${artifactUrl}`);
    artifact = await response.json();
    if (["completed", "failed", "interrupted"].includes(artifact.status)) {
      return artifact;
    }
    await delay(500);
  }
  throw new Error(`task did not finish within ${timeoutMs}ms; last status=${artifact?.status}`);
}

function listHtmlFiles(workspace) {
  return fs.readdirSync(workspace)
    .filter((entry) => entry.toLowerCase().endsWith(".html"))
    .sort();
}

function modelBehaviorEvents(rawJsonlPath) {
  if (!fs.existsSync(rawJsonlPath)) {
    return [];
  }
  return fs.readFileSync(rawJsonlPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.direction === "modelhub-adapter" && entry.event === "model-behavior")
    .map((entry) => entry.behavior)
    .filter(Boolean);
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function readFirstJsonLine(stream) {
  const rl = readline.createInterface({ input: stream });
  return new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      try {
        resolve(JSON.parse(line));
        rl.close();
      } catch {
        reject(new Error(`Expected startup JSON, got: ${line}`));
      }
    });
    rl.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
