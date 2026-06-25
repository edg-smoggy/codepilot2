#!/usr/bin/env node

import http from "node:http";

import { startModelHubCrawlAdapter } from "../src/runtime/modelhub-crawl-adapter.mjs";

const fake = await startFakeModelHub();
const adapter = await startModelHubCrawlAdapter({
  endpoint: fake.url,
  ak: "test-ak",
  defaultModel: "gpt-5.5-2026-04-24",
});

try {
  const response = await fetch(`${adapter.url}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.5-2026-04-24",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Create a large HTML file" }],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "exec_command",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: {
                cmd: { type: "string" },
              },
              required: ["cmd"],
            },
          },
        },
      ],
    }),
  });
  const text = await response.text();
  const requestBody = fake.requests[0]?.body ?? {};
  const ok = response.ok
    && fake.requests.length === 1
    && !Object.hasOwn(requestBody, "max_tokens")
    && text.includes("response.failed")
    && text.includes("provider_output_truncated")
    && text.includes("finish_reason");

  console.log(JSON.stringify({
    ok,
    responseStatus: response.status,
    forwardedRequestCount: fake.requests.length,
    forwardedHadMaxTokens: Object.hasOwn(requestBody, "max_tokens"),
    ssePreview: text.slice(0, 800),
  }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  await adapter.close();
  await fake.close();
}

async function startFakeModelHub() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method,
        url: request.url,
        body: raw ? JSON.parse(raw) : {},
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [
          {
            finish_reason: "length",
            message: {
              role: "assistant",
              content: "我现在开始写入大文件。",
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 4096,
          total_tokens: 4196,
        },
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://${address.address}:${address.port}/api/modelhub/online/v2/crawl`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
