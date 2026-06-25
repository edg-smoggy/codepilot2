#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const productHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-codex-api-smoke-"));
const workspace = path.join(productHome, "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "README.md"), "# API smoke\n");

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
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const stderr = readline.createInterface({ input: server.stderr });
stderr.on("line", (line) => console.error(`[server] ${line}`));

try {
  const startup = await readFirstJsonLine(server.stdout);
  const baseUrl = startup.url;
  const environment = await apiJson(`${baseUrl}/v1/environment?workspacePath=${encodeURIComponent(workspace)}`);
  const promptTask = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "mock",
    prompt: "Return a one-line smoke response.",
    approvalPolicy: "never",
  });
  const followupTask = await runTask(
    baseUrl,
    {
      workspacePath: workspace,
      provider: "mock",
      prompt: "Continue the same conversation with another one-line response.",
      approvalPolicy: "never",
    },
    `/v1/conversations/${promptTask.conversationId}/turns`,
  );
  const inputTask = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "mock",
    approvalPolicy: "never",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.com/smoke.png",
          },
          {
            type: "input_text",
            text: "Return a one-line multimodal smoke response.",
          },
        ],
      },
    ],
  });

  const ok = promptTask.status === "completed"
    && followupTask.status === "completed"
    && inputTask.status === "completed"
    && promptTask.conversationId === followupTask.conversationId
    && promptTask.threadId === followupTask.threadId
    && environment.paths?.workspacePath === workspace
    && Array.isArray(environment.skills)
    && promptTask.hasEnvironmentDiagnostics
    && promptTask.logCounts.events > 0;

  console.log(JSON.stringify({
    ok,
    environment: {
      workspacePath: environment.paths?.workspacePath,
      npmRegistry: environment.npm?.registry,
      skills: environment.skills?.map((root) => ({
        path: root.path,
        exists: root.exists,
        count: root.count,
      })),
    },
    promptTask,
    followupTask,
    inputTask,
  }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  server.kill("SIGTERM");
}

async function runTask(baseUrl, request, endpoint = "/v1/tasks") {
  const create = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const created = await create.json();
  if (!create.ok) {
    throw new Error(`task create failed: ${JSON.stringify(created)}`);
  }

  let artifact = null;
  for (let i = 0; i < 100; i += 1) {
    const artifactResponse = await fetch(`${baseUrl}${created.artifactUrl}`);
    artifact = await artifactResponse.json();
    if (artifact.status === "completed" || artifact.status === "failed") {
      break;
    }
    await delay(100);
  }

  return {
    taskId: created.taskId,
    conversationId: created.conversationId,
    threadId: artifact?.threadId ?? created.threadId,
    turnId: artifact?.turnId ?? created.turnId,
    status: artifact?.status,
    finalMessage: artifact?.finalMessage,
    artifactPath: artifact?.artifactPath,
    hasEnvironmentDiagnostics: Boolean(artifact?.environmentDiagnostics),
    logCounts: await taskLogCounts(baseUrl, created.taskId),
  };
}

async function taskLogCounts(baseUrl, taskId) {
  const logs = await apiJson(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/logs?limit=20`);
  return {
    transcript: Array.isArray(logs.transcript) ? logs.transcript.length : 0,
    events: Array.isArray(logs.events) ? logs.events.length : 0,
  };
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`request failed: ${JSON.stringify(data)}`);
  }
  return data;
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
