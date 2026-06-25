#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

import { loadDotEnvLocal } from "../src/runtime/env-file.mjs";

loadDotEnvLocal();

function parseArgs(argv) {
  const args = {
    baseUrl: "https://ark-cn-beijing.bytedance.net/api/v3",
    model: "ep-20260427114346-pfqwk",
    prompt: "Say hello from the Ark direct smoke in one short sentence.",
    imageUrl: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") {
      args.baseUrl = argv[++i];
    } else if (arg === "--model") {
      args.model = argv[++i];
    } else if (arg === "--prompt") {
      args.prompt = argv[++i];
    } else if (arg === "--image-url") {
      args.imageUrl = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "ARK_API_KEY is not set" }, null, 2));
    return;
  }

  const content = [];
  if (args.imageUrl) {
    content.push({ type: "input_image", image_url: args.imageUrl });
  }
  content.push({ type: "input_text", text: args.prompt });

  const request = {
    model: args.model,
    input: [{ role: "user", content }],
  };
  const result = await postResponses({ args, apiKey, request });
  console.log(JSON.stringify({
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    transport: result.transport,
    fallbackReason: result.fallbackReason,
    bodyPreview: result.body.slice(0, 1000),
  }, null, 2));
  if (result.status < 200 || result.status >= 300) {
    process.exitCode = 1;
  }
}

async function postResponses({ args, apiKey, request }) {
  const url = `${args.baseUrl.replace(/\/$/, "")}/responses`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    return {
      status: response.status,
      body: await response.text(),
      transport: "node-fetch",
      fallbackReason: null,
    };
  } catch (error) {
    const fallbackReason = error.cause?.code ?? error.message;
    return postResponsesWithCurl({ url, apiKey, request, fallbackReason });
  }
}

function postResponsesWithCurl({ url, apiKey, request, fallbackReason }) {
  const config = [
    `url = ${curlQuote(url)}`,
    `request = "POST"`,
    `header = ${curlQuote(`Authorization: Bearer ${apiKey}`)}`,
    `header = "Content-Type: application/json"`,
    `data = ${curlQuote(JSON.stringify(request))}`,
    "silent",
    "show-error",
    `write-out = "\\n%{http_code}"`,
  ].join("\n");

  const result = spawnSync("curl", ["--config", "-"], {
    input: config,
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`curl fallback failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  const output = result.stdout;
  const splitAt = output.lastIndexOf("\n");
  return {
    status: Number.parseInt(output.slice(splitAt + 1), 10),
    body: output.slice(0, splitAt),
    transport: "curl",
    fallbackReason,
  };
}

function curlQuote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
