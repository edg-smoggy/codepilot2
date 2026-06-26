#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MODEL = process.env.MODELHUB_MODEL || "gpt-5.5-2026-04-24";
const MODELHUB_BASE = (process.env.MODELHUB_BASE_URL || "https://aidp.bytedance.net/api/modelhub/online/v2").replace(/\/$/, "");
const CRAWL_URL = process.env.MODELHUB_CRAWL_URL || `${MODELHUB_BASE}/crawl`;
const RAW_LIMIT = Number.parseInt(process.env.MODELHUB_RAW_STREAM_DUMP_LIMIT || "120", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MODELHUB_REQUEST_TIMEOUT_MS || "90000", 10);
const PROMPT = process.env.MODELHUB_REASONING_PROMPT || [
  "请解决这个逻辑题，并只给简洁最终答案：",
  "有三个盒子，标签分别是“苹果”“橙子”“苹果和橙子”，但三个标签都贴错了。",
  "你只能从一个盒子里拿一个水果，如何确定所有盒子的内容？",
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

function appendJsonl(filePath, event) {
  fs.appendFileSync(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function withAk(url) {
  const resolved = new URL(url);
  if (!resolved.searchParams.has("ak")) {
    resolved.searchParams.set("ak", process.env.MODELHUB_AK);
  }
  return resolved;
}

function requestHeaders({ authMode }) {
  const headers = {
    "content-type": "application/json",
    "X-TT-LOGID": `codepilot-reasoning-${Date.now().toString(36)}`,
  };
  if (authMode === "bearer") {
    headers.authorization = `Bearer ${process.env.MODELHUB_AK}`;
  }
  return headers;
}

async function postStreamJson({ url, body, rawDumpPath, authMode = "query" }) {
  const target = authMode === "query" ? withAk(url) : new URL(url);
  const startedAt = Date.now();
  const response = await postJson(target, requestHeaders({ authMode }), body);
  const contentType = response.headers["content-type"] || "";
  const text = response.text;
  const payloads = parseStreamPayloads(text, contentType);
  payloads.slice(0, RAW_LIMIT).forEach((payload, index) => {
    appendJsonl(rawDumpPath, {
      type: "upstream_payload",
      index: index + 1,
      event: payload.event ?? null,
      payload: sanitizeForDump(payload.data),
    });
  });
  appendJsonl(rawDumpPath, {
    type: "upstream_stream_end",
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    contentType,
    payloadCount: payloads.length,
    dumpedPayloadCount: Math.min(payloads.length, RAW_LIMIT),
    durationMs: Date.now() - startedAt,
    rawPreview: sanitizeString(text.slice(0, 500)),
  });
  return {
    status: response.status,
    ok: response.ok,
    contentType,
    payloads,
    rawPreview: sanitizeString(text.slice(0, 500)),
    durationMs: Date.now() - startedAt,
  };
}

function postJson(url, headers, body) {
  const bodyText = JSON.stringify(body);
  const transport = url.protocol === "http:" ? http : https;
  const requestOptions = {
    method: "POST",
    headers: {
      ...headers,
      "content-length": Buffer.byteLength(bodyText),
    },
  };
  if (url.protocol === "https:") {
    Object.assign(requestOptions, tlsOptions());
  }
  return new Promise((resolve, reject) => {
    const request = transport.request(url, requestOptions, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    request.on("error", reject);
    request.end(bodyText);
  });
}

function tlsOptions() {
  const caPath = [
    process.env.MODELHUB_CA_CERTS,
    process.env.NODE_EXTRA_CA_CERTS,
    "/etc/ssl/cert.pem",
    "/usr/local/etc/openssl@3/cert.pem",
    "/opt/homebrew/etc/openssl@3/cert.pem",
  ].find((item) => item && fs.existsSync(item));
  return caPath ? { ca: fs.readFileSync(caPath, "utf8") } : {};
}

function parseStreamPayloads(text, contentType) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return [];
  }
  if (contentType.includes("event-stream") || /^event:|^data:/m.test(trimmed)) {
    return trimmed.split(/\r?\n\r?\n/)
      .map(parseSseFrame)
      .filter(Boolean);
  }
  if (contentType.includes("jsonl") || contentType.includes("ndjson")) {
    return trimmed.split(/\r?\n/)
      .map((line) => ({ event: null, data: parseMaybeJson(line) }))
      .filter((item) => item.data);
  }
  return [{ event: null, data: parseMaybeJson(trimmed) }];
}

function parseSseFrame(frame) {
  const event = frame.split(/\r?\n/)
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim() || null;
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return null;
  }
  return { event, data: parseMaybeJson(data) };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function crawlBody(extra = {}) {
  return {
    stream: true,
    model: MODEL,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: PROMPT }],
      },
    ],
    ...extra,
  };
}

function responsesBody() {
  return {
    stream: true,
    model: MODEL,
    max_output_tokens: 300,
    reasoning: {
      effort: "medium",
      summary: "auto",
    },
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: PROMPT }],
      },
    ],
  };
}

function analyzePayloads(payloads) {
  const evidence = {
    reasoningFieldPaths: [],
    reasoningEventTypes: [],
    contentFieldPaths: [],
    outputTextEventTypes: [],
    mixedChunkIndexes: [],
    reasoningSamples: [],
    contentSamples: [],
    reasoningTokenPaths: [],
    reasoningTokenValues: [],
    finishReasons: [],
  };
  payloads.forEach((entry, index) => {
    const payload = entry.data;
    const found = collectEvidence(payload);
    if (entry.event && /reasoning/i.test(entry.event)) {
      evidence.reasoningEventTypes.push(entry.event);
      const delta = firstString([
        payload?.delta,
        payload?.text,
        payload?.part?.text,
      ]);
      if (delta) evidence.reasoningSamples.push(delta.slice(0, 120));
    }
    if (entry.event && /output_text/i.test(entry.event)) {
      evidence.outputTextEventTypes.push(entry.event);
      const delta = firstString([payload?.delta, payload?.text]);
      if (delta) evidence.contentSamples.push(delta.slice(0, 120));
    }
    evidence.reasoningFieldPaths.push(...found.reasoningFieldPaths);
    evidence.contentFieldPaths.push(...found.contentFieldPaths);
    evidence.reasoningSamples.push(...found.reasoningSamples);
    evidence.contentSamples.push(...found.contentSamples);
    evidence.reasoningTokenPaths.push(...found.reasoningTokenPaths);
    evidence.reasoningTokenValues.push(...found.reasoningTokenValues);
    evidence.finishReasons.push(...found.finishReasons);
    if ((found.reasoningFieldPaths.length || (entry.event && /reasoning/i.test(entry.event)))
      && (found.contentFieldPaths.length || (entry.event && /output_text/i.test(entry.event)))) {
      evidence.mixedChunkIndexes.push(index + 1);
    }
  });
  return {
    reasoningFieldPaths: unique(evidence.reasoningFieldPaths),
    reasoningEventTypes: unique(evidence.reasoningEventTypes),
    contentFieldPaths: unique(evidence.contentFieldPaths),
    outputTextEventTypes: unique(evidence.outputTextEventTypes),
    mixedChunkIndexes: unique(evidence.mixedChunkIndexes).slice(0, 20),
    reasoningSamples: unique(evidence.reasoningSamples.filter(Boolean)).slice(0, 8),
    contentSamples: unique(evidence.contentSamples.filter(Boolean)).slice(0, 8),
    reasoningTokenPaths: unique(evidence.reasoningTokenPaths),
    reasoningTokenValues: unique(evidence.reasoningTokenValues),
    finishReasons: unique(evidence.finishReasons),
  };
}

function collectEvidence(value, basePath = "") {
  const out = {
    reasoningFieldPaths: [],
    contentFieldPaths: [],
    reasoningSamples: [],
    contentSamples: [],
    reasoningTokenPaths: [],
    reasoningTokenValues: [],
    finishReasons: [],
  };
  if (!value || typeof value !== "object") {
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = basePath ? `${basePath}.${key}` : key;
    if (/reasoning.*tokens?|reasoning_tokens|reasoningTokens/i.test(key) && (typeof child === "number" || typeof child === "string")) {
      out.reasoningTokenPaths.push(childPath);
      out.reasoningTokenValues.push(child);
    }
    if (/finish_reason|finishReason|stop_reason|stopReason/i.test(key) && typeof child === "string" && child) {
      out.finishReasons.push(child);
    }
    if (/reasoning_content|reasoningContent|reasoning|thinking/i.test(key) && typeof child === "string" && child) {
      out.reasoningFieldPaths.push(childPath);
      out.reasoningSamples.push(child.slice(0, 120));
    }
    if ((key === "content" || key === "text" || key === "output_text") && typeof child === "string" && child) {
      out.contentFieldPaths.push(childPath);
      out.contentSamples.push(child.slice(0, 120));
    }
    if (child && typeof child === "object") {
      const nested = collectEvidence(child, childPath);
      out.reasoningFieldPaths.push(...nested.reasoningFieldPaths);
      out.contentFieldPaths.push(...nested.contentFieldPaths);
      out.reasoningSamples.push(...nested.reasoningSamples);
      out.contentSamples.push(...nested.contentSamples);
      out.reasoningTokenPaths.push(...nested.reasoningTokenPaths);
      out.reasoningTokenValues.push(...nested.reasoningTokenValues);
      out.finishReasons.push(...nested.finishReasons);
    }
  }
  return out;
}

function firstString(values) {
  return values.find((value) => typeof value === "string" && value);
}

function unique(values) {
  return [...new Set(values)];
}

function sanitizeForDump(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDump(item));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sanitizeString(value) : value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(ak|api[-_]?key|authorization|token|secret|password)$/i.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = sanitizeForDump(child);
    }
  }
  return out;
}

function sanitizeString(value) {
  return String(value)
    .replace(/(ak=)[^&\s"]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}

async function runA({ runDir }) {
  const variants = [
    ...["low", "medium", "high", "xhigh"].map((level) => ({
      name: `reasoning_effort_${level}`,
      body: crawlBody({ reasoning_effort: level }),
    })),
    {
      name: "thinking_enabled",
      body: crawlBody({ thinking: { type: "enabled" } }),
    },
    {
      name: "extra_reasoning_high_thinking",
      body: crawlBody({
        extra: {
          reasoning_effort: "high",
          thinking: { type: "enabled" },
        },
      }),
    },
    {
      name: "extra_body_reasoning_high",
      body: crawlBody({
        extra_body: {
          reasoning_effort: "high",
        },
      }),
    },
  ];
  const results = [];
  for (const variant of variants) {
    const rawDumpPath = path.join(runDir, `A_${variant.name}.raw.jsonl`);
    const response = await postStreamJson({
      url: CRAWL_URL,
      body: variant.body,
      rawDumpPath,
      authMode: "query",
    });
    const evidence = analyzePayloads(response.payloads);
    results.push({
      name: variant.name,
      requestKeys: Object.keys(variant.body),
      rawDumpPath,
      status: response.status,
      ok: response.ok,
      contentType: response.contentType,
      durationMs: response.durationMs,
      payloadCount: response.payloads.length,
      rawPreview: response.rawPreview,
      evidence,
      hasReasoningText: evidence.reasoningFieldPaths.length > 0 || evidence.reasoningEventTypes.length > 0,
      hasReasoningTokens: evidence.reasoningTokenPaths.length > 0,
      hasOutputText: evidence.contentFieldPaths.length > 0 || evidence.outputTextEventTypes.length > 0,
    });
  }
  return results;
}

async function runB({ runDir }) {
  const endpoints = [
    `${MODELHUB_BASE}/responses`,
    `${MODELHUB_BASE}/byted_gpt/responses`,
    `${MODELHUB_BASE}/byted_gpt/v1/responses`,
    `${MODELHUB_BASE}/v1/responses`,
    `${MODELHUB_BASE}/openai/responses`,
  ];
  const authModes = ["query", "bearer"];
  const results = [];
  for (const endpoint of endpoints) {
    for (const authMode of authModes) {
      const name = `${endpoint.replace(MODELHUB_BASE, "").replaceAll("/", "_").replace(/^_/, "") || "responses"}_${authMode}`;
      const rawDumpPath = path.join(runDir, `B_${name}.raw.jsonl`);
      let response;
      try {
        response = await postStreamJson({
          url: endpoint,
          body: responsesBody(),
          rawDumpPath,
          authMode,
        });
      } catch (error) {
        appendJsonl(rawDumpPath, {
          type: "request_error",
          message: error.message,
        });
        results.push({
          endpoint,
          authMode,
          rawDumpPath,
          error: error.message,
          hasResponsesReasoningEvents: false,
          hasResponsesOutputTextEvents: false,
        });
        continue;
      }
      const evidence = analyzePayloads(response.payloads);
      results.push({
        endpoint: endpoint.replace(process.env.MODELHUB_AK || "", "[REDACTED]"),
        authMode,
        rawDumpPath,
        status: response.status,
        ok: response.ok,
        contentType: response.contentType,
        durationMs: response.durationMs,
        payloadCount: response.payloads.length,
        rawPreview: response.rawPreview,
        evidence,
        hasResponsesReasoningEvents: evidence.reasoningEventTypes.includes("response.reasoning_summary_text.delta"),
        hasResponsesOutputTextEvents: evidence.outputTextEventTypes.includes("response.output_text.delta"),
      });
    }
  }
  return results;
}

async function main() {
  if (!process.env.MODELHUB_AK) {
    throw new Error("MODELHUB_AK is not set. Put it in .env.local or export it before running.");
  }
  const runDir = path.join(PROJECT_ROOT, "runs", `modelhub_reasoning_paths_${nowForFilename()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const a = await runA({ runDir });
  const b = await runB({ runDir });
  const summary = {
    ok: true,
    runDir,
    model: MODEL,
    prompt: PROMPT,
    crawlUrl: CRAWL_URL.replace(process.env.MODELHUB_AK, "[REDACTED]"),
    modelhubBase: MODELHUB_BASE,
    A: {
      anyReasoningText: a.some((item) => item.hasReasoningText),
      anyReasoningTokens: a.some((item) => item.hasReasoningTokens),
      results: a,
    },
    B: {
      anyResponsesReasoningEvents: b.some((item) => item.hasResponsesReasoningEvents),
      anyResponsesOutputTextEvents: b.some((item) => item.hasResponsesOutputTextEvents),
      results: b,
    },
  };
  const summaryPath = path.join(runDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
