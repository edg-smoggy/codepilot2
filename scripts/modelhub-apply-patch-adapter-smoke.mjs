#!/usr/bin/env node

import http from "node:http";

import { startModelHubCrawlAdapter } from "../src/runtime/modelhub-crawl-adapter.mjs";

const validPatch = [
  "*** Begin Patch",
  "*** Add File: demo.md",
  "+# Demo",
  "*** End Patch",
  "",
].join("\n");

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
          content: [{ type: "input_text", text: "Create demo.md" }],
        },
      ],
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply a patch",
        },
      ],
    }),
  });
  const text = await response.text();
  const firstTool = fake.requests[0]?.body?.tools?.find((tool) => tool.function?.name === "apply_patch");
  const retryMessages = fake.requests[1]?.body?.messages ?? [];
  const retryPrompt = JSON.stringify(retryMessages);
  const ok = response.ok
    && fake.requests.length === 2
    && firstTool?.function?.parameters?.required?.includes("patch")
    && retryPrompt.includes("previous apply_patch tool call was not executed")
    && text.includes("custom_tool_call")
    && text.includes("*** Begin Patch")
    && text.includes("demo.md");

  console.log(JSON.stringify({
    ok,
    responseStatus: response.status,
    forwardedRequestCount: fake.requests.length,
    applyPatchSchema: firstTool?.function?.parameters ?? null,
    retryHadRepairDirective: retryPrompt.includes("previous apply_patch tool call was not executed"),
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
      const body = requests.length === 1
        ? modelHubToolCall("{}")
        : modelHubToolCall(JSON.stringify({ patch: validPatch }));
      response.end(JSON.stringify(body));
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

function modelHubToolCall(args) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `call_${Math.random().toString(36).slice(2)}`,
              type: "function",
              function: {
                name: "apply_patch",
                arguments: args,
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}
