import assert from "node:assert/strict";
import http from "node:http";

import { normalizeAppServerNotification, finalMessageFromEvents } from "../src/runtime/events.mjs";
import { startModelHubCrawlAdapter, responsesToCrawlRequest } from "../src/runtime/modelhub-crawl-adapter.mjs";

function testEventNormalization() {
  const delta = normalizeAppServerNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thr",
      turnId: "turn",
      itemId: "msg",
      delta: "我先看一下",
    },
  });
  assert.equal(delta.type, "item.agentMessage.delta");
  assert.equal(delta.rawMethod, "item/agentMessage/delta");
  assert.equal(delta.params.delta, "我先看一下");

  const reasoning = normalizeAppServerNotification({
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thr",
      turnId: "turn",
      itemId: "reasoning",
      summaryIndex: 0,
      delta: "检查文件",
    },
  });
  assert.equal(reasoning.type, "item.reasoning.summaryTextDelta");

  assert.equal(finalMessageFromEvents([delta]), "我先看一下");
  assert.equal(finalMessageFromEvents([
    delta,
    normalizeAppServerNotification({
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          id: "final",
          phase: "final_answer",
          text: "最终答案",
        },
      },
    }),
  ]), "最终答案");
}

function testCrawlRequestStreamFlag() {
  assert.equal(responsesToCrawlRequest({ model: "m", input: "x" }).stream, false);
  assert.equal(responsesToCrawlRequest({ model: "m", input: "x" }, { stream: true }).stream, true);
}

async function testModelHubStreamBridge() {
  let receivedBody = null;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "我先" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "检查" } }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });

  const endpoint = `http://127.0.0.1:${upstream.address().port}/api/modelhub`;
  const adapter = await startModelHubCrawlAdapter({
    endpoint,
    ak: "test-ak",
    streamUpstream: true,
  });

  try {
    const response = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.5-test",
        input: "ping",
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(receivedBody.stream, true);
    assert.match(text, /response\.created/);
    assert.match(text, /response\.output_text\.delta/);
    assert.match(text, /我先/);
    assert.match(text, /检查/);
    assert.match(text, /response\.completed/);
  } finally {
    await adapter.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

testEventNormalization();
testCrawlRequestStreamFlag();
await testModelHubStreamBridge();

console.log("live timeline smoke ok");
