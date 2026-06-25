#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const prompt = "写个html小游戏吧，再把游戏介绍写个飞书文档和md文件，都要";
const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
const runRoot = path.join(os.tmpdir(), `codepilot-repeat-html-lark-${runId}`);
const productHome = path.join(runRoot, "product-home");
const workspaceRoot = path.join(runRoot, "workspaces");
const repeats = Number.parseInt(process.env.CODEPILOT_REPEAT_COUNT || "10", 10);
const timeoutMs = Number.parseInt(process.env.CODEPILOT_REPEAT_TIMEOUT_MS || `${12 * 60 * 1000}`, 10);

fs.mkdirSync(productHome, { recursive: true });
fs.mkdirSync(workspaceRoot, { recursive: true });

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
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const stderr = readline.createInterface({ input: server.stderr });
stderr.on("line", (line) => console.error(`[server] ${line}`));

try {
  const startup = await readFirstJsonLine(server.stdout);
  const baseUrl = startup.url;
  const results = [];
  for (let index = 1; index <= repeats; index += 1) {
    const workspacePath = path.join(workspaceRoot, `run-${String(index).padStart(2, "0")}`);
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(path.join(workspacePath, "README.md"), `# CodePilot repeat run ${index}\n`);
    console.log(JSON.stringify({ event: "run.started", index, workspacePath }));
    const startedAt = Date.now();
    const artifact = await runTask(baseUrl, {
      workspacePath,
      provider: "modelhub-gpt55",
      model: "gpt-5.5-2026-04-24",
      prompt,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      networkAccess: true,
      maxAutoContinuations: 2,
      turnTimeoutMs: timeoutMs,
    }, timeoutMs + 60_000);
    const result = summarizeRun({ index, artifact, workspacePath, elapsedMs: Date.now() - startedAt });
    results.push(result);
    console.log(JSON.stringify({ event: "run.finished", ...result }));
  }

  const summary = summarizeResults(results);
  const summaryJsonPath = path.join(runRoot, "summary.json");
  const summaryMdPath = path.join(runRoot, "summary.md");
  fs.writeFileSync(summaryJsonPath, `${JSON.stringify({ runId, runRoot, prompt, summary, results }, null, 2)}\n`);
  fs.writeFileSync(summaryMdPath, renderMarkdownSummary({ runId, runRoot, prompt, summary, results }));
  console.log(JSON.stringify({
    event: "suite.finished",
    ok: summary.completeDeliveries === repeats,
    runRoot,
    summaryJsonPath,
    summaryMdPath,
    summary,
  }, null, 2));
  if (summary.completeDeliveries !== repeats) {
    process.exitCode = 1;
  }
} finally {
  server.kill("SIGTERM");
}

async function runTask(baseUrl, request, waitTimeoutMs) {
  const create = await fetch(`${baseUrl}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const created = await create.json();
  if (!create.ok) {
    throw new Error(`task create failed: ${JSON.stringify(created)}`);
  }

  const deadline = Date.now() + waitTimeoutMs;
  let artifact = null;
  while (Date.now() < deadline) {
    const artifactResponse = await fetch(`${baseUrl}${created.artifactUrl}`);
    artifact = await artifactResponse.json();
    if (["completed", "failed", "interrupted"].includes(artifact.status)) {
      return artifact;
    }
    await delay(5000);
  }
  throw new Error(`timeout waiting for task ${created.taskId}`);
}

function summarizeRun({ index, artifact, workspacePath, elapsedMs }) {
  const events = Array.isArray(artifact.events) ? artifact.events : [];
  const textBlob = eventText(events, artifact);
  const files = listFiles(workspacePath);
  const htmlFiles = files.filter((file) => /\.html?$/i.test(file));
  const mdFiles = files.filter((file) => /\.md$/i.test(file));
  const larkUrls = uniqueStrings(textBlob.match(/https:\/\/[^\s"'<>)]*larkoffice\.com\/docx\/[A-Za-z0-9_-]+/g) || []);
  const rawText = readRawText(artifact.transcriptPath);
  const invalidPatchCount = countMatches(rawText, /invalid patch|apply_patch verification failed/gi);
  const finalTextAfterToolCount = countMatches(rawText, /final_text_after_tool_context/gi);
  const deliveryComplete = artifact.status === "completed"
    && htmlFiles.length > 0
    && mdFiles.length > 0
    && larkUrls.length > 0;
  return {
    index,
    taskId: artifact.id,
    conversationId: artifact.conversationId,
    status: artifact.status,
    deliveryComplete,
    elapsedMs,
    autoContinuationCount: artifact.autoContinuationCount ?? 0,
    error: errorText(artifact.error),
    finalPreview: preview(artifact.finalMessage),
    htmlFiles,
    mdFiles,
    larkUrls,
    eventCounts: countBy(events.map((event) => event.type)),
    commandCount: events.filter((event) => event.params?.item?.type === "commandExecution").length,
    fileChangeCount: events.filter((event) => event.params?.item?.type === "fileChange").length,
    invalidPatchCount,
    finalTextAfterToolCount,
    workspacePath,
  };
}

function summarizeResults(results) {
  return {
    total: results.length,
    completed: results.filter((item) => item.status === "completed").length,
    failed: results.filter((item) => item.status === "failed").length,
    completeDeliveries: results.filter((item) => item.deliveryComplete).length,
    withContinuation: results.filter((item) => item.autoContinuationCount > 0).length,
    withInvalidPatch: results.filter((item) => item.invalidPatchCount > 0).length,
    withFinalTextAfterTool: results.filter((item) => item.finalTextAfterToolCount > 0).length,
    avgElapsedMs: Math.round(results.reduce((sum, item) => sum + item.elapsedMs, 0) / Math.max(1, results.length)),
  };
}

function renderMarkdownSummary({ runId, runRoot, prompt, summary, results }) {
  const lines = [
    `# Repeat HTML + Lark Prompt ${runId}`,
    "",
    `- Run root: \`${runRoot}\``,
    `- Prompt: ${prompt}`,
    `- Completed: ${summary.completed}/${summary.total}`,
    `- Complete deliveries: ${summary.completeDeliveries}/${summary.total}`,
    `- Failed: ${summary.failed}/${summary.total}`,
    `- With continuation: ${summary.withContinuation}/${summary.total}`,
    "",
    "| # | Status | Complete | Continuations | HTML | MD | Lark | Error / Final |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    lines.push([
      result.index,
      result.status,
      result.deliveryComplete ? "yes" : "no",
      result.autoContinuationCount,
      result.htmlFiles.length,
      result.mdFiles.length,
      result.larkUrls.length,
      escapeTable(result.error || result.finalPreview || ""),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  for (const result of results) {
    lines.push(`## Run ${result.index}`);
    lines.push("");
    lines.push(`- Task: \`${result.taskId}\``);
    lines.push(`- Workspace: \`${result.workspacePath}\``);
    lines.push(`- Status: ${result.status}`);
    lines.push(`- Delivery complete: ${result.deliveryComplete ? "yes" : "no"}`);
    lines.push(`- Continuations: ${result.autoContinuationCount}`);
    lines.push(`- HTML: ${result.htmlFiles.map((file) => `\`${file}\``).join(", ") || "-"}`);
    lines.push(`- MD: ${result.mdFiles.map((file) => `\`${file}\``).join(", ") || "-"}`);
    lines.push(`- Lark: ${result.larkUrls.join(", ") || "-"}`);
    if (result.error) {
      lines.push(`- Error: ${result.error}`);
    }
    if (result.finalPreview) {
      lines.push(`- Final: ${result.finalPreview}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function eventText(events, artifact) {
  return [
    artifact.finalMessage,
    errorText(artifact.error),
    ...events.flatMap((event) => {
      const item = event.params?.item;
      return [
        item?.text,
        item?.aggregatedOutput,
        item?.command,
        JSON.stringify(item?.result ?? ""),
      ];
    }),
  ].filter(Boolean).join("\n");
}

function listFiles(root) {
  const files = [];
  walk(root, files, root);
  return files.sort();
}

function walk(currentPath, files, root) {
  if (!fs.existsSync(currentPath)) return;
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files, root);
    } else if (entry.isFile()) {
      files.push(path.relative(root, fullPath));
    }
  }
}

function readRawText(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function preview(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function escapeTable(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 240);
}

function readFirstJsonLine(stream) {
  const rl = readline.createInterface({ input: stream });
  return new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      try {
        resolve(JSON.parse(line));
        rl.close();
      } catch (error) {
        reject(error);
      }
    });
    rl.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
