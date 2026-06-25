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
      instructions: "Answer briefly.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is 1+1?" }],
        },
        {
          type: "function_call",
          call_id: "call_poll",
          name: "write_stdin",
          arguments: "{\"session_id\":62134,\"chars\":\"\"}",
        },
        {
          type: "function_call",
          call_id: "call_ls",
          name: "exec_command",
          arguments: "{\"cmd\":\"ls -la\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_poll",
          output: "process still running",
        },
        {
          type: "function_call_output",
          call_id: "call_ls",
          output: "total 0",
        },
      ],
    }),
  });
  const text = await response.text();
  const ok = response.ok
    && text.includes("response.output_item.done")
    && text.includes("2")
    && fake.requests.length === 1
    && fake.requests[0].url.includes("ak=test-ak")
    && fake.requests[0].body.model === "gpt-5.5-2026-04-24"
    && fake.requests[0].body.messages.some((message) => message.role === "user")
    && fake.requests[0].body.messages.some((message) =>
      message.role === "assistant"
      && message.tool_calls?.length === 2
      && message.tool_calls[0]?.function?.name === "write_stdin"
      && message.tool_calls[1]?.function?.name === "exec_command")
    && fake.requests[0].body.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_poll")
    && fake.requests[0].body.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_ls");

  console.log(JSON.stringify({
    ok,
    responseStatus: response.status,
    forwardedRequestCount: fake.requests.length,
    forwardedModel: fake.requests[0]?.body?.model ?? null,
    forwardedToolHistory: fake.requests[0]?.body?.messages
      ?.filter((message) => message.role === "assistant" || message.role === "tool")
      ?.map((message) => ({
        role: message.role,
        toolCallNames: message.tool_calls?.map((call) => call.function?.name) ?? null,
        toolCallId: message.tool_call_id ?? message.tool_calls?.[0]?.id ?? null,
      })),
    ssePreview: text.slice(0, 500),
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
            message: {
              role: "assistant",
              content: "2",
            },
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
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
