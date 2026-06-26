#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  AppServerClient,
  DEFAULT_TIMEOUT_MS,
  startAppServerProcess,
} from "../src/runtime/app-server-client.mjs";
import { startModelHubCrawlAdapter } from "../src/runtime/modelhub-crawl-adapter.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TIMEOUT_MS = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS;

function sseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function appendJsonl(stream, event) {
  if (!stream || stream.destroyed || stream.writableEnded) {
    return;
  }
  stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function nowForFilename() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

function makeTempCodexHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-reasoning-smoke-"));
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "# Reasoning stream smoke\n");
  const git = spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  if (git.status !== 0) {
    throw new Error(`git init failed in ${workspace}`);
  }
  return { root, codexHome, workspace };
}

function writeConfigToml({ codexHome, adapterUrl }) {
  const configPath = path.join(codexHome, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      'model = "mock-model"',
      'model_provider = "modelhub_reasoning_adapter"',
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      "",
      "[model_providers.modelhub_reasoning_adapter]",
      'name = "ModelHub reasoning adapter smoke"',
      `base_url = "${adapterUrl}/v1"`,
      'wire_api = "responses"',
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "supports_websockets = false",
      "",
    ].join("\n"),
  );
  return configPath;
}

async function startFakeModelHubReasoningStream(transcript) {
  const requests = [];
  const sampleReasoningDelta = "正在拆分任务，并准备调用工具。";
  const sampleAnswer = "reasoning stream smoke completed.";
  const sampleModelHubStreamPayloads = [
    { choices: [{ delta: { reasoning_content: sampleReasoningDelta } }] },
    { choices: [{ delta: { content: sampleAnswer } }] },
    {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: sampleAnswer } }],
      usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
    },
  ];

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method,
        url: request.url,
        body: rawBody ? JSON.parse(rawBody) : {},
      });
      appendJsonl(transcript, {
        direction: "fake-modelhub",
        event: "request",
        method: request.method,
        url: request.url,
        bodyBytes: Buffer.byteLength(rawBody),
      });

      if (request.method !== "POST") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }

      const body = [
        `data: ${JSON.stringify(sampleModelHubStreamPayloads[0])}\n\n`,
        `data: ${JSON.stringify(sampleModelHubStreamPayloads[1])}\n\n`,
        `data: ${JSON.stringify(sampleModelHubStreamPayloads[2])}\n\n`,
        "data: [DONE]\n\n",
      ].join("");

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.end(body);
      appendJsonl(transcript, {
        direction: "fake-modelhub",
        event: "response",
        modelHubReasoningSampleShape: sampleModelHubStreamPayloads,
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://${address.address}:${address.port}`,
    requests,
    sampleReasoningDelta,
    sampleAnswer,
    sampleModelHubStreamPayloads,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const runDir = path.join(PROJECT_ROOT, "runs");
  fs.mkdirSync(runDir, { recursive: true });
  const transcriptPath = path.join(runDir, `modelhub_stream_reasoning_smoke_${nowForFilename()}.jsonl`);
  const summaryPath = transcriptPath.replace(/\.jsonl$/, ".summary.json");
  const transcript = fs.createWriteStream(transcriptPath, { flags: "wx" });
  const temp = makeTempCodexHome();
  const fakeModelHub = await startFakeModelHubReasoningStream(transcript);
  const adapter = await startModelHubCrawlAdapter({
    transcript,
    endpoint: `${fakeModelHub.url}/api/modelhub/online/v2/crawl`,
    ak: "test-ak",
    defaultModel: "mock-model",
    streamUpstream: true,
    capabilities: {
      supportsToolCalls: true,
      supportsParallelToolCalls: false,
      supportsReasoningStream: true,
    },
  });
  const configPath = writeConfigToml({ codexHome: temp.codexHome, adapterUrl: adapter.url });
  const child = startAppServerProcess({
    codexHome: temp.codexHome,
    env: { RUST_LOG: "warn" },
  });
  const client = new AppServerClient({ child, transcript });
  client.attach();

  const summary = {
    ok: false,
    gate: "unknown",
    runtimeReasoningRecognized: false,
    transcriptPath,
    summaryPath,
    tempRoot: temp.root,
    codexHome: temp.codexHome,
    workspace: temp.workspace,
    configPath,
    fakeModelHubUrl: fakeModelHub.url,
    adapterUrl: adapter.url,
    modelHubReasoningSampleShape: fakeModelHub.sampleModelHubStreamPayloads,
    observedReasoningMethods: [],
    observedAgentDeltas: [],
    turn: null,
  };

  try {
    await withTimeout(client.initialize(), TIMEOUT_MS, "initialize");
    const threadStart = await withTimeout(client.startThread({
      workspace: temp.workspace,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: true,
    }), TIMEOUT_MS, "thread/start");
    const threadId = threadStart?.thread?.id;
    if (!threadId) {
      throw new Error("thread/start response did not include thread.id");
    }
    const turnStart = await withTimeout(client.startTurn({
      threadId,
      prompt: "Run the reasoning stream gate smoke.",
      workspace: temp.workspace,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      networkAccess: false,
    }), TIMEOUT_MS, "turn/start");
    const turnId = turnStart?.turn?.id;
    summary.turn = { id: turnId, status: turnStart?.turn?.status ?? null };
    await client.waitForNotification(
      (message) => message.method === "turn/completed" && message.params?.turn?.id === turnId,
      TIMEOUT_MS,
      "turn/completed",
    );
    const reasoningNotifications = client.notifications.filter((message) =>
      String(message.method || "").startsWith("item/reasoning/"));
    const agentDeltas = client.notifications.filter((message) => message.method === "item/agentMessage/delta");
    summary.observedReasoningMethods = reasoningNotifications.map((message) => ({
      method: message.method,
      params: message.params,
    }));
    summary.observedAgentDeltas = agentDeltas.map((message) => ({
      delta: message.params?.delta,
      itemId: message.params?.itemId,
    }));
    summary.runtimeReasoningRecognized = reasoningNotifications.some((message) =>
      message.method === "item/reasoning/summaryTextDelta"
      && String(message.params?.delta || "").includes(fakeModelHub.sampleReasoningDelta));
    summary.gate = summary.runtimeReasoningRecognized ? "runtime-recognizes-responses-reasoning" : "runtime-does-not-recognize-responses-reasoning";
    summary.ok = summary.runtimeReasoningRecognized;
  } finally {
    if (client.child.exitCode === null && !client.child.killed) {
      client.child.kill("SIGTERM");
    }
    await client.exited?.catch(() => null);
    await adapter.close();
    await fakeModelHub.close();
    fs.rmSync(temp.root, { recursive: true, force: true });
    summary.tempRemoved = true;
    transcript.end();
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
