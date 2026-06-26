#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const productHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-codex-modelhub-loop-"));
const workspace = path.join(productHome, "workspace");
const targetFile = "adapter-loop.md";
const targetPath = path.join(workspace, targetFile);

fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "README.md"), "# ModelHub Codex loop smoke\n");

const fake = await startFakeModelHub({ targetFile });
const server = spawn(
  "node",
  [
    "src/agent-server/server.mjs",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--product-home",
    productHome,
  ],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELHUB_AK: "test-ak",
      MODELHUB_CRAWL_URL: fake.url,
      MODELHUB_MODEL: "gpt-5.5-2026-04-24",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const stderr = readline.createInterface({ input: server.stderr });
stderr.on("line", (line) => console.error(`[server] ${line}`));

try {
  const startup = await readFirstJsonLine(server.stdout);
  const baseUrl = startup.url;
  const task = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "modelhub-gpt55",
    model: "gpt-5.5-2026-04-24",
    prompt: `创建 ${targetFile}，内容写一行 ModelHub adapter loop ok。`,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  });

  const fileText = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
  const requests = fake.requests.map((request) => summarizeCrawlRequest(request.body));
  const secondRequest = fake.requests[1]?.body;
  const ok = task.status === "completed"
    && /已创建/.test(task.finalMessage || "")
    && fileText.includes("ModelHub adapter loop ok")
    && fake.requests.length >= 2
    && requests[1]?.toolCallOutputIds.includes("call_apply_patch")
    && requests[1]?.assistantToolCallNames.includes("apply_patch")
    && task.eventTypes.includes("item.completed")
    && task.eventTypes.includes("turn.diff.updated")
    && task.eventTypes.includes("task.completed")
    && !task.error;

  console.log(JSON.stringify({
    ok,
    workspace,
    file: {
      path: targetPath,
      exists: fs.existsSync(targetPath),
      text: fileText,
    },
    task,
    fakeModelHub: {
      requestCount: fake.requests.length,
      requests,
    },
  }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  server.kill("SIGTERM");
  await fake.close();
}

async function runTask(baseUrl, request) {
  const create = await fetch(`${baseUrl}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const created = await create.json();
  if (!create.ok) {
    throw new Error(`task create failed: ${JSON.stringify(created)}`);
  }

  let artifact = null;
  for (let i = 0; i < 180; i += 1) {
    const artifactResponse = await fetch(`${baseUrl}${created.artifactUrl}`);
    artifact = await artifactResponse.json();
    if (artifact.status === "completed" || artifact.status === "failed" || artifact.status === "interrupted") {
      break;
    }
    await delay(250);
  }

  const events = Array.isArray(artifact?.events) ? artifact.events : [];
  return {
    taskId: created.taskId,
    conversationId: created.conversationId,
    threadId: created.threadId,
    turnId: created.turnId,
    status: artifact?.status,
    finalMessage: artifact?.finalMessage ?? null,
    error: artifact?.error ?? null,
    eventTypes: [...new Set(events.map((event) => event.type))],
    fileChanges: events
      .filter((event) => event.params?.item?.type === "fileChange")
      .map((event) => ({
        type: event.type,
        status: event.params.item.status,
        paths: event.params.item.changes?.map((change) => change.path) ?? [],
      })),
  };
}

async function startFakeModelHub({ targetFile }) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      requests.push({
        method: request.method,
        url: request.url,
        body,
      });

      response.writeHead(200, { "content-type": "application/json" });
      if (!hasToolOutput(body, "call_apply_patch")) {
        response.end(JSON.stringify(applyPatchResponse({ targetFile })));
        return;
      }
      response.end(JSON.stringify(finalResponse({ targetFile })));
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

function applyPatchResponse({ targetFile }) {
  const patch = [
    "*** Begin Patch",
    `*** Add File: ${targetFile}`,
    "+# ModelHub Adapter Loop",
    "+",
    "+ModelHub adapter loop ok.",
    "*** End Patch",
    "",
  ].join("\n");
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_apply_patch",
              type: "function",
              function: {
                name: "apply_patch",
                arguments: JSON.stringify({ patch }),
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
  };
}

function finalResponse({ targetFile }) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: `已创建 ${targetFile}。`,
        },
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28,
    },
  };
}

function summarizeCrawlRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return {
    model: body.model,
    stream: body.stream,
    toolNames: Array.isArray(body.tools)
      ? body.tools.map((tool) => tool.function?.name || tool.name).filter(Boolean)
      : [],
    messageRoles: messages.map((message) => message.role),
    assistantToolCallNames: messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function?.name || call.name)
      .filter(Boolean),
    toolCallOutputIds: messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id)
      .filter(Boolean),
  };
}

function hasToolOutput(body, callId) {
  return (body.messages ?? []).some((message) => message.role === "tool" && message.tool_call_id === callId);
}

function readFirstJsonLine(stream) {
  const rl = readline.createInterface({ input: stream });
  return new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      try {
        resolve(JSON.parse(line));
        rl.close();
      } catch (error) {
        reject(error);
      }
    });
    rl.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
