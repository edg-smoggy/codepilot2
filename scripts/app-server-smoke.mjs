#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const UPSTREAM_ROOT = path.join(PROJECT_ROOT, "upstream", "openai-codex");
const APP_SERVER_BIN = path.join(
  UPSTREAM_ROOT,
  "codex-rs",
  "target",
  "debug",
  "codex-app-server",
);
const DEFAULT_TIMEOUT_MS = 25_000;

function parseArgs(argv) {
  const args = {
    startTurn: false,
    prompt:
      "In one short sentence, say the app-server smoke client is connected.",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keepTemp: false,
    mockProvider: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--start-turn") {
      args.startTurn = true;
    } else if (arg === "--keep-temp") {
      args.keepTemp = true;
    } else if (arg === "--real-provider") {
      args.mockProvider = false;
    } else if (arg === "--prompt") {
      args.prompt = requireValue(argv, (i += 1), "--prompt");
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number.parseInt(
        requireValue(argv, (i += 1), "--timeout-ms"),
        10,
      );
      if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function nowForFilename() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
}

function ensureAppServerBuilt() {
  if (fs.existsSync(APP_SERVER_BIN)) {
    return;
  }

  throw new Error(
    [
      `Missing app-server binary: ${APP_SERVER_BIN}`,
      "Build it first with:",
      "  cd upstream/openai-codex/codex-rs && cargo build -p codex-app-server",
    ].join("\n"),
  );
}

function appendJsonl(stream, event) {
  if (stream.destroyed || stream.writableEnded) {
    return;
  }
  stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function makeTempCodexHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icac-app-server-smoke-"));
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "README.md"),
    "# Internal Codex Runtime Smoke\n\nThis disposable workspace is used by the M1 app-server smoke client.\n",
  );

  const git = spawnSync("git", ["init"], {
    cwd: workspace,
    stdio: "ignore",
  });
  if (git.status !== 0) {
    throw new Error(`git init failed in disposable workspace: ${workspace}`);
  }

  return { root, codexHome, workspace };
}

function writeConfigToml({ codexHome, mockProviderUrl }) {
  const configPath = path.join(codexHome, "config.toml");
  const config = mockProviderUrl
    ? [
        'model = "mock-model"',
        'model_provider = "mock_provider"',
        'approval_policy = "never"',
        'sandbox_mode = "workspace-write"',
        "",
        "[model_providers.mock_provider]",
        'name = "Mock provider for smoke"',
        `base_url = "${mockProviderUrl}/v1"`,
        'wire_api = "responses"',
        "request_max_retries = 0",
        "stream_max_retries = 0",
        "supports_websockets = false",
        "",
      ]
    : [
        'model = "gpt-5"',
        'model_provider = "openai"',
        'approval_policy = "never"',
        'sandbox_mode = "workspace-write"',
        "",
      ];
  fs.writeFileSync(configPath, config.join("\n"));
  return configPath;
}

function sseEvent(event) {
  const type = event.type;
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function startMockResponsesServer(transcript) {
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
      const responseId = `resp-smoke-${requestCount}`;
      const messageId = `msg-smoke-${requestCount}`;
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
            content: [
              {
                type: "output_text",
                text: "M1 mock provider completed the local Codex runtime turn.",
              },
            ],
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
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

class AppServerClient {
  constructor({ child, transcript }) {
    this.child = child;
    this.transcript = transcript;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = [];
    this.exited = null;
  }

  attach() {
    const stdout = readline.createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => this.#handleStdoutLine(line));
    stdout.on("close", () => {
      this.#rejectAll(new Error("app-server stdout closed"));
    });

    const stderr = readline.createInterface({ input: this.child.stderr });
    stderr.on("line", (line) => {
      appendJsonl(this.transcript, { direction: "stderr", line });
    });

    this.exited = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        appendJsonl(this.transcript, {
          direction: "process",
          event: "exit",
          code,
          signal,
        });
        this.#rejectAll(new Error(`app-server exited code=${code} signal=${signal}`));
        resolve({ code, signal });
      });
    });
  }

  async close() {
    if (!this.child.killed && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
    }

    if (this.exited) {
      await withTimeout(this.exited, 3_000, "app-server shutdown").catch((error) => {
        appendJsonl(this.transcript, {
          direction: "process",
          event: "shutdown-timeout",
          error: error.message,
        });
      });
    }
  }

  async initialize() {
    const response = await this.request("initialize", {
      clientInfo: {
        name: "internal-codex-runtime-smoke",
        title: "Internal Codex Runtime Smoke",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
    return response;
  }

  startThread({ workspace }) {
    return this.request("thread/start", {
      cwd: workspace,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ephemeral: true,
      sessionStartSource: "startup",
      threadSource: "other",
    });
  }

  startTurn({ threadId, prompt, workspace }) {
    return this.request("turn/start", {
      threadId,
      cwd: workspace,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
      },
      input: [
        {
          type: "text",
          text: prompt,
          textElements: [],
        },
      ],
    });
  }

  waitForNotification(predicate, timeoutMs, label) {
    const existing = this.notifications.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }

    let timeout;
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
      timeout = setTimeout(() => {
        this.notificationWaiters = this.notificationWaiters.filter(
          (candidate) => candidate !== waiter,
        );
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.notificationWaiters.push(waiter);
    });
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: "2.0", id, method, params };
    appendJsonl(this.transcript, { direction: "client", message: payload });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
  }

  notify(method, params = {}) {
    const payload = { jsonrpc: "2.0", method, params };
    appendJsonl(this.transcript, { direction: "client", message: payload });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #handleStdoutLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      appendJsonl(this.transcript, { direction: "server-non-json", line });
      return;
    }

    appendJsonl(this.transcript, { direction: "server", message });

    if (Object.hasOwn(message, "id") && message.method) {
      this.#recordServerMessage(message);
      return;
    }

    if (Object.hasOwn(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (Object.hasOwn(message, "error")) {
        const error = new Error(
          `${pending.method} failed: ${JSON.stringify(message.error)}`,
        );
        error.rpc = message;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.#recordServerMessage(message);
    }
  }

  #recordServerMessage(message) {
    this.notifications.push(message);
    for (const waiter of [...this.notificationWaiters]) {
      if (waiter.predicate(message)) {
        this.notificationWaiters = this.notificationWaiters.filter(
          (candidate) => candidate !== waiter,
        );
        waiter.resolve(message);
      }
    }
  }

  #rejectAll(error) {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      waiter.reject(error);
    }
    this.notificationWaiters = [];
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureAppServerBuilt();

  const runDir = path.join(PROJECT_ROOT, "runs");
  fs.mkdirSync(runDir, { recursive: true });
  const transcriptPath = path.join(
    runDir,
    `m1_app_server_smoke_${nowForFilename()}.jsonl`,
  );
  const summaryPath = transcriptPath.replace(/\.jsonl$/, ".summary.json");
  const transcript = fs.createWriteStream(transcriptPath, { flags: "wx" });
  const temp = makeTempCodexHome();
  const useMockProvider = args.startTurn && args.mockProvider;
  const mockProvider = useMockProvider
    ? await startMockResponsesServer(transcript)
    : null;
  const configPath = writeConfigToml({
    codexHome: temp.codexHome,
    mockProviderUrl: mockProvider?.url ?? null,
  });

  const child = spawn(
    APP_SERVER_BIN,
    [
      "--listen",
      "stdio://",
      "--session-source",
      "cli",
      "--disable-plugin-startup-tasks-for-tests",
    ],
    {
      cwd: temp.codexHome,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_HOME: temp.codexHome,
        CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
        RUST_LOG: "warn",
        RUST_MIN_STACK: process.env.RUST_MIN_STACK || "67108864",
      },
    },
  );

  const client = new AppServerClient({ child, transcript });
  client.attach();

  const summary = {
    ok: false,
    transcriptPath,
    upstreamRoot: UPSTREAM_ROOT,
    appServerBin: APP_SERVER_BIN,
    tempRoot: temp.root,
    codexHome: temp.codexHome,
    workspace: temp.workspace,
    configPath,
    mockProviderEnabled: useMockProvider,
    mockProviderUrl: mockProvider?.url ?? null,
    startTurnRequested: args.startTurn,
    initialize: null,
    thread: null,
    turn: null,
    expectedProviderFailure: false,
  };

  try {
    summary.initialize = await withTimeout(
      client.initialize(),
      args.timeoutMs,
      "initialize",
    );

    const threadStart = await withTimeout(
      client.startThread({ workspace: temp.workspace }),
      args.timeoutMs,
      "thread/start",
    );
    summary.thread = {
      id: threadStart?.thread?.id ?? null,
      model: threadStart?.model ?? null,
      modelProvider: threadStart?.modelProvider ?? null,
      cwd: threadStart?.cwd ?? null,
    };

    if (!summary.thread.id) {
      throw new Error("thread/start response did not include thread.id");
    }

    if (args.startTurn) {
      try {
        const turnStart = await withTimeout(
          client.startTurn({
            threadId: summary.thread.id,
            prompt: args.prompt,
            workspace: temp.workspace,
          }),
          args.timeoutMs,
          "turn/start",
        );
        summary.turn = {
          id: turnStart?.turn?.id ?? null,
          status: turnStart?.turn?.status ?? null,
        };
        const turnCompleted = await client
          .waitForNotification(
            (message) =>
              message.method === "turn/completed" &&
              message.params?.threadId === summary.thread.id &&
              message.params?.turn?.id === summary.turn.id,
            Math.min(args.timeoutMs, 10_000),
            "turn/completed",
          )
          .catch((error) => ({ waitError: error.message }));
        if (turnCompleted.waitError) {
          summary.turn.waitError = turnCompleted.waitError;
        } else {
          summary.turn.status = turnCompleted.params?.turn?.status ?? summary.turn.status;
          summary.turn.error = turnCompleted.params?.turn?.error ?? null;
          summary.turn.completed = true;
        }
      } catch (error) {
        summary.turn = {
          error: error.message,
          rpc: error.rpc ?? null,
        };
        summary.expectedProviderFailure =
          /auth|login|api key|provider|model|OPENAI/i.test(error.message);
      }
    }

    summary.notificationCount = client.notifications.length;
    summary.ok = !args.startTurn
      ? true
      : useMockProvider
        ? summary.turn?.completed === true
        : Boolean(summary.turn?.id || summary.expectedProviderFailure);
  } finally {
    await client.close();
    if (mockProvider) {
      await mockProvider.close();
    }
    if (!args.keepTemp) {
      fs.rmSync(temp.root, { recursive: true, force: true });
      summary.tempRemoved = true;
    }
    transcript.end();
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
