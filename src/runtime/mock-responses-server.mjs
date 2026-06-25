import http from "node:http";

import { appendJsonl } from "./jsonl.mjs";

function sseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function startMockResponsesServer({
  transcript,
  message = "M2 mock provider completed the local Codex runtime turn.",
} = {}) {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      appendJsonl(transcript, {
        direction: "mock-provider",
        event: "request",
        method: request.method,
        url: request.url,
        bodyBytes: Buffer.byteLength(body),
      });

      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }

      requestCount += 1;
      const responseId = `resp-mock-${requestCount}`;
      const messageId = `msg-mock-${requestCount}`;
      const bodyText = [
        sseEvent({
          type: "response.created",
          response: { id: responseId },
        }),
        sseEvent({
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: messageId,
            content: [{ type: "output_text", text: message }],
          },
        }),
        sseEvent({
          type: "response.completed",
          response: {
            id: responseId,
            usage: {
              input_tokens: 0,
              input_tokens_details: null,
              output_tokens: 0,
              output_tokens_details: null,
              total_tokens: 0,
            },
          },
        }),
      ].join("");

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.end(bodyText);
      appendJsonl(transcript, {
        direction: "mock-provider",
        event: "response",
        responseId,
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const url = `http://${address.address}:${address.port}`;
  appendJsonl(transcript, {
    direction: "mock-provider",
    event: "listening",
    url,
  });

  return {
    url,
    requestCount: () => requestCount,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
