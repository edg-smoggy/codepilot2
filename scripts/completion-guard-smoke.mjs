#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const productHome = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-completion-guard-"));
const workspace = path.join(productHome, "workspace");
const targetFile = "guard-created.md";
const targetPath = path.join(workspace, targetFile);

fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "README.md"), "# Completion guard smoke\n");

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
  const recoveredTask = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "modelhub-gpt55",
    model: "gpt-5.5-2026-04-24",
    prompt: `创建 ${targetFile}，内容写一行 completion guard ok。`,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  });
  const stalledTask = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "modelhub-gpt55",
    model: "gpt-5.5-2026-04-24",
    prompt: "STALLED_GUARD_CASE 创建 stalled.md，但模型会一直只说继续推进。",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
    maxAutoContinuations: 2,
  });

  const fileText = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
  const ok = recoveredTask.status === "completed"
    && recoveredTask.eventTypes.includes("task.continuation.started")
    && recoveredTask.autoContinuationCount === 1
    && fileText.includes("completion guard ok")
    && /已创建/.test(recoveredTask.finalMessage || "")
    && stalledTask.status === "failed"
    && stalledTask.eventTypes.includes("task.failed")
    && stalledTask.eventTypes.includes("turn.verification.failed")
    && !stalledTask.eventTypes.includes("turn.completed")
    && stalledTask.autoContinuationCount === 2
    && /缺少交付物|任务未真正完成/.test(stalledTask.error || "")
    && fake.requests.length >= 4
    && !recoveredTask.error;

  console.log(JSON.stringify({
    ok,
    workspace,
    file: {
      path: targetPath,
      exists: fs.existsSync(targetPath),
      text: fileText,
    },
    recoveredTask,
    stalledTask,
    fakeModelHub: {
      requestCount: fake.requests.length,
      requests: fake.requests.map((request) => summarizeCrawlRequest(request.body)),
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
    threadId: artifact?.threadId ?? created.threadId,
    turnId: artifact?.turnId ?? created.turnId,
    status: artifact?.status,
    finalMessage: artifact?.finalMessage ?? null,
    error: artifact?.error ?? null,
    autoContinuationCount: artifact?.autoContinuationCount ?? 0,
    eventTypes: [...new Set(events.map((event) => event.type))],
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
      if (isStalledGuardCase(body)) {
        if (!hasToolOutput(body, "call_update_plan")) {
          response.end(JSON.stringify(planResponse()));
          return;
        }
        response.end(JSON.stringify(prematureFinalResponse("继续推进：先落地文件，然后再验证。\n")));
        return;
      }
      if (!hasToolOutput(body, "call_update_plan")) {
        response.end(JSON.stringify(planResponse()));
        return;
      }
      if (!hasInternalContinuation(body)) {
        response.end(JSON.stringify(prematureFinalResponse()));
        return;
      }
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

function planResponse() {
  return toolCallResponse({
    id: "call_update_plan",
    name: "update_plan",
    argumentsValue: {
      plan: [
        { step: "编写文件", status: "in_progress" },
        { step: "验证产物", status: "pending" },
      ],
    },
  });
}

function prematureFinalResponse(text = "我先创建本地 Markdown 文件，再验证产物。\n") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
    usage: usage(),
  };
}

function applyPatchResponse({ targetFile }) {
  const patch = [
    "*** Begin Patch",
    `*** Add File: ${targetFile}`,
    "+# Completion Guard",
    "+",
    "+completion guard ok.",
    "*** End Patch",
    "",
  ].join("\n");
  return toolCallResponse({
    id: "call_apply_patch",
    name: "apply_patch",
    argumentsValue: { patch },
  });
}

function finalResponse({ targetFile }) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: `已创建 ${targetFile}，并验证文件存在。`,
        },
      },
    ],
    usage: usage(),
  };
}

function toolCallResponse({ id, name, argumentsValue }) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(argumentsValue),
              },
            },
          ],
        },
      },
    ],
    usage: usage(),
  };
}

function usage() {
  return {
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
  };
}

function summarizeCrawlRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return {
    toolNames: Array.isArray(body.tools)
      ? body.tools.map((tool) => tool.function?.name || tool.name).filter(Boolean)
      : [],
    messageRoles: messages.map((message) => message.role),
    toolCallOutputIds: messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id)
      .filter(Boolean),
    hasInternalContinuation: hasInternalContinuation(body),
  };
}

function hasToolOutput(body, callId) {
  return (body.messages ?? []).some((message) => message.role === "tool" && message.tool_call_id === callId);
}

function hasInternalContinuation(body) {
  return JSON.stringify(body.messages ?? []).includes("[CodePilot internal continuation]");
}

function isStalledGuardCase(body) {
  return JSON.stringify(body.messages ?? []).includes("STALLED_GUARD_CASE");
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
