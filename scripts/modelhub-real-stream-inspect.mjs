#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
const MODEL = process.env.MODELHUB_MODEL || "gpt-5.5-2026-04-24";
const TIMEOUT_MS = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS;
const RAW_DUMP_LIMIT = Number.parseInt(process.env.MODELHUB_RAW_STREAM_DUMP_LIMIT || "80", 10);
const DEFAULT_PROMPT = [
  "请用中文简短回答：为什么彩虹通常出现在雨后？",
  "请先仔细分析，再给最终答案；不要创建文件，不要调用外部工具。",
].join("\n");

loadDotEnvLocal();

function loadDotEnvLocal() {
  const envPath = path.join(PROJECT_ROOT, ".env.local");
  if (!fs.existsSync(envPath)) {
    return;
  }
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match || process.env[match[1]]) {
      continue;
    }
    process.env[match[1]] = unquoteEnvValue(match[2]);
  }
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function nowForFilename() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
}

function appendJsonl(stream, event) {
  if (!stream || stream.destroyed || stream.writableEnded) {
    return;
  }
  stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

function makeTempCodexHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-real-modelhub-"));
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "# Real ModelHub stream inspect\n");
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
      `model = ${JSON.stringify(MODEL)}`,
      'model_provider = "real_modelhub_adapter"',
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      "",
      "[model_providers.real_modelhub_adapter]",
      'name = "Real ModelHub adapter inspect"',
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

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function extractFieldEvidence(payloads) {
  const evidence = {
    reasoningFieldPaths: [],
    contentFieldPaths: [],
    mixedChunks: [],
    reasoningSamples: [],
    contentSamples: [],
  };
  payloads.forEach((entry) => {
    const payload = entry.payload;
    const choices = payload?.choices ?? payload?.data?.choices ?? payload?.result?.choices;
    if (!Array.isArray(choices)) {
      return;
    }
    choices.forEach((choice, choiceIndex) => {
      const delta = choice?.delta ?? {};
      const paths = {
        reasoning: [
          ["choices", choiceIndex, "delta", "reasoning_content", delta.reasoning_content],
          ["choices", choiceIndex, "delta", "reasoningContent", delta.reasoningContent],
          ["choices", choiceIndex, "delta", "reasoning", delta.reasoning],
          ["choices", choiceIndex, "reasoning_content", choice?.reasoning_content],
        ],
        content: [
          ["choices", choiceIndex, "delta", "content", delta.content],
          ["choices", choiceIndex, "delta", "text", delta.text],
          ["choices", choiceIndex, "text", choice?.text],
        ],
      };
      const reasoningHits = paths.reasoning.filter((item) => typeof item.at(-1) === "string" && item.at(-1));
      const contentHits = paths.content.filter((item) => typeof item.at(-1) === "string" && item.at(-1));
      for (const hit of reasoningHits) {
        evidence.reasoningFieldPaths.push(hit.slice(0, -1).join("."));
        evidence.reasoningSamples.push(String(hit.at(-1)).slice(0, 120));
      }
      for (const hit of contentHits) {
        evidence.contentFieldPaths.push(hit.slice(0, -1).join("."));
        evidence.contentSamples.push(String(hit.at(-1)).slice(0, 120));
      }
      if (reasoningHits.length && contentHits.length) {
        evidence.mixedChunks.push(entry.index);
      }
    });
  });
  evidence.reasoningFieldPaths = [...new Set(evidence.reasoningFieldPaths)];
  evidence.contentFieldPaths = [...new Set(evidence.contentFieldPaths)];
  evidence.reasoningSamples = evidence.reasoningSamples.slice(0, 5);
  evidence.contentSamples = evidence.contentSamples.slice(0, 5);
  return evidence;
}

async function main() {
  if (!process.env.MODELHUB_AK) {
    throw new Error("MODELHUB_AK is not set. Put it in .env.local or export it before running this script.");
  }

  const runDir = path.join(PROJECT_ROOT, "runs");
  fs.mkdirSync(runDir, { recursive: true });
  const stamp = nowForFilename();
  const transcriptPath = path.join(runDir, `modelhub_real_stream_inspect_${stamp}.jsonl`);
  const rawDumpPath = path.join(runDir, `modelhub_real_stream_inspect_${stamp}.raw.jsonl`);
  const summaryPath = path.join(runDir, `modelhub_real_stream_inspect_${stamp}.summary.json`);
  const transcript = fs.createWriteStream(transcriptPath, { flags: "wx" });
  const temp = makeTempCodexHome();
  const adapter = await startModelHubCrawlAdapter({
    transcript,
    endpoint: process.env.MODELHUB_CRAWL_URL,
    ak: process.env.MODELHUB_AK,
    defaultModel: MODEL,
    streamUpstream: true,
    rawStreamDumpPath: rawDumpPath,
    rawStreamDumpLimit: RAW_DUMP_LIMIT,
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

  const prompt = process.env.MODELHUB_INSPECT_PROMPT || DEFAULT_PROMPT;

  const summary = {
    ok: false,
    model: MODEL,
    transcriptPath,
    rawDumpPath,
    summaryPath,
    tempRoot: temp.root,
    codexHome: temp.codexHome,
    workspace: temp.workspace,
    configPath,
    adapterUrl: adapter.url,
    prompt,
    fieldEvidence: null,
    runtimeReasoningReceived: false,
    finalAnswerContainsReasoningSample: null,
    observedReasoningDeltas: [],
    observedAgentDeltas: [],
    finalAnswerPreview: null,
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
      prompt,
      workspace: temp.workspace,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      networkAccess: false,
    }), TIMEOUT_MS, "turn/start");
    const turnId = turnStart?.turn?.id;
    summary.turn = { id: turnId, status: turnStart?.turn?.status ?? null };
    const completed = await client.waitForNotification(
      (message) => message.method === "turn/completed" && message.params?.turn?.id === turnId,
      TIMEOUT_MS,
      "turn/completed",
    );
    summary.turn.status = completed.params?.turn?.status ?? summary.turn.status;
    summary.turn.error = completed.params?.turn?.error ?? null;

    const rawPayloads = readJsonl(rawDumpPath).filter((entry) => entry.type === "upstream_payload");
    summary.fieldEvidence = extractFieldEvidence(rawPayloads);
    const reasoningNotifications = client.notifications.filter((message) =>
      String(message.method || "").startsWith("item/reasoning/"));
    const agentDeltas = client.notifications.filter((message) => message.method === "item/agentMessage/delta");
    summary.observedReasoningDeltas = reasoningNotifications
      .filter((message) => message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta")
      .map((message) => String(message.params?.delta || ""))
      .filter(Boolean);
    summary.observedAgentDeltas = agentDeltas
      .map((message) => String(message.params?.delta || ""))
      .filter(Boolean);
    const finalAnswer = summary.observedAgentDeltas.join("");
    summary.runtimeReasoningReceived = summary.observedReasoningDeltas.length > 0;
    const firstReasoningSample = summary.observedReasoningDeltas.find(Boolean)?.slice(0, 20) || "";
    summary.finalAnswerContainsReasoningSample = firstReasoningSample
      ? finalAnswer.includes(firstReasoningSample)
      : null;
    summary.finalAnswerPreview = finalAnswer.slice(0, 500);
    summary.ok = summary.turn.status === "completed"
      && summary.fieldEvidence.reasoningFieldPaths.length > 0
      && summary.fieldEvidence.contentFieldPaths.length > 0
      && summary.runtimeReasoningReceived
      && summary.finalAnswerContainsReasoningSample === false;
  } finally {
    if (client.child.exitCode === null && !client.child.killed) {
      client.child.kill("SIGTERM");
    }
    await client.exited?.catch(() => null);
    await adapter.close();
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
