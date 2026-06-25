import http from "node:http";
import https from "node:https";
import fs from "node:fs";

import { appendJsonl } from "./jsonl.mjs";

const DEFAULT_ENDPOINT = "https://aidp.bytedance.net/api/modelhub/online/v2/crawl";
const DEFAULT_MODEL = "gpt-5.5-2026-04-24";
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const IMPLICIT_OUTPUT_LIMIT_CANDIDATES = new Set([4096, 8192, 16384, 32768, 65536]);
const TOOL_USE_DIRECTIVE = [
  "Tool-use contract for the local coding agent:",
  "- If the user asks to create, edit, write, generate, save, or inspect files, use the available tools to perform the actual work.",
  "- Do not answer only with a plan such as \"I will create...\" when a file, command, document, or artifact is required.",
  "- Continue using tools until the requested artifact exists or the requested operation has genuinely completed.",
  "- Only provide the final answer after tool execution results confirm the work is done, or after clearly reporting a tool/runtime failure.",
].join("\n");
const APPLY_PATCH_REPAIR_DIRECTIVE = [
  "Your previous apply_patch tool call was not executed because its arguments were malformed.",
  "Call apply_patch again with JSON arguments exactly like {\"patch\":\"*** Begin Patch\\n...\\n*** End Patch\\n\"}.",
  "The patch string must begin with *** Begin Patch and end with *** End Patch.",
  "If creating files and a valid patch is hard, use exec_command with a shell heredoc, then verify the files.",
  "Do not reply with a plan; call a tool.",
].join("\n");
const APPLY_PATCH_REPAIR_LIMIT = 1;

export async function startModelHubCrawlAdapter({
  transcript,
  endpoint = process.env.MODELHUB_CRAWL_URL || DEFAULT_ENDPOINT,
  ak = process.env.MODELHUB_AK,
  defaultModel = process.env.MODELHUB_MODEL || DEFAULT_MODEL,
  maxTokens = optionalPositiveInteger(process.env.MODELHUB_MAX_TOKENS),
  requestTimeoutMs = optionalPositiveInteger(process.env.MODELHUB_REQUEST_TIMEOUT_MS) ?? DEFAULT_REQUEST_TIMEOUT_MS,
  streamUpstream = process.env.MODELHUB_STREAM === "true",
  capabilities = {},
} = {}) {
  if (!ak) {
    throw new Error("MODELHUB_AK is not set");
  }

  let requestCount = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      appendJsonl(transcript, {
        direction: "modelhub-adapter",
        event: "request",
        method: request.method,
        url: request.url,
        bodyBytes: Buffer.byteLength(rawBody),
      });

      if (request.method !== "POST" || request.url !== "/v1/responses") {
        sendJson(response, 404, { error: "not found" });
        return;
      }

      requestCount += 1;
      let responsesRequest;
      try {
        responsesRequest = JSON.parse(rawBody || "{}");
      } catch (error) {
        sendJson(response, 400, { error: `Invalid JSON request body: ${error.message}` });
        return;
      }

      try {
        const protocol = validateResponsesProtocol(responsesRequest, capabilities);
        appendJsonl(transcript, {
          direction: "modelhub-adapter",
          event: "protocol-summary",
          ...protocol.summary,
        });
        if (!protocol.ok) {
          sendResponsesFailure(response, {
            code: "protocol_violation",
            message: protocol.reason,
            status: 400,
          });
          return;
        }
        const crawlRequest = responsesToCrawlRequest(responsesRequest, {
          defaultModel,
          maxTokens,
          stream: streamUpstream && responsesRequest.stream !== false,
        });
        if (streamUpstream && crawlRequest.stream) {
          await streamCrawlAsResponses({
            endpoint,
            ak,
            body: crawlRequest,
            response,
            requestCount,
            transcript,
            requestTimeoutMs,
          });
          return;
        }
        let upstream = await postCrawl({
          endpoint,
          ak,
          body: crawlRequest,
          requestTimeoutMs,
        });
        let outputItems = extractOutputItems(upstream.body);
        let usage = extractUsage(upstream.body);
        let truncation = detectOutputTruncation(upstream.body, usage, crawlRequest);
        let malformedApplyPatch = findMalformedApplyPatchCall(outputItems);
        let repairAttempts = 0;
        while (upstream.status >= 200
          && upstream.status < 300
          && malformedApplyPatch
          && repairAttempts < APPLY_PATCH_REPAIR_LIMIT) {
          repairAttempts += 1;
          appendJsonl(transcript, {
            direction: "modelhub-adapter",
            event: "tool-call-repair",
            tool: "apply_patch",
            callId: malformedApplyPatch.callId,
            reason: malformedApplyPatch.reason,
            badInputPreview: malformedApplyPatch.inputPreview,
            attempt: repairAttempts,
          });
          upstream = await postCrawl({
            endpoint,
            ak,
            body: buildApplyPatchRepairRequest(crawlRequest, outputItems, malformedApplyPatch),
            requestTimeoutMs,
          });
          outputItems = extractOutputItems(upstream.body);
          usage = extractUsage(upstream.body);
          truncation = detectOutputTruncation(upstream.body, usage, crawlRequest);
          malformedApplyPatch = findMalformedApplyPatchCall(outputItems);
        }
        const toolOutputItems = outputItems.filter((item) => item.type === "function_call" || item.type === "custom_tool_call");
        const text = outputItems
          .filter((item) => item.type === "message")
          .flatMap((item) => item.content ?? [])
          .map((part) => part.text ?? "")
          .join("");
        if (upstream.status < 200 || upstream.status >= 300) {
          const classified = classifyProviderError(text || upstream.rawText || "", upstream.status);
          sendResponsesFailure(response, {
            code: classified.code,
            message: classified.message || text || `ModelHub crawl returned HTTP ${upstream.status}`,
            status: upstream.status,
          });
          return;
        }
        if (truncation.truncated) {
          appendJsonl(transcript, {
            direction: "modelhub-adapter",
            event: "provider-output-truncated",
            ...truncation,
            textPreview: (text || "").slice(0, 240),
            toolCallCount: toolOutputItems.length,
          });
          sendResponsesFailure(response, {
            code: "provider_output_truncated",
            message: truncationMessage(truncation),
            status: 422,
          });
          return;
        }
        if (malformedApplyPatch) {
          appendJsonl(transcript, {
            direction: "modelhub-adapter",
            event: "malformed-tool-call",
            tool: "apply_patch",
            callId: malformedApplyPatch.callId,
            reason: malformedApplyPatch.reason,
            badInputPreview: malformedApplyPatch.inputPreview,
          });
          sendResponsesFailure(response, {
            code: "malformed_tool_call",
            message: `apply_patch arguments malformed: ${malformedApplyPatch.reason}`,
            status: 422,
          });
          return;
        }

        if (crawlRequest.tools?.length && !toolOutputItems.length) {
          appendJsonl(transcript, {
            direction: "modelhub-adapter",
            event: "model-behavior",
            behavior: hasPriorToolInteraction(responsesRequest) ? "final_text_after_tool_context" : "no_tool_call_final",
            toolCount: crawlRequest.tools.length,
            textPreview: (text || "").slice(0, 240),
          });
        }

        sendResponsesMessage(response, {
          outputItems,
          requestCount,
          usage,
        });
        appendJsonl(transcript, {
          direction: "modelhub-adapter",
          event: "response",
          status: upstream.status,
          textBytes: Buffer.byteLength(text || ""),
          toolCallCount: toolOutputItems.length,
        });
      } catch (error) {
        const classified = classifyProviderError(error.message, 500);
        appendJsonl(transcript, {
          direction: "modelhub-adapter",
          event: "error",
          message: error.message,
          code: classified.code,
        });
        sendResponsesFailure(response, {
          code: classified.code,
          message: classified.message || error.message,
          status: 500,
        });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const url = `http://${address.address}:${address.port}`;
  appendJsonl(transcript, {
    direction: "modelhub-adapter",
    event: "listening",
    url,
    endpoint,
    defaultModel,
    streamUpstream,
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

function validateResponsesProtocol(request, capabilities = {}) {
  const input = Array.isArray(request.input) ? request.input : [];
  const summary = {
    inputItemCount: input.length,
    functionCallCount: 0,
    functionCallOutputCount: 0,
    messageCount: 0,
    developerMessageCount: 0,
    hasTools: Array.isArray(request.tools) && request.tools.length > 0,
    toolCount: Array.isArray(request.tools) ? request.tools.length : 0,
  };
  const pendingToolCalls = new Map();
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.type === "message" || item.role) {
      summary.messageCount += 1;
      if (String(item.role || "").toLowerCase() === "developer") {
        summary.developerMessageCount += 1;
      }
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      summary.functionCallCount += 1;
      const callId = String(item.call_id || item.id || "");
      if (!callId) {
        return {
          ok: false,
          reason: "assistant tool call is missing call_id",
          summary,
        };
      }
      pendingToolCalls.set(callId, item);
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      summary.functionCallOutputCount += 1;
      const callId = String(item.call_id || item.id || "");
      if (!callId) {
        return {
          ok: false,
          reason: "tool call output is missing call_id",
          summary,
        };
      }
      pendingToolCalls.delete(callId);
    }
  }
  if (pendingToolCalls.size > 0) {
    return {
      ok: false,
      reason: `tool call output missing for call_id(s): ${[...pendingToolCalls.keys()].join(", ")}`,
      summary,
    };
  }
  if (summary.developerMessageCount && capabilities.supportsDeveloperMessage === false) {
    summary.developerMessageStrategy = capabilities.developerMessageStrategy || "merge_to_system";
  }
  if (summary.toolCount > 1 && capabilities.supportsParallelToolCalls === false) {
    summary.parallelToolCalls = "disabled";
  }
  return { ok: true, reason: null, summary };
}

function classifyProviderError(message, status = 500) {
  const text = String(message || "");
  if (/timed?\s*out|timeout|ETIMEDOUT|ECONNRESET/i.test(text)) {
    return { code: "provider_timeout", message: text || "ModelHub request timed out" };
  }
  if (/资源池资源不足|资源不足|resource.*exhausted|quota|rate limit|限流|-4302/i.test(text)) {
    return { code: "provider_resource_exhausted", message: text || "ModelHub provider resource exhausted" };
  }
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|auth|ak|token/i.test(text)) {
    return { code: "provider_auth_error", message: text || "ModelHub authentication failed" };
  }
  if (status >= 500) {
    return { code: "provider_5xx", message: text || `ModelHub returned HTTP ${status}` };
  }
  if (status >= 400) {
    return { code: `provider_http_${status}`, message: text || `ModelHub returned HTTP ${status}` };
  }
  return { code: "provider_error", message: text };
}

function optionalPositiveInteger(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function responsesToCrawlRequest(request, { defaultModel = DEFAULT_MODEL, maxTokens = null, stream = false } = {}) {
  const tools = responsesToolsToChatTools(request.tools);
  const messages = withToolUseDirective(responsesInputToMessages(request), tools);
  const crawlRequest = {
    stream,
    model: request.model || defaultModel,
    messages: messages.length
      ? messages
      : [{ role: "user", content: [{ type: "text", text: "" }] }],
  };
  const requestedMaxTokens = request.max_tokens ?? request.max_output_tokens ?? maxTokens;
  if (requestedMaxTokens != null) {
    crawlRequest.max_tokens = requestedMaxTokens;
  }

  if (tools.length) {
    crawlRequest.tools = tools;
    if (request.tool_choice) {
      crawlRequest.tool_choice = request.tool_choice;
    }
  }

  return crawlRequest;
}

function withToolUseDirective(messages, tools) {
  if (!tools.length) {
    return messages;
  }
  return [
    { role: "system", content: [{ type: "text", text: TOOL_USE_DIRECTIVE }] },
    ...messages,
  ];
}

function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") {
        return null;
      }
      const name = tool.name || tool.function?.name;
      if (!name) {
        return null;
      }
      if (name === "apply_patch") {
        return applyPatchChatTool(tool);
      }
      if (tool.type === "function" && tool.function) {
        return tool;
      }
      return {
        type: "function",
        function: {
          name,
          description: tool.description || tool.function?.description || "",
          parameters: tool.parameters || tool.input_schema || tool.function?.parameters || {
            type: "object",
            properties: {},
          },
        },
      };
    })
    .filter(Boolean);
}

function applyPatchChatTool(tool) {
  return {
    type: "function",
    function: {
      name: "apply_patch",
      description: [
        tool.description || tool.function?.description || "Apply a patch to files.",
        "Arguments must be a JSON object with a patch string.",
        "The patch string must start with *** Begin Patch and end with *** End Patch.",
      ].filter(Boolean).join(" "),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["patch"],
        properties: {
          patch: {
            type: "string",
            description: "Complete patch text beginning with *** Begin Patch and ending with *** End Patch.",
          },
        },
      },
    },
  };
}

function hasPriorToolInteraction(request) {
  return (Array.isArray(request.input) ? request.input : []).some((item) =>
    item?.type === "function_call"
    || item?.type === "custom_tool_call"
    || item?.type === "function_call_output"
    || item?.type === "custom_tool_call_output"
  );
}

function responsesInputToMessages(request) {
  const messages = [];
  let pendingToolCalls = [];

  function flushPendingToolCalls() {
    if (!pendingToolCalls.length) {
      return;
    }
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  }

  if (request.instructions) {
    messages.push({
      role: "system",
      content: [{ type: "text", text: String(request.instructions) }],
    });
  }

  const input = Array.isArray(request.input) ? request.input : [];
  for (const item of input) {
    if (typeof item === "string") {
      flushPendingToolCalls();
      messages.push({ role: "user", content: [{ type: "text", text: item }] });
      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      pendingToolCalls.push(responseItemToChatToolCall(item, pendingToolCalls.length + 1));
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      flushPendingToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id || item.id || "call"),
        content: textFromUnknown(item.output ?? item.content ?? ""),
      });
      continue;
    }

    if (item.type === "message" || item.role) {
      flushPendingToolCalls();
      messages.push({
        role: normalizeRole(item.role),
        content: contentToModelHubParts(item.content),
      });
      continue;
    }

    const text = textFromUnknown(item);
    if (text) {
      flushPendingToolCalls();
      messages.push({ role: "user", content: [{ type: "text", text }] });
    }
  }

  flushPendingToolCalls();
  return mergeAdjacentMessages(messages);
}

function responseItemToChatToolCall(item, index) {
  const name = item.name || "tool";
  return {
    id: String(item.call_id || item.id || `call_${index}`),
    type: "function",
    function: {
      name,
      arguments: name === "apply_patch"
        ? stringifyApplyPatchChatArguments(item.arguments ?? item.input ?? {})
        : stringifyToolArguments(item.arguments ?? item.input ?? {}),
    },
  };
}

function contentToModelHubParts(content) {
  const parts = [];
  const items = Array.isArray(content) ? content : [content];
  for (const item of items) {
    if (typeof item === "string") {
      parts.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.type === "input_image" || item.type === "image_url") {
      const imageUrl = item.image_url || item.imageUrl || item.url;
      if (imageUrl) {
        parts.push({ type: "image_url", image_url: imageUrl });
      }
      continue;
    }
    const text = item.text ?? item.output_text ?? item.input_text;
    if (text != null) {
      parts.push({ type: "text", text: String(text) });
    }
  }
  return parts.length ? parts : [{ type: "text", text: "" }];
}

function normalizeRole(role) {
  const normalized = String(role || "user").toLowerCase();
  if (normalized === "assistant") return "assistant";
  if (normalized === "system" || normalized === "developer") return "system";
  if (normalized === "tool") return "tool";
  return "user";
}

function mergeAdjacentMessages(messages) {
  const merged = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (canMergeMessages(last, message)) {
      last.content.push(...message.content);
    } else {
      merged.push(cloneMessage(message));
    }
  }
  return merged;
}

function canMergeMessages(left, right) {
  return Boolean(left)
    && left.role === right.role
    && left.role !== "tool"
    && !left.tool_calls
    && !right.tool_calls
    && Array.isArray(left.content)
    && Array.isArray(right.content);
}

function cloneMessage(message) {
  return {
    ...message,
    content: Array.isArray(message.content) ? [...message.content] : message.content,
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
          ...call,
          function: call.function ? { ...call.function } : call.function,
        }))
      : message.tool_calls,
  };
}

function stringifyToolArguments(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function stringifyApplyPatchChatArguments(value) {
  const parsed = parseMaybeJson(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const patch = normalizeApplyPatchInput(parsed);
    return JSON.stringify(patch ? { patch } : parsed);
  }
  if (typeof parsed === "string") {
    const patch = extractPatchText(parsed);
    if (patch) {
      return JSON.stringify({ patch });
    }
    return stringifyToolArguments(parsed);
  }
  return stringifyToolArguments(parsed);
}

async function postCrawl({ endpoint, ak, body, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  const url = new URL(endpoint);
  if (!url.searchParams.has("ak")) {
    url.searchParams.set("ak", ak);
  }

  const response = await postJson(url, {
    "content-type": "application/json",
    "X-TT-LOGID": `codepilot-${Date.now().toString(36)}`,
  }, body, { requestTimeoutMs });
  let parsed = null;
  try {
    parsed = response.text ? JSON.parse(response.text) : null;
  } catch {
    parsed = response.text;
  }
  return {
    status: response.status,
    body: parsed,
    rawText: response.text,
  };
}

async function streamCrawlAsResponses({ endpoint, ak, body, response, requestCount, transcript, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  const responseId = `resp-modelhub-stream-${requestCount}`;
  const messageId = `msg-modelhub-stream-${requestCount}`;
  let text = "";
  let lastPayload = null;
  let outputItemAdded = false;
  let completed = false;

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.write(sseEvent({
    type: "response.created",
    response: { id: responseId },
  }));

  try {
    const result = await postCrawlStream({
      endpoint,
      ak,
      body,
      requestTimeoutMs,
      onPayload: (payload) => {
        lastPayload = payload;
        const delta = extractStreamTextDelta(payload);
        if (!delta) {
          return;
        }
        if (!outputItemAdded) {
          response.write(sseEvent({
            type: "response.output_item.added",
            item: {
              type: "message",
              role: "assistant",
              id: messageId,
              content: [{ type: "output_text", text: "" }],
            },
          }));
          outputItemAdded = true;
        }
        text += delta;
        response.write(sseEvent({
          type: "response.output_text.delta",
          delta,
        }));
      },
    });

    if (result.status < 200 || result.status >= 300) {
      const message = extractAssistantText(lastPayload) || result.rawText || `ModelHub crawl returned HTTP ${result.status}`;
      response.write(sseEvent({
        type: "response.failed",
        response: {
          id: responseId,
          error: { code: `modelhub_http_${result.status}`, message },
        },
      }));
      response.end();
      completed = true;
      return;
    }

    const finalBody = lastPayload ?? parseMaybeJson(result.rawText);
    const outputItems = extractOutputItems(finalBody);
    const toolItems = outputItems.filter((item) => item.type === "function_call" || item.type === "custom_tool_call");
    if (!text && !toolItems.length) {
      text = extractAssistantText(finalBody) || "";
    }

    const finalItems = toolItems.length
      ? toolItems
      : [{
          type: "message",
          role: "assistant",
          id: messageId,
          content: [{ type: "output_text", text }],
        }];

    for (const item of finalItems) {
      response.write(sseEvent({
        type: "response.output_item.done",
        item: {
          ...item,
          id: item.id || (item.type === "message" ? messageId : undefined),
          call_id: item.call_id || (item.type === "function_call" ? `call_modelhub_stream_${requestCount}` : undefined),
        },
      }));
    }
    response.write(sseEvent({
      type: "response.completed",
      response: {
        id: responseId,
        usage: extractUsage(finalBody),
      },
    }));
    response.end();
    completed = true;
    appendJsonl(transcript, {
      direction: "modelhub-adapter",
      event: "stream-response",
      status: result.status,
      textBytes: Buffer.byteLength(text || ""),
      payloadCount: result.payloadCount,
    });
  } catch (error) {
    appendJsonl(transcript, {
      direction: "modelhub-adapter",
      event: "stream-error",
      message: error.message,
    });
    if (!completed) {
      response.write(sseEvent({
        type: "response.failed",
        response: {
          id: responseId,
          error: { code: "modelhub_stream_error", message: error.message },
        },
      }));
      response.end();
    }
  }
}

async function postCrawlStream({ endpoint, ak, body, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, onPayload }) {
  const url = new URL(endpoint);
  if (!url.searchParams.has("ak")) {
    url.searchParams.set("ak", ak);
  }
  return postJsonStream(url, {
    "content-type": "application/json",
    "X-TT-LOGID": `codepilot-${Date.now().toString(36)}`,
  }, body, onPayload, { requestTimeoutMs });
}

function postJsonStream(url, headers, body, onPayload, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
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
    const request = transport.request(url, requestOptions, (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 0;
      const contentType = String(upstreamResponse.headers["content-type"] || "");
      const isSse = contentType.includes("event-stream");
      const isJsonl = contentType.includes("jsonl") || contentType.includes("ndjson");
      const chunks = [];
      let buffer = "";
      let payloadCount = 0;

      const emitPayload = (payload) => {
        if (!payload) return;
        payloadCount += 1;
        onPayload?.(payload);
      };

      upstreamResponse.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        chunks.push(Buffer.from(text));
        if (isSse) {
          buffer += text;
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() || "";
          for (const frame of frames) {
            emitPayload(parseSseFrame(frame));
          }
        } else if (isJsonl) {
          buffer += text;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            emitPayload(parseJsonLine(line));
          }
        }
      });

      upstreamResponse.on("end", () => {
        if (isSse && buffer.trim()) {
          emitPayload(parseSseFrame(buffer));
        } else if (isJsonl && buffer.trim()) {
          emitPayload(parseJsonLine(buffer));
        }
        const rawText = Buffer.concat(chunks).toString("utf8");
        if (!isSse && !isJsonl && rawText.trim()) {
          emitPayload(parseMaybeJson(rawText));
        }
        resolve({ status, rawText, payloadCount });
      });
    });
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new Error("ModelHub crawl stream timed out"));
    });
    request.on("error", reject);
    request.end(bodyText);
  });
}

function parseSseFrame(frame) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return null;
  }
  return parseMaybeJson(data);
}

function parseJsonLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed === "[DONE]") {
    return null;
  }
  return parseMaybeJson(trimmed);
}

function postJson(url, headers, body, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
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
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new Error("ModelHub crawl request timed out"));
    });
    request.on("error", reject);
    request.end(bodyText);
  });
}

function tlsOptions() {
  const caPath = firstExistingPath([
    process.env.MODELHUB_CA_CERTS,
    process.env.NODE_EXTRA_CA_CERTS,
    "/etc/ssl/cert.pem",
    "/usr/local/etc/openssl@3/cert.pem",
    "/opt/homebrew/etc/openssl@3/cert.pem",
  ]);
  if (!caPath) {
    return {};
  }
  return {
    ca: fs.readFileSync(caPath, "utf8"),
  };
}

function firstExistingPath(paths) {
  return paths.find((item) => item && fs.existsSync(item));
}

function extractOutputItems(body) {
  const toolCalls = extractToolCalls(body);
  if (toolCalls.length) {
    return toolCalls.map((call, index) => {
      const callId = call.id || call.call_id || `call_modelhub_${index + 1}`;
      if (call.name === "apply_patch") {
        return {
          type: "custom_tool_call",
          call_id: callId,
          name: "apply_patch",
          input: normalizeApplyPatchInput(call.arguments),
        };
      }
      return {
        type: "function_call",
        call_id: callId,
        name: call.name,
        arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
      };
    });
  }

  return [{
    type: "message",
    role: "assistant",
    id: "msg-modelhub",
    content: [{ type: "output_text", text: extractAssistantText(body) || "" }],
  }];
}

function findMalformedApplyPatchCall(outputItems) {
  for (const item of outputItems) {
    if (item?.type !== "custom_tool_call" || item.name !== "apply_patch") {
      continue;
    }
    const validation = validateApplyPatchInput(item.input);
    if (!validation.ok) {
      return {
        callId: item.call_id,
        reason: validation.reason,
        inputPreview: String(item.input ?? "").slice(0, 200),
      };
    }
  }
  return null;
}

function validateApplyPatchInput(value) {
  if (typeof value !== "string") {
    return { ok: false, reason: "input is not a string" };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, reason: "input is empty" };
  }
  if (!trimmed.startsWith("*** Begin Patch")) {
    return { ok: false, reason: "input does not start with *** Begin Patch" };
  }
  if (!trimmed.includes("*** End Patch")) {
    return { ok: false, reason: "input does not contain *** End Patch" };
  }
  return { ok: true, reason: null };
}

function buildApplyPatchRepairRequest(crawlRequest, outputItems, malformed) {
  const toolCalls = outputItems
    .filter((item) => item.type === "function_call" || item.type === "custom_tool_call")
    .map((item, index) => responseItemToChatToolCall(item, index + 1));
  return {
    ...crawlRequest,
    messages: [
      ...crawlRequest.messages.map(cloneMessage),
      {
        role: "assistant",
        content: null,
        tool_calls: toolCalls,
      },
      ...toolCalls.map((call) => ({
        role: "tool",
        tool_call_id: call.id,
        content: call.id === malformed.callId
          ? `apply_patch was not executed: ${malformed.reason}. Bad input preview: ${malformed.inputPreview || "(empty)"}`
          : "Tool call was not executed because another tool call in the same model response was malformed.",
      })),
      {
        role: "user",
        content: [{ type: "text", text: APPLY_PATCH_REPAIR_DIRECTIVE }],
      },
    ],
  };
}

function normalizeApplyPatchInput(argumentsValue) {
  const value = parseMaybeJson(argumentsValue);
  if (typeof value === "string") {
    return extractPatchText(value) || value;
  }
  if (value && typeof value === "object") {
    const direct = firstString([
      value.patch,
      value.input,
      value.content,
      value.text,
      value.diff,
      value.body,
    ]);
    if (direct) {
      return extractPatchText(direct) || direct;
    }
    const command = value.command ?? value.cmd;
    if (Array.isArray(command)) {
      const patchArg = command.find((part) => typeof part === "string" && part.includes("*** Begin Patch"));
      if (patchArg) {
        return extractPatchText(patchArg) || patchArg;
      }
    }
    if (typeof command === "string") {
      return extractPatchText(command) || command;
    }
  }
  return typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue ?? {});
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("\"")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractPatchText(value) {
  const text = String(value ?? "");
  const start = text.indexOf("*** Begin Patch");
  const endMarker = "*** End Patch";
  const end = text.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    return null;
  }
  return `${text.slice(start, end + endMarker.length)}\n`;
}

function extractToolCalls(body) {
  const choices = body?.choices ?? body?.data?.choices ?? body?.result?.choices;
  const message = Array.isArray(choices) && choices.length
    ? choices[0]?.message ?? choices[0]?.delta ?? choices[0]
    : null;
  const chatToolCalls = message?.tool_calls ?? message?.toolCalls;
  if (Array.isArray(chatToolCalls) && chatToolCalls.length) {
    return chatToolCalls.map((call) => ({
      id: call.id || call.call_id,
      name: call.function?.name || call.name,
      arguments: call.function?.arguments ?? call.arguments ?? {},
    })).filter((call) => call.name);
  }

  const output = body?.output ?? body?.data?.output ?? body?.result?.output;
  if (Array.isArray(output)) {
    return output
      .filter((item) => item?.type === "function_call" || item?.type === "tool_call")
      .map((item) => ({
        id: item.call_id || item.id,
        name: item.name || item.function?.name,
        arguments: item.arguments ?? item.function?.arguments ?? {},
      }))
      .filter((call) => call.name);
  }
  return [];
}

function extractStreamTextDelta(body) {
  if (!body || typeof body !== "object") {
    return "";
  }
  if (body.type === "response.output_text.delta" && typeof body.delta === "string") {
    return body.delta;
  }
  if (typeof body.delta === "string") {
    return body.delta;
  }
  if (typeof body.output_text_delta === "string") {
    return body.output_text_delta;
  }
  if (typeof body.text_delta === "string") {
    return body.text_delta;
  }

  const choices = body?.choices ?? body?.data?.choices ?? body?.result?.choices;
  if (Array.isArray(choices) && choices.length) {
    const delta = choices[0]?.delta ?? choices[0]?.message?.delta;
    const direct = firstString([
      delta?.content,
      delta?.text,
      delta?.reasoning_content,
      choices[0]?.text,
    ]);
    if (direct) {
      return direct;
    }
    const content = textFromContent(delta?.content);
    if (content) {
      return content;
    }
  }

  const output = body?.output ?? body?.data?.output ?? body?.result?.output;
  if (Array.isArray(output)) {
    return output
      .flatMap((item) => item?.content ?? [])
      .filter((part) => part?.type === "output_text_delta" || part?.type === "text_delta")
      .map((part) => part.delta || part.text || "")
      .join("");
  }

  return "";
}

function extractAssistantText(body) {
  const direct = firstString([
    body?.output_text,
    body?.text,
    body?.message,
    body?.result,
    body?.data?.output_text,
    body?.data?.text,
    body?.data?.result,
  ]);
  if (direct) {
    return direct;
  }

  const choices = body?.choices ?? body?.data?.choices ?? body?.result?.choices;
  if (Array.isArray(choices) && choices.length) {
    const message = choices[0]?.message ?? choices[0]?.delta ?? choices[0];
    const content = message?.content ?? message?.text;
    const text = textFromContent(content);
    if (text) {
      return text;
    }
  }

  const output = body?.output ?? body?.data?.output;
  if (Array.isArray(output)) {
    const text = output.map((item) => textFromContent(item.content ?? item.text ?? item)).filter(Boolean).join("\n");
    if (text) {
      return text;
    }
  }

  return typeof body === "string" ? body : JSON.stringify(body);
}

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text ?? item?.output_text ?? item?.input_text ?? (typeof item === "string" ? item : null))
      .filter(Boolean)
      .join("");
  }
  if (content && typeof content === "object") {
    return content.text ?? content.output_text ?? content.input_text ?? JSON.stringify(content);
  }
  return "";
}

function extractUsage(body) {
  const usage = body?.usage ?? body?.data?.usage ?? body?.result?.usage ?? {};
  return {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    input_tokens_details: usage.input_tokens_details ?? null,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    output_tokens_details: usage.output_tokens_details ?? null,
    total_tokens: usage.total_tokens ?? 0,
  };
}

function detectOutputTruncation(body, usage, crawlRequest) {
  const finishReasons = extractFinishReasons(body);
  const finishReason = finishReasons.find((reason) =>
    /length|max[_\s-]*(output[_\s-]*)?tokens?|token[_\s-]*limit|truncat/i.test(reason)
  );
  const outputTokens = Number(usage?.output_tokens ?? 0);
  const requestedMaxTokens = optionalPositiveInteger(crawlRequest?.max_tokens);
  if (finishReason) {
    return {
      truncated: true,
      source: "finish_reason",
      finishReason,
      finishReasons,
      outputTokens,
      requestedMaxTokens,
    };
  }
  if (requestedMaxTokens && outputTokens >= requestedMaxTokens) {
    return {
      truncated: true,
      source: "requested_max_tokens",
      finishReason: null,
      finishReasons,
      outputTokens,
      requestedMaxTokens,
    };
  }
  if (!requestedMaxTokens
    && outputTokens > 0
    && IMPLICIT_OUTPUT_LIMIT_CANDIDATES.has(outputTokens)
    && Array.isArray(crawlRequest?.tools)
    && crawlRequest.tools.length
    && extractToolCalls(body).length === 0) {
    return {
      truncated: true,
      source: "implicit_provider_limit",
      finishReason: null,
      finishReasons,
      outputTokens,
      requestedMaxTokens: null,
    };
  }
  return {
    truncated: false,
    source: null,
    finishReason: null,
    finishReasons,
    outputTokens,
    requestedMaxTokens,
  };
}

function extractFinishReasons(body) {
  const reasons = [];
  collectFinishReason(reasons, body);
  collectFinishReason(reasons, body?.data);
  collectFinishReason(reasons, body?.result);
  collectFinishReason(reasons, body?.response);

  const choices = body?.choices ?? body?.data?.choices ?? body?.result?.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      collectFinishReason(reasons, choice);
      collectFinishReason(reasons, choice?.message);
      collectFinishReason(reasons, choice?.delta);
    }
  }

  const output = body?.output ?? body?.data?.output ?? body?.result?.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      collectFinishReason(reasons, item);
      collectFinishReason(reasons, item?.incomplete_details);
    }
  }

  return [...new Set(reasons.filter(Boolean).map(String))];
}

function collectFinishReason(reasons, value) {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const key of [
    "finish_reason",
    "finishReason",
    "stop_reason",
    "stopReason",
    "incomplete_reason",
    "incompleteReason",
    "reason",
    "status",
  ]) {
    const reason = value[key];
    if (typeof reason === "string" && reason) {
      reasons.push(reason);
    }
  }
}

function truncationMessage(truncation) {
  const limit = truncation.requestedMaxTokens
    ? `请求上限 ${truncation.requestedMaxTokens}`
    : `疑似服务端隐式上限 ${truncation.outputTokens}`;
  return [
    "ModelHub output was truncated before the tool call or final answer completed.",
    `Detected ${truncation.source}; output_tokens=${truncation.outputTokens || 0}; ${limit}.`,
    "This turn was not treated as completed. Retry with a larger output limit or split large file generation into smaller tool calls.",
  ].join(" ");
}

function sendResponsesMessage(response, { outputItems, requestCount, usage }) {
  const responseId = `resp-modelhub-${requestCount}`;
  const items = Array.isArray(outputItems) && outputItems.length
    ? outputItems.map((item, index) => ({
      ...item,
      id: item.id || (item.type === "message" ? `msg-modelhub-${requestCount}` : undefined),
      call_id: item.call_id || (item.type === "function_call" ? `call_modelhub_${requestCount}_${index + 1}` : undefined),
    }))
    : [{
      type: "message",
      role: "assistant",
      id: `msg-modelhub-${requestCount}`,
      content: [{ type: "output_text", text: "" }],
    }];
  const body = [
    sseEvent({
      type: "response.created",
      response: { id: responseId },
    }),
    ...items.map((item) => sseEvent({
      type: "response.output_item.done",
      item,
    })),
    sseEvent({
      type: "response.completed",
      response: {
        id: responseId,
        usage,
      },
    }),
  ].join("");
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.end(body);
}

function sendResponsesFailure(response, { code, message, status }) {
  const responseId = `resp-modelhub-error-${Date.now().toString(36)}`;
  const body = sseEvent({
    type: "response.failed",
    response: {
      id: responseId,
      error: {
        code: code || `modelhub_http_${status}`,
        message,
      },
    },
  });
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.end(body);
}

function sseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function textFromUnknown(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}
