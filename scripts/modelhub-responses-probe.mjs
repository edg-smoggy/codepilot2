#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const envPath = path.join(repoRoot, ".env.local");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function parseSseBuffer(buffer, onEvent) {
  const parts = buffer.split(/\n\n/);
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const lines = part.split(/\r?\n/);
    const eventType = lines
      .find((line) => line.startsWith("event:"))
      ?.slice("event:".length)
      .trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!eventType && !data) continue;
    onEvent({ eventType, data, raw: part });
  }
  return rest;
}

loadEnvFile(envPath);

const ak = process.env.MODELHUB_AK;
if (!ak) {
  throw new Error("MODELHUB_AK is not set");
}

const outDir = path.join(repoRoot, "runs");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "T").slice(0, 15);
const outPath = path.join(outDir, `modelhub_responses_probe_${stamp}.raw.jsonl`);
const stream = fs.createWriteStream(outPath, { flags: "w" });

const url = process.env.MODELHUB_RESPONSES_URL || "https://ai-coder.bytedance.net/responses";
const body = {
  model: "gpt-5.5-2026-04-24",
  stream: true,
  reasoning: {
    effort: "medium",
    summary: "auto",
  },
  input: [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "请先简短思考，然后回答：为什么 1+1=2？",
        },
      ],
    },
  ],
};

const counters = new Map();
let sampleReasoning = null;
let sampleText = null;

function writeRecord(record) {
  stream.write(`${JSON.stringify(record)}\n`);
}

writeRecord({
  kind: "request",
  url,
  method: "POST",
  auth: "Byted-Authorization: Bearer <redacted>",
  model: body.model,
  stream: body.stream,
  reasoning: body.reasoning,
});

const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Byted-Authorization": `Bearer ${ak}`,
  },
  body: JSON.stringify(body),
});

writeRecord({
  kind: "response_headers",
  status: response.status,
  statusText: response.statusText,
  contentType: response.headers.get("content-type"),
});

let text = "";
if (response.body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    const decoded = decoder.decode(chunk, { stream: true });
    text += decoded;
    buffer += decoded;
    buffer = parseSseBuffer(buffer, ({ eventType, data, raw }) => {
      let parsed = null;
      if (data && data !== "[DONE]") {
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }
      }
      const type = parsed?.type ?? eventType ?? null;
      if (type) counters.set(type, (counters.get(type) ?? 0) + 1);
      if (!sampleReasoning && type && /response\.reasoning_(summary_)?text\.delta/.test(type)) {
        sampleReasoning = parsed ?? { eventType, data };
      }
      if (!sampleText && type === "response.output_text.delta") {
        sampleText = parsed ?? { eventType, data };
      }
      writeRecord({ kind: "sse", eventType, data, parsed, raw });
    });
  }
  if (buffer.trim()) {
    writeRecord({ kind: "sse_tail", raw: buffer });
  }
} else {
  text = await response.text();
  writeRecord({ kind: "body", text });
}

if (!response.ok && text) {
  writeRecord({ kind: "error_body_text", text });
}

stream.end();
await new Promise((resolve) => stream.on("finish", resolve));

const counts = Object.fromEntries([...counters.entries()].sort());
const reasoningDeltaCount =
  (counts["response.reasoning_summary_text.delta"] ?? 0) +
  (counts["response.reasoning_text.delta"] ?? 0);
const outputTextDeltaCount = counts["response.output_text.delta"] ?? 0;

console.log(
  JSON.stringify(
    {
      url,
      outPath,
      status: response.status,
      ok: response.ok,
      counts,
      reasoningDeltaCount,
      outputTextDeltaCount,
      hasReasoningDelta: reasoningDeltaCount > 0,
      hasOutputTextDelta: outputTextDeltaCount > 0,
      sampleReasoning,
      sampleText,
    },
    null,
    2,
  ),
);
