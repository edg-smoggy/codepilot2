#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const productHome = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-queue-smoke-"));
const fake = await startSlowModelHub();
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
      CODEPILOT_MAX_CONCURRENT_TASKS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const stderr = readline.createInterface({ input: server.stderr });
stderr.on("line", (line) => console.error(`[server] ${line}`));

try {
  const startup = await readFirstJsonLine(server.stdout);
  const baseUrl = startup.url;
  const workspace = makeWorkspace();
  const first = await createTask(baseUrl, workspace, "first queued smoke task");
  await waitForStatus(baseUrl, first.artifactUrl, ["starting", "running"], 10_000);
  const second = await createTask(baseUrl, workspace, "second queued smoke task");
  const secondInitial = await getArtifact(baseUrl, second.artifactUrl);
  const firstFinal = await waitForStatus(baseUrl, first.artifactUrl, ["completed"], 30_000);
  const secondFinal = await waitForStatus(baseUrl, second.artifactUrl, ["completed"], 30_000);
  const ok = secondInitial.status === "queued"
    && secondInitial.queuePosition === 1
    && firstFinal.status === "completed"
    && secondFinal.status === "completed"
    && fake.maxConcurrentRequests === 1;
  console.log(JSON.stringify({
    ok,
    productHome,
    first: {
      taskId: first.taskId,
      finalStatus: firstFinal.status,
    },
    second: {
      taskId: second.taskId,
      initialStatus: secondInitial.status,
      initialQueuePosition: secondInitial.queuePosition,
      finalStatus: secondFinal.status,
    },
    fakeModelHub: {
      requestCount: fake.requestCount,
      maxConcurrentRequests: fake.maxConcurrentRequests,
    },
  }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  server.kill("SIGTERM");
  await fake.close();
}

function makeWorkspace() {
  const workspace = path.join(productHome, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "# Queue smoke\n");
  return workspace;
}

async function createTask(baseUrl, workspacePath, prompt) {
  const response = await fetch(`${baseUrl}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspacePath,
      provider: "modelhub-gpt55",
      model: "gpt-5.5-2026-04-24",
      prompt,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      networkAccess: true,
    }),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`task create failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getArtifact(baseUrl, artifactUrl) {
  const response = await fetch(`${baseUrl}${artifactUrl}`);
  return response.json();
}

async function waitForStatus(baseUrl, artifactUrl, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let artifact = null;
  while (Date.now() < deadline) {
    artifact = await getArtifact(baseUrl, artifactUrl);
    if (statuses.includes(artifact.status)) {
      return artifact;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${statuses.join(", ")}; last=${artifact?.status}`);
}

async function startSlowModelHub() {
  let requestCount = 0;
  let activeRequests = 0;
  let maxConcurrentRequests = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      requestCount += 1;
      activeRequests += 1;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      await delay(900);
      activeRequests -= 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: `queue smoke completed ${requestCount}`,
          },
        }],
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    get requestCount() {
      return requestCount;
    },
    get maxConcurrentRequests() {
      return maxConcurrentRequests;
    },
    url: `http://${address.address}:${address.port}/api/modelhub/online/v2/crawl`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function readFirstJsonLine(stream) {
  const rl = readline.createInterface({ input: stream });
  return new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      try {
        resolve(JSON.parse(line));
        rl.close();
      } catch {
        reject(new Error(`Expected startup JSON, got: ${line}`));
      }
    });
    rl.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
