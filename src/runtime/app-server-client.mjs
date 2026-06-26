import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

import { APP_SERVER_BIN } from "./paths.mjs";
import { appendJsonl } from "./jsonl.mjs";

export const DEFAULT_TIMEOUT_MS = 25_000;

export function ensureAppServerBuilt(appServerBin = APP_SERVER_BIN) {
  if (fs.existsSync(appServerBin)) {
    return;
  }

  throw new Error(
    [
      `Missing app-server binary: ${appServerBin}`,
      "Build it first with:",
      "  cd upstream/openai-codex/codex-rs && cargo build -p codex-app-server",
    ].join("\n"),
  );
}

export function startAppServerProcess({
  codexHome,
  appServerBin = APP_SERVER_BIN,
  sessionSource = "cli",
  disablePluginStartupTasks = true,
  disableManagedConfig = true,
  env = {},
}) {
  ensureAppServerBuilt(appServerBin);

  const args = ["--listen", "stdio://", "--session-source", sessionSource];
  if (disablePluginStartupTasks) {
    args.push("--disable-plugin-startup-tasks-for-tests");
  }

  return spawn(appServerBin, args, {
    cwd: codexHome,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...env,
      CODEX_HOME: codexHome,
      ...(disableManagedConfig ? { CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1" } : {}),
      RUST_LOG: env.RUST_LOG ?? "warn",
      RUST_MIN_STACK: env.RUST_MIN_STACK ?? process.env.RUST_MIN_STACK ?? "67108864",
    },
  });
}

export class AppServerClient {
  constructor({ child, transcript, onMessage, onNotification, onServerRequest, onStderr }) {
    this.child = child;
    this.transcript = transcript;
    this.onMessage = onMessage;
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.onStderr = onStderr;
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
      this.onStderr?.(line);
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

  async initialize({ clientName = "internal-codex-runtime", title = "Internal Codex Runtime", version = "0.2.0" } = {}) {
    const response = await this.request("initialize", {
      clientInfo: {
        name: clientName,
        title,
        version,
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
    return response;
  }

  startThread({
    workspace,
    model,
    provider,
    approvalPolicy = "on-request",
    approvalsReviewer = "user",
    sandbox = "workspace-write",
    threadSource = "other",
    personality = "pragmatic",
    ephemeral = false,
  }) {
    const params = {
      cwd: workspace,
      approvalPolicy,
      approvalsReviewer,
      sandbox,
      ephemeral,
      sessionStartSource: "startup",
      threadSource,
    };
    if (model) {
      params.model = model;
    }
    if (provider) {
      params.modelProvider = provider;
    }
    if (personality) {
      params.personality = personality;
    }
    return this.request("thread/start", params);
  }

  resumeThread({
    threadId,
    workspace,
    model,
    provider,
    approvalPolicy = "on-request",
    approvalsReviewer = "user",
    sandbox = "workspace-write",
    personality = "pragmatic",
    excludeTurns = true,
  }) {
    const params = {
      threadId,
      cwd: workspace,
      approvalPolicy,
      approvalsReviewer,
      sandbox,
      personality,
      excludeTurns,
    };
    if (model) {
      params.model = model;
    }
    if (provider) {
      params.modelProvider = provider;
    }
    return this.request("thread/resume", params);
  }

  startTurn({
    threadId,
    input,
    prompt,
    workspace,
    model,
    approvalPolicy = "on-request",
    sandboxPolicy,
    sandbox = "danger-full-access",
    networkAccess = true,
    personality = "pragmatic",
    collaborationMode = "default",
  }) {
    const userInput = input ?? [
      {
        type: "text",
        text: prompt,
        textElements: [],
      },
    ];
    const params = {
      threadId,
      cwd: workspace,
      approvalPolicy,
      input: userInput,
    };
    if (sandboxPolicy) {
      params.sandboxPolicy = sandboxPolicy;
    } else if (sandbox === "danger-full-access") {
      params.sandboxPolicy = {
        type: "dangerFullAccess",
      };
    } else {
      params.sandboxPolicy = {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess,
      };
    }
    if (model) {
      params.model = model;
    }
    if (personality) {
      params.personality = personality;
    }
    if (collaborationMode === "default" && model) {
      params.collaborationMode = {
        mode: "default",
        settings: {
          model,
          reasoning_effort: null,
          developer_instructions: null,
        },
      };
    }
    return this.request("turn/start", params);
  }

  interruptTurn({ threadId, turnId }) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  respondServerRequest({ requestId, result }) {
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      result,
    };
    appendJsonl(this.transcript, { direction: "client", message: payload });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  rejectServerRequest({ requestId, code = -32000, message = "Rejected by user", data = null }) {
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      error: { code, message, data },
    };
    appendJsonl(this.transcript, { direction: "client", message: payload });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  waitForNotification(predicate, timeoutMs, label) {
    const existing = this.notifications.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }

    let timeout;
    const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          resolve(message);
        },
        reject: (error) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          reject(error);
        },
      };
      if (hasTimeout) {
        timeout = setTimeout(() => {
          this.notificationWaiters = this.notificationWaiters.filter(
            (candidate) => candidate !== waiter,
          );
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
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

  async close({ timeoutMs = 3_000 } = {}) {
    if (!this.child.killed && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
    }

    if (this.exited) {
      await withTimeout(this.exited, timeoutMs, "app-server shutdown").catch((error) => {
        appendJsonl(this.transcript, {
          direction: "process",
          event: "shutdown-timeout",
          error: error.message,
        });
      });
    }
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
    this.onMessage?.(message);

    if (Object.hasOwn(message, "id") && message.method) {
      this.#handleServerRequest(message);
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

  #handleServerRequest(message) {
    this.onServerRequest?.(message);
    this.#recordServerMessage(message);
  }

  #recordServerMessage(message) {
    this.notifications.push(message);
    this.onNotification?.(message);
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

export function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}
