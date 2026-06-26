import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AppServerClient,
  startAppServerProcess,
  withTimeout,
} from "../runtime/app-server-client.mjs";
import { createJsonlStream, appendJsonlFile } from "../runtime/jsonl.mjs";
import { normalizeTaskInput } from "../runtime/input-adapter.mjs";
import { normalizeAppServerNotification, finalMessageFromEvents } from "../runtime/events.mjs";
import { startMockResponsesServer } from "../runtime/mock-responses-server.mjs";
import { startModelHubCrawlAdapter } from "../runtime/modelhub-crawl-adapter.mjs";
import { buildRuntimeEnvironment, collectEnvironmentDiagnostics } from "../runtime/environment-profile.mjs";
import { renderRuntimeConfig } from "../provider/config-renderer.mjs";
import { loadProvider } from "../provider/registry.mjs";
import {
  captureWorkspaceSnapshot,
  expectedArtifactsFromRequest,
  verifyTaskCompletion,
} from "./lightweight-completion-verifier.mjs";

const DEFAULT_START_TIMEOUT_MS = 90 * 1000;
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_AUTO_CONTINUATIONS = 2;
const TASK_ID_PATTERN = /^task_[a-z0-9]+_[a-f0-9]+$/;
const CONVERSATION_ID_PATTERN = /^conv_[a-z0-9]+_[a-f0-9]+$/;

export class TaskManager {
  constructor({ productHome }) {
    this.productHome = productHome;
    this.tasks = new Map();
    this.conversations = new Map();
    this.serverRequestIndex = new Map();
    this.maxConcurrentTasks = Number.parseInt(process.env.CODEPILOT_MAX_CONCURRENT_TASKS || "1", 10);
    this.runningTaskCount = 0;
    this.taskQueue = [];
    fs.mkdirSync(productHome, { recursive: true });
    fs.mkdirSync(path.join(productHome, "tasks"), { recursive: true });
    fs.mkdirSync(path.join(productHome, "conversations"), { recursive: true });
    ensureProductCodexHome(productHome);
  }

  async startTask(request) {
    const task = createTaskRecord(this.productHome, request);
    const conversation = this.#conversationForTask(task, request);
    task.conversationId = conversation.id;
    task.threadId = conversation.threadId ?? null;
    task.codexHome = task.runtimeMode === "product"
      ? productCodexHome(this.productHome)
      : path.join(conversation.conversationDir, "codex-home");
    this.tasks.set(task.id, task);
    this.#appendTaskToConversation(conversation, task.id);
    task.queuePosition = this.taskQueue.length + 1;
    this.#emit(task, {
      type: "task.queued",
      params: {
        taskId: task.id,
        conversationId: task.conversationId,
        provider: task.providerId,
        model: task.model,
        workspacePath: task.workspacePath,
        queuePosition: task.queuePosition,
      },
    });
    this.#writeArtifact(task);
    this.#updateConversationFromTask(task, { status: "queued" });
    task.readyPromise.catch(() => {});
    this.#enqueueTask(task);
    return task;
  }

  #enqueueTask(task) {
    this.taskQueue.push(task);
    this.#refreshQueuePositions();
    this.#drainQueue();
  }

  #drainQueue() {
    while (this.runningTaskCount < Math.max(1, this.maxConcurrentTasks) && this.taskQueue.length) {
      const task = this.taskQueue.shift();
      if (!task || task.status !== "queued") {
        continue;
      }
      this.#refreshQueuePositions();
      this.runningTaskCount += 1;
      task.queuePosition = null;
      task.runPromise = this.#runTask(task)
        .catch((error) => {
          task.status = "failed";
          task.error = errorMessage(error);
          this.#writeArtifact(task);
        })
        .finally(() => {
          this.runningTaskCount = Math.max(0, this.runningTaskCount - 1);
          this.#drainQueue();
        });
    }
  }

  #refreshQueuePositions() {
    this.taskQueue.forEach((task, index) => {
      task.queuePosition = index + 1;
      this.#writeArtifact(task);
    });
  }

  getTask(taskId) {
    return this.tasks.get(taskId) ?? loadTaskFromDisk(this.productHome, taskId);
  }

  listTasks({ limit = 50 } = {}) {
    const byId = new Map();
    for (const task of listTasksFromDisk(this.productHome)) {
      byId.set(task.id, summarizeTask(task));
    }
    for (const task of this.tasks.values()) {
      byId.set(task.id, summarizeTask(publicTaskArtifact(task)));
    }
    return [...byId.values()]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  getConversation(conversationId) {
    const conversation = this.conversations.get(conversationId) ?? loadConversationFromDisk(this.productHome, conversationId);
    if (conversation) {
      this.conversations.set(conversation.id, conversation);
    }
    return conversation;
  }

  listConversations({ limit = 50 } = {}) {
    const byId = new Map();
    for (const conversation of listConversationsFromDisk(this.productHome)) {
      byId.set(conversation.id, summarizeConversation(conversation, this.productHome, this.tasks));
    }
    for (const conversation of this.conversations.values()) {
      byId.set(conversation.id, summarizeConversation(conversation, this.productHome, this.tasks));
    }
    return [...byId.values()]
      .sort((a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime())
      .slice(0, limit);
  }

  getEnvironmentDiagnostics({ workspacePath } = {}) {
    const resolvedWorkspacePath = workspacePath ? path.resolve(workspacePath) : process.cwd();
    const effectiveWorkspacePath = fs.existsSync(resolvedWorkspacePath) ? resolvedWorkspacePath : process.cwd();
    ensureProductCodexHome(this.productHome, effectiveWorkspacePath);
    return collectEnvironmentDiagnostics({
      productHome: this.productHome,
      codexHome: productCodexHome(this.productHome),
      workspacePath: effectiveWorkspacePath,
      runtimeMode: "product",
    });
  }

  getTaskLogs(taskId, { limit = 400 } = {}) {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }
    return {
      taskId,
      transcriptPath: task.transcriptPath,
      eventsPath: task.eventsPath,
      transcript: readJsonlTail(task.transcriptPath, limit),
      events: readJsonlTail(task.eventsPath, limit),
    };
  }

  getDiff(taskId) {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }
    const workspacePath = task.workspacePath;
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      return {
        taskId,
        ok: false,
        reason: "workspace missing",
        diff: "",
      };
    }

    const baseline = loadGitBaseline(task, this.productHome);
    if (!baseline) {
      return {
        taskId,
        ok: false,
        reason: "task baseline missing; diff hidden to avoid showing pre-existing workspace changes",
        status: "",
        diff: "",
      };
    }
    if (!baseline.ok) {
      return {
        taskId,
        ok: false,
        reason: baseline.reason || "workspace is not a git repository; diff unavailable",
        status: "",
        diff: "",
      };
    }

    const current = captureGitBaseline(workspacePath);
    if (!current.ok) {
      return {
        taskId,
        ok: false,
        reason: current.reason,
        status: "",
        diff: "",
      };
    }

    const baselineEntries = new Map(baseline.entries.map((entry) => [entry.path, entry.raw]));
    const changedEntries = current.entries.filter((entry) => baselineEntries.get(entry.path) !== entry.raw);
    const changedPaths = changedEntries.map((entry) => entry.path);
    if (!changedPaths.length) {
      return {
        taskId,
        ok: true,
        reason: null,
        status: "",
        diff: "",
      };
    }

    const trackedPaths = changedEntries
      .filter((entry) => !entry.raw.startsWith("?? "))
      .map((entry) => entry.path);
    const result = trackedPaths.length ? spawnSync("git", ["diff", "--", ...trackedPaths], {
      cwd: workspacePath,
      encoding: "utf8",
      timeout: 10_000,
    }) : { status: 0, stdout: "", stderr: "" };
    if (result.error) {
      return {
        taskId,
        ok: false,
        reason: result.error.message,
        diff: "",
      };
    }

    const untrackedDiff = changedEntries
      .filter((entry) => entry.raw.startsWith("?? "))
      .map((entry) => diffForUntrackedFile(workspacePath, entry.path))
      .filter(Boolean)
      .join("\n");
    const diff = [result.stdout, untrackedDiff].filter(Boolean).join("\n");
    return {
      taskId,
      ok: result.status === 0,
      reason: result.status === 0 ? null : result.stderr.trim() || `git diff exited ${result.status}`,
      status: changedEntries.map((entry) => entry.raw).join("\n"),
      diff,
    };
  }

  subscribe(taskId, response) {
    const task = this.getTask(taskId);
    if (!task) {
      return false;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    for (const event of task.events) {
      writeSse(response, event);
    }

    if (isTerminalStatus(task.status)) {
      response.end();
      return true;
    }

    task.subscribers.add(response);
    response.on("close", () => task.subscribers.delete(response));
    return true;
  }

  async interrupt(taskId) {
    const task = this.tasks.get(taskId);
    if (task?.status === "queued") {
      this.taskQueue = this.taskQueue.filter((candidate) => candidate.id !== task.id);
      task.status = "interrupted";
      task.finishedAt = new Date().toISOString();
      task.queuePosition = null;
      this.#updateConversationFromTask(task, { status: "active" });
      this.#emit(task, {
        type: "task.interrupted",
        params: { taskId: task.id, reason: "queued task cancelled" },
      });
      task.subscribers.forEach((subscriber) => subscriber.end());
      task.subscribers.clear();
      this.#writeArtifact(task);
      this.#refreshQueuePositions();
      return { ok: true, taskId };
    }
    if (!task?.client || !task.threadId || !task.turnId) {
      throw new Error("Task is not interruptible");
    }
    await task.client.interruptTurn({ threadId: task.threadId, turnId: task.turnId });
    this.#emit(task, {
      type: "task.interrupt.requested",
      params: { taskId },
    });
  }

  async resolveServerRequest(taskId, requestId, body = {}) {
    const task = this.tasks.get(taskId);
    if (!task?.client) {
      throw new Error("Task is not waiting for live server requests");
    }
    const serverRequest = task.serverRequests.get(String(requestId));
    if (!serverRequest) {
      throw new Error(`Server request not found: ${requestId}`);
    }
    if (serverRequest.status !== "pending") {
      throw new Error(`Server request is already ${serverRequest.status}`);
    }

    if (body.reject || body.action === "reject") {
      const message = body.message || "Rejected by user";
      task.client.rejectServerRequest({ requestId: serverRequest.rawId, message });
      serverRequest.status = "rejected";
      serverRequest.resolvedAt = new Date().toISOString();
      this.#emit(task, {
        type: "serverRequest.rejected",
        params: { taskId: task.id, requestId: String(requestId), message },
      });
      this.#writeArtifact(task);
      return serverRequest;
    }

    const result = serverRequestResult(serverRequest, body);
    task.client.respondServerRequest({ requestId: serverRequest.rawId, result });
    serverRequest.status = "resolved";
    serverRequest.resolvedAt = new Date().toISOString();
    serverRequest.result = result;
    this.#emit(task, {
      type: "serverRequest.response.sent",
      params: { taskId: task.id, requestId: String(requestId), result },
    });
    this.#writeArtifact(task);
    return serverRequest;
  }

  async #runTask(task) {
    let mockProvider = null;
    let providerAdapter = null;
    let transcript = null;
    let client = null;
    let runError = null;
    try {
      task.status = "starting";
      task.queuePosition = null;
      fs.mkdirSync(task.taskDir, { recursive: true });
      fs.mkdirSync(task.codexHome, { recursive: true });
      this.#updateConversationFromTask(task, { status: "starting" });
      this.#emit(task, {
        type: "task.started",
        params: {
          taskId: task.id,
          conversationId: task.conversationId,
          provider: task.providerId,
          model: task.model,
          workspacePath: task.workspacePath,
        },
      });
      this.#writeArtifact(task);
      if (task.runtimeMode === "product") {
        ensureProductCodexHome(this.productHome, task.workspacePath);
      }
      const runtimeEnvironment = buildRuntimeEnvironment({
        productHome: this.productHome,
        workspacePath: task.workspacePath,
        runtimeMode: task.runtimeMode,
        overrides: task.request?.env && typeof task.request.env === "object" ? task.request.env : {},
      });
      task.environmentDiagnostics = collectEnvironmentDiagnostics({
        productHome: this.productHome,
        codexHome: task.codexHome,
        workspacePath: task.workspacePath,
        runtimeMode: task.runtimeMode,
      });
      this.#emit(task, {
        type: "runtime.environment.ready",
        params: {
          codexHome: task.codexHome,
          shellEnvLoaded: task.environmentDiagnostics.shellEnvLoaded,
          npmRegistry: task.environmentDiagnostics.npm?.registry ?? null,
          nodeExtraCaCerts: task.environmentDiagnostics.env?.NODE_EXTRA_CA_CERTS ?? null,
          skillRoots: task.environmentDiagnostics.skills ?? [],
        },
      });
      task.baselinePath = path.join(task.taskDir, "baseline.json");
      fs.writeFileSync(task.baselinePath, `${JSON.stringify(captureGitBaseline(task.workspacePath), null, 2)}\n`);
      task.workspaceBaselinePath = path.join(task.taskDir, "workspace-baseline.json");
      task.workspaceBaseline = captureWorkspaceSnapshot(task.workspacePath);
      fs.writeFileSync(task.workspaceBaselinePath, `${JSON.stringify(task.workspaceBaseline, null, 2)}\n`);
      transcript = createJsonlStream(task.transcriptPath);

      const provider = loadProvider(task.providerId);
      let providerOverride = provider;
      if (task.providerId === "mock") {
        mockProvider = await startMockResponsesServer({ transcript });
        providerOverride = {
          ...provider,
          baseUrl: `${mockProvider.url}/v1`,
        };
      } else if (provider.adapter === "modelhub-crawl") {
        providerAdapter = await startModelHubCrawlAdapter({
          transcript,
          defaultModel: task.model,
          streamDefault: provider.stream === true,
          capabilities: provider.capabilities ?? {},
        });
        providerOverride = {
          ...provider,
          baseUrl: `${providerAdapter.url}/v1`,
        };
      }

      const rendered = renderRuntimeConfig({
        codexHome: task.codexHome,
        providerId: task.providerId,
        providerOverride,
        model: task.model,
        approvalPolicy: task.approvalPolicy,
        sandboxMode: task.sandbox,
      });
      task.resolvedProvider = rendered.provider.id;
      task.resolvedModel = rendered.model;
      task.configPath = rendered.configPath;

      let rejectFatalRuntime;
      const fatalRuntime = new Promise((_, reject) => {
        rejectFatalRuntime = reject;
      });
      let fatalRuntimeMessage = null;

      const child = startAppServerProcess({
        codexHome: task.codexHome,
        disablePluginStartupTasks: true,
        disableManagedConfig: true,
        env: runtimeEnvironment.env,
      });
      client = new AppServerClient({
        child,
        transcript,
        onServerRequest: (message) => {
          this.#noteServerRequest(task, message);
        },
        onNotification: (message) => {
          const event = normalizeAppServerNotification(message);
          if (event.type === "turn.completed") {
            task.rawTurnCompletedEvent = event;
            task.rawTurnCompletedEvents.push(event);
            this.#writeArtifact(task);
            return;
          }
          this.#emit(task, event);
        },
        onStderr: (line) => {
          if (!fatalRuntimeMessage && isFatalRuntimeLine(line)) {
            fatalRuntimeMessage = fatalRuntimeMessageFromLine(line);
            rejectFatalRuntime(new Error(fatalRuntimeMessage));
          }
        },
      });
      task.client = client;
      client.attach();

      task.initialize = await withTimeout(client.initialize(), task.startTimeoutMs, "initialize");
      const conversation = this.getConversation(task.conversationId);
      if (!conversation) {
        throw new Error(`Conversation not found: ${task.conversationId}`);
      }
      if (conversation.threadId) {
        const threadResume = await withTimeout(
          client.resumeThread({
            threadId: conversation.threadId,
            workspace: task.workspacePath,
            model: task.resolvedModel,
            provider: task.resolvedProvider,
            approvalPolicy: task.approvalPolicy,
            sandbox: task.sandbox,
          }),
          task.startTimeoutMs,
          "thread/resume",
        );
        task.threadId = threadResume?.thread?.id ?? conversation.threadId;
      } else {
        const threadStart = await withTimeout(
          client.startThread({
            workspace: task.workspacePath,
            model: task.resolvedModel,
            provider: task.resolvedProvider,
            approvalPolicy: task.approvalPolicy,
            sandbox: task.sandbox,
            ephemeral: false,
          }),
          task.startTimeoutMs,
          "thread/start",
        );
        task.threadId = threadStart?.thread?.id;
        if (!task.threadId) {
          throw new Error("thread/start did not return thread.id");
        }
        conversation.threadId = task.threadId;
        conversation.status = "active";
        conversation.updatedAt = new Date().toISOString();
        this.#writeConversation(conversation);
      }

      let nextInput = task.input;
      while (true) {
        const turnStart = await withTimeout(
          client.startTurn({
            threadId: task.threadId,
            input: nextInput,
            workspace: task.workspacePath,
            model: task.resolvedModel,
            approvalPolicy: task.approvalPolicy,
            sandbox: task.sandbox,
            networkAccess: task.networkAccess,
          }),
          task.startTimeoutMs,
          "turn/start",
        );

        task.turnId = turnStart?.turn?.id;
        if (!task.turnId) {
          throw new Error("turn/start did not return turn.id");
        }
        task.status = "running";
        this.#updateConversationFromTask(task, { status: "running" });
        task.readyResolve();
        this.#writeArtifact(task);

        const completed = await Promise.race([
          client.waitForNotification(
            (message) =>
              message.method === "turn/completed" &&
              message.params?.threadId === task.threadId &&
              message.params?.turn?.id === task.turnId,
            task.turnTimeoutMs,
            "turn/completed",
          ),
          fatalRuntime,
          client.exited?.then(({ code, signal }) => {
            throw new Error(`app-server exited before turn completed code=${code} signal=${signal}`);
          }),
        ])
          .catch((error) => ({ waitError: error.message }));

        if (completed.waitError) {
          task.status = "failed";
          task.error = errorMessage(completed.waitError);
          this.#updateConversationFromTask(task, { status: "failed" });
          this.#emit(task, {
            type: "task.failed",
            params: { taskId: task.id, error: task.error },
          });
          break;
        }

        const turn = completed.params?.turn;
        if (turn?.status !== "completed") {
          task.status = "failed";
          task.error = errorMessage(turn?.error) || "turn did not complete";
          this.#updateConversationFromTask(task, { status: "failed" });
          this.#emit(task, {
            type: "task.failed",
            params: { taskId: task.id, error: task.error },
          });
          break;
        }

        const validation = validateTaskCompletion(task, {
          turnId: task.turnId,
          pendingGuard: task.pendingCompletionGuard,
        });
        task.completionVerification = validation.completionVerification ?? task.completionVerification;
        task.completedArtifacts = validation.completedArtifacts ?? task.completedArtifacts;
        task.missingArtifacts = validation.missingArtifacts ?? task.missingArtifacts;
        this.#emit(task, {
          type: validation.ok ? "turn.verification.passed" : "turn.verification.failed",
          params: {
            taskId: task.id,
            threadId: task.threadId,
            turnId: task.turnId,
            ok: validation.ok,
            reason: validation.reason,
            status: validation.completionVerification?.status ?? (validation.ok ? "passed" : "failed"),
            completedArtifacts: task.completedArtifacts,
            missingArtifacts: task.missingArtifacts,
          },
        });
        if (!validation.ok && validation.recoverable !== false && task.autoContinuationCount < task.maxAutoContinuations) {
          task.autoContinuationCount += 1;
          task.pendingCompletionGuard = {
            reason: validation.reason,
            turnId: task.turnId,
            attempt: task.autoContinuationCount,
          };
          task.finalMessage = null;
          task.status = "running";
          this.#emit(task, {
            type: "task.continuation.started",
            params: {
              taskId: task.id,
              threadId: task.threadId,
              previousTurnId: task.turnId,
              attempt: task.autoContinuationCount,
              maxAttempts: task.maxAutoContinuations,
              reason: validation.reason,
            },
          });
          this.#writeArtifact(task);
          nextInput = buildContinuationInput(validation);
          continue;
        }

        task.finalMessage = finalMessageFromEvents(task.events);
        if (!validation.ok) {
          task.status = "failed";
          task.error = `任务未真正完成：${validation.reason}`;
        } else {
          task.status = "completed";
          task.error = null;
          task.pendingCompletionGuard = null;
          if (task.rawTurnCompletedEvent) {
            this.#emit(task, {
              ...task.rawTurnCompletedEvent,
              id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
              params: {
                ...(task.rawTurnCompletedEvent.params ?? {}),
                verified: true,
              },
            });
          }
        }
        this.#updateConversationFromTask(task, {
          status: task.status === "completed" ? "active" : "failed",
          title: task.finalMessage ? task.finalMessage.trim().slice(0, 80) : undefined,
        });
        this.#emit(task, {
          type: task.status === "completed" ? "task.completed" : "task.failed",
          params: {
            taskId: task.id,
            threadId: task.threadId,
            turnId: task.turnId,
            status: task.status,
            error: task.error,
          },
        });
        break;
      }
    } catch (error) {
      runError = error;
      task.status = "failed";
      task.error = errorMessage(error);
      this.#updateConversationFromTask(task, { status: "failed" });
      if (task.readyReject) {
        task.readyReject(error);
      }
      this.#emit(task, {
        type: "task.failed",
        params: { taskId: task.id, error: task.error },
      });
    } finally {
      if (!runError && task.readyReject && task.status === "starting") {
        task.readyReject(task.error ? new Error(task.error) : new Error("Task failed to start"));
      }
      if (client) {
        await client.close();
      }
      if (mockProvider) {
        await mockProvider.close();
      }
      if (providerAdapter) {
        await providerAdapter.close();
      }
      if (transcript) {
        transcript.end();
      }
      task.finishedAt = new Date().toISOString();
      task.client = null;
      task.subscribers.forEach((subscriber) => subscriber.end());
      task.subscribers.clear();
      this.#writeArtifact(task);
    }
  }

  #emit(task, event) {
    const normalized = {
      id: event.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ts: event.ts ?? new Date().toISOString(),
      type: event.type,
      params: event.params ?? {},
      rawMethod: event.rawMethod,
    };
    task.events.push(normalized);
    appendJsonlFile(task.eventsPath, normalized);
    for (const subscriber of task.subscribers) {
      writeSse(subscriber, normalized);
    }
  }

  #writeArtifact(task) {
    const artifact = publicTaskArtifact(task);
    fs.writeFileSync(task.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }

  #conversationForTask(task, request) {
    const requestedId = request.conversationId ?? request.conversation_id;
    if (requestedId) {
      const conversation = this.getConversation(requestedId);
      if (!conversation) {
        throw new Error(`Conversation not found: ${requestedId}`);
      }
      this.conversations.set(conversation.id, conversation);
      return conversation;
    }

    const conversation = createConversationRecord(this.productHome, {
      workspacePath: task.workspacePath,
      providerId: task.providerId,
      model: task.model,
      approvalPolicy: task.approvalPolicy,
      sandbox: task.sandbox,
      networkAccess: task.networkAccess,
      runtimeMode: task.runtimeMode,
      title: promptPreview(request),
    });
    this.conversations.set(conversation.id, conversation);
    this.#writeConversation(conversation);
    return conversation;
  }

  #appendTaskToConversation(conversation, taskId) {
    if (!conversation.taskIds.includes(taskId)) {
      conversation.taskIds.push(taskId);
    }
    conversation.updatedAt = new Date().toISOString();
    this.#writeConversation(conversation);
  }

  #updateConversationFromTask(task, updates = {}) {
    const conversation = this.getConversation(task.conversationId);
    if (!conversation) {
      return;
    }
    if (updates.status) {
      conversation.status = updates.status;
    }
    if (updates.title && (!conversation.title || conversation.title === "Untitled task")) {
      conversation.title = updates.title;
    }
    conversation.threadId = task.threadId ?? conversation.threadId;
    conversation.updatedAt = new Date().toISOString();
    this.conversations.set(conversation.id, conversation);
    this.#writeConversation(conversation);
  }

  #writeConversation(conversation) {
    fs.mkdirSync(conversation.conversationDir, { recursive: true });
    fs.writeFileSync(conversation.artifactPath, `${JSON.stringify(publicConversationArtifact(conversation), null, 2)}\n`);
  }

  #noteServerRequest(task, message) {
    const requestId = String(message.id);
    const serverRequest = {
      id: requestId,
      rawId: message.id,
      method: message.method,
      params: message.params ?? {},
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    task.serverRequests.set(requestId, serverRequest);
    this.serverRequestIndex.set(`${task.id}:${requestId}`, task.id);
    this.#writeArtifact(task);
  }
}

function createTaskRecord(productHome, request) {
  const providerId = request.provider ?? "ark";
  const provider = loadProvider(providerId);
  const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const workspacePath = path.resolve(request.workspacePath ?? request.workspace_path ?? process.cwd());
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`workspacePath does not exist: ${workspacePath}`);
  }
  if (isUnsafeWorkspacePath(workspacePath)) {
    throw new Error(`workspacePath points inside the CodePilot app bundle. Please choose a normal project folder: ${workspacePath}`);
  }

  const taskDir = path.join(productHome, "tasks", taskId);
  const expectedArtifacts = expectedArtifactsForTask(productHome, request);
  const task = {
    id: taskId,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: "queued",
    queuePosition: null,
    request,
    conversationId: request.conversationId ?? request.conversation_id ?? null,
    runtimeMode: request.runtimeMode ?? request.runtime_mode ?? (providerId === "mock" ? "test" : "product"),
    providerId,
    model: request.model ?? provider.defaultModel,
    approvalPolicy: request.approvalPolicy ?? request.approval_policy ?? "on-request",
    sandbox: request.sandbox ?? request.sandboxMode ?? "danger-full-access",
    networkAccess: request.networkAccess ?? request.network_access ?? true,
    workspacePath,
    taskDir,
    codexHome: path.join(taskDir, "codex-home"),
    transcriptPath: path.join(taskDir, "raw.jsonl"),
    eventsPath: path.join(taskDir, "events.jsonl"),
    artifactPath: path.join(taskDir, "artifact.json"),
    baselinePath: path.join(taskDir, "baseline.json"),
    workspaceBaselinePath: path.join(taskDir, "workspace-baseline.json"),
    startTimeoutMs: request.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    turnTimeoutMs: request.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    maxAutoContinuations: normalizeMaxAutoContinuations(
      request.maxAutoContinuations ?? request.max_auto_continuations ?? process.env.CODEPILOT_MAX_AUTO_CONTINUATIONS,
    ),
    autoContinuationCount: 0,
    pendingCompletionGuard: null,
    expectedArtifacts,
    workspaceBaseline: null,
    completedArtifacts: [],
    missingArtifacts: [],
    completionVerification: null,
    rawTurnCompletedEvent: null,
    rawTurnCompletedEvents: [],
    events: [],
    subscribers: new Set(),
    threadId: null,
    turnId: null,
    finalMessage: null,
    error: null,
    client: null,
    serverRequests: new Map(),
    environmentDiagnostics: null,
    input: normalizeTaskInput(request),
  };
  task.readyPromise = new Promise((resolve, reject) => {
    task.readyResolve = resolve;
    task.readyReject = reject;
  });
  return task;
}

function expectedArtifactsForTask(productHome, request) {
  const current = expectedArtifactsFromRequest(request);
  const inherited = inheritedExpectedArtifactsForContinuation(productHome, request, current);
  return inherited ?? current;
}

function inheritedExpectedArtifactsForContinuation(productHome, request, current) {
  if (!isContinuationRequest(current)) {
    return null;
  }
  const conversationId = request.conversationId ?? request.conversation_id;
  if (!conversationId || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    return null;
  }
  const conversation = loadConversationFromDisk(productHome, conversationId);
  if (!conversation?.taskIds?.length) {
    return null;
  }
  for (const taskId of [...conversation.taskIds].reverse()) {
    const priorTask = loadTaskFromDisk(productHome, taskId);
    const priorExpected = priorTask?.expectedArtifacts;
    if (!priorExpected || onlyTextAnswer(priorExpected)) {
      continue;
    }
    return {
      ...JSON.parse(JSON.stringify(priorExpected)),
      prompt: current.prompt,
      inheritedFromTaskId: priorTask.id,
      inheritedFromPrompt: priorExpected.prompt ?? null,
    };
  }
  return null;
}

function isContinuationRequest(expectedArtifacts) {
  if (!onlyTextAnswer(expectedArtifacts)) {
    return false;
  }
  const prompt = String(expectedArtifacts?.prompt || "").trim();
  if (!prompt || prompt.length > 80) {
    return false;
  }
  return /^(继续|接着|继续完成|继续做|继续推进|继续上面|继续刚才|接上|继续吧|接着做|go on|continue)(?:$|[\s，。,.！!？?])/i.test(prompt);
}

function onlyTextAnswer(expectedArtifacts) {
  const artifacts = expectedArtifacts?.artifacts ?? [];
  return artifacts.length === 1 && artifacts[0]?.kind === "text_answer";
}

function validateTaskCompletion(task, { turnId, pendingGuard = null } = {}) {
  const completionVerification = verifyTaskCompletion(task, {
    baseline: task.workspaceBaseline ?? loadWorkspaceBaseline(task),
  });
  const baseResult = {
    completionVerification,
    completedArtifacts: completionVerification.completedArtifacts,
    missingArtifacts: completionVerification.missingArtifacts,
    recoverable: completionVerification.status !== "unrecoverable_failed",
  };

  const pendingRequests = [...(task.serverRequests?.values?.() ?? [])].filter((request) => request.status === "pending");
  if (pendingRequests.length) {
    return {
      ...baseResult,
      ok: false,
      recoverable: false,
      reason: `还有 ${pendingRequests.length} 个确认请求未处理`,
    };
  }

  if (!completionVerification.ok) {
    return {
      ...baseResult,
      ok: false,
      reason: completionVerification.reason,
    };
  }

  const latestPlan = latestPlanFromEvents(task.events, { turnId });
  if (!latestPlan?.length) {
    return { ...baseResult, ok: true, reason: null };
  }

  const incompleteSteps = latestPlan.filter((step) => !isCompletedPlanStatus(step?.status));
  if (!incompleteSteps.length) {
    return { ...baseResult, ok: true, reason: null };
  }

  const preview = incompleteSteps
    .slice(0, 3)
    .map((step) => `${String(step?.step || "未命名步骤")}(${String(step?.status || "unknown")})`)
    .join("、");
  return {
    ...baseResult,
    ok: false,
    reason: `计划仍未完成：${preview}`,
  };
}

function hasCompletionEvidenceForTurn(events, turnId) {
  return (events ?? []).some((event) => {
    if (turnId && event.params?.turnId !== turnId) {
      return false;
    }
    if (event.type === "turn.diff.updated") {
      return true;
    }
    if (event.type !== "item.completed") {
      return false;
    }
    const item = event.params?.item;
    if (!item || item.status === "failed") {
      return false;
    }
    if (item.type === "fileChange") {
      return true;
    }
    if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
      return !item.error;
    }
    if (item.type !== "commandExecution") {
      return false;
    }
    const command = String(item.command || item.commandActions?.map((action) => action.command).join(" ") || "");
    return Number(item.exitCode ?? item.exit_code ?? 1) === 0 && isDeliveryCommand(command);
  });
}

function isDeliveryCommand(command) {
  return /\b(lark-cli\s+(docs|markdown|drive)\s+\+?(create|update|overwrite|import|upload)|cat\s+>|tee\s+|touch\s+|mkdir\s+|printf\s+.*>|python3?\s+.*\b(open|write)\(|node\s+.*writeFile|npm\s+(create|init)|pnpm\s+(create|init)|yarn\s+(create|init))\b/i.test(command);
}

function latestPlanFromEvents(events, { turnId } = {}) {
  for (const event of [...(events ?? [])].reverse()) {
    if (
      event.type === "turn.plan.updated" &&
      (!turnId || event.params?.turnId === turnId) &&
      Array.isArray(event.params?.plan)
    ) {
      return event.params.plan;
    }
  }
  return null;
}

function isCompletedPlanStatus(status) {
  const normalized = String(status || "").toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "completed" || normalized === "done";
}

function buildContinuationInput(validation) {
  const completedArtifacts = (validation.completedArtifacts ?? [])
    .slice(0, 8)
    .map((artifact) => `- ${artifact.kind || artifact.type}: ${artifact.relativePath || artifact.path || artifact.url || artifact.source || "已完成"}`);
  const missingArtifacts = (validation.missingArtifacts ?? [])
    .slice(0, 8)
    .map((artifact) => `- ${artifact.kind || artifact.type}: ${artifact.reason || "缺失"}`);
  return [
    {
      type: "text",
      text: [
        "[CodePilot internal continuation]",
        "检测到上一轮在任务完成前结束，请继续推进原始用户任务。",
        `未完成原因：${validation.reason}`,
        completedArtifacts.length ? "已完成交付物：" : null,
        ...completedArtifacts,
        missingArtifacts.length ? "缺失交付物：" : null,
        ...missingArtifacts,
        "不要只回复计划；请继续使用工具完成缺失交付物。",
        "不要重做、覆盖或重复创建已完成交付物，除非必须修复明显错误。",
        "只有在所有计划步骤完成、文件/文档/链接等交付物可验证后，才输出最终结果。",
      ].filter(Boolean).join("\n"),
      textElements: [],
    },
  ];
}

function normalizeMaxAutoContinuations(value) {
  const parsed = Number.parseInt(value ?? `${DEFAULT_MAX_AUTO_CONTINUATIONS}`, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MAX_AUTO_CONTINUATIONS;
  }
  return Math.min(parsed, 5);
}

export function isUnsafeWorkspacePath(workspacePath) {
  const normalized = path.resolve(String(workspacePath || ""));
  const marker = `${path.sep}Contents${path.sep}Resources`;
  return normalized.includes(`.app${marker}`);
}

function productCodexHome(productHome) {
  return path.join(productHome, "codex-home");
}

function ensureProductCodexHome(productHome, workspacePath = null) {
  const codexHome = productCodexHome(productHome);
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(codexHome, "skills"), { recursive: true });
  linkSkillDirsIfPresent(path.join(os.homedir(), ".codex", "skills"), path.join(codexHome, "skills"));
  linkSkillDirsIfPresent(path.join(os.homedir(), ".agents", "skills"), path.join(codexHome, "skills"));
  if (workspacePath) {
    linkSkillDirsIfPresent(path.join(workspacePath, ".agents", "skills"), path.join(codexHome, "skills"));
    const gitRoot = gitRootForWorkspace(workspacePath);
    if (gitRoot && gitRoot !== workspacePath) {
      linkSkillDirsIfPresent(path.join(gitRoot, ".agents", "skills"), path.join(codexHome, "skills"));
    }
  }
  linkIfPresent(path.join(os.homedir(), ".codex", "plugins"), path.join(codexHome, "plugins"));
  linkIfPresent(path.join(os.homedir(), ".agents", "plugins"), path.join(codexHome, "plugins"));
  linkIfPresent(path.join(os.homedir(), ".codex", "auth.json"), path.join(codexHome, "auth.json"));
  linkIfPresent(path.join(os.homedir(), ".codex", "credentials.json"), path.join(codexHome, "credentials.json"));
  return codexHome;
}

function linkSkillDirsIfPresent(sourceSkillsDir, targetSkillsDir) {
  if (!fs.existsSync(sourceSkillsDir) || !fs.statSync(sourceSkillsDir).isDirectory()) {
    return;
  }
  for (const entry of fs.readdirSync(sourceSkillsDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceSkillsDir, entry.name);
    if (!safeDirectoryExists(sourcePath)) {
      continue;
    }
    linkIfPresent(sourcePath, path.join(targetSkillsDir, entry.name));
  }
}

function linkIfPresent(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
    return;
  }
  try {
    const stat = fs.statSync(sourcePath);
    fs.symlinkSync(sourcePath, targetPath, stat.isDirectory() ? "dir" : "file");
  } catch {
    // Product home setup is best-effort; missing auth/plugin state should not stop local tasks.
  }
}

function gitRootForWorkspace(workspacePath) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspacePath,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0 || result.error) {
    return null;
  }
  return result.stdout.trim() || null;
}

function safeDirectoryExists(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function createConversationRecord(productHome, data) {
  const conversationId = `conv_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const conversationDir = path.join(productHome, "conversations", conversationId);
  return {
    id: conversationId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "starting",
    title: data.title || "Untitled task",
    workspacePath: data.workspacePath,
    providerId: data.providerId,
    model: data.model,
    approvalPolicy: data.approvalPolicy,
    sandbox: data.sandbox,
    networkAccess: data.networkAccess,
    runtimeMode: data.runtimeMode,
    threadId: null,
    taskIds: [],
    conversationDir,
    artifactPath: path.join(conversationDir, "conversation.json"),
  };
}

function loadConversationFromDisk(productHome, conversationId) {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    return null;
  }
  const conversationDir = path.join(productHome, "conversations", conversationId);
  const artifactPath = path.join(conversationDir, "conversation.json");
  if (!fs.existsSync(artifactPath)) {
    return null;
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return {
    ...artifact,
    taskIds: Array.isArray(artifact.taskIds) ? artifact.taskIds : [],
    conversationDir,
    artifactPath,
  };
}

function listConversationsFromDisk(productHome) {
  const conversationsDir = path.join(productHome, "conversations");
  if (!fs.existsSync(conversationsDir)) {
    return [];
  }
  return fs
    .readdirSync(conversationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && CONVERSATION_ID_PATTERN.test(entry.name))
    .map((entry) => loadConversationFromDisk(productHome, entry.name))
    .filter(Boolean);
}

function summarizeConversation(conversation, productHome, liveTasks = new Map()) {
  const taskIds = conversation.taskIds ?? [];
  const lastTaskId = taskIds.at(-1);
  const lastTask = lastTaskId ? liveTasks.get(lastTaskId) ?? loadTaskFromDisk(productHome, lastTaskId) : null;
  const status = lastTask?.status === "completed"
    ? "active"
    : lastTask?.status === "failed" || lastTask?.status === "interrupted"
      ? lastTask.status
      : conversation.status;
  return {
    id: conversation.id,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    status,
    title: conversation.title || taskTitleFromTask(lastTask) || "Untitled task",
    workspacePath: conversation.workspacePath,
    provider: conversation.providerId,
    model: conversation.model,
    threadId: conversation.threadId,
    taskIds,
    lastTaskId,
    lastTaskStatus: lastTask?.status ?? null,
    finalMessage: lastTask?.finalMessage ?? null,
    error: errorMessage(lastTask?.error),
  };
}

function isFatalRuntimeLine(line) {
  return /fatal error|panicked at|in-flight tool future failed/i.test(String(line || ""));
}

function fatalRuntimeMessageFromLine(line) {
  const text = String(line || "").trim();
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.fields?.error || parsed?.fields?.message || parsed?.message;
    if (message) {
      return String(message);
    }
  } catch {
    // Non-JSON panic lines are already useful enough to show directly.
  }
  return text || "app-server runtime failed";
}

function loadTaskFromDisk(productHome, taskId) {
  if (!TASK_ID_PATTERN.test(taskId)) {
    return null;
  }
  const artifactPath = path.join(productHome, "tasks", taskId, "artifact.json");
  if (!fs.existsSync(artifactPath)) {
    return null;
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const normalized = normalizeLoadedArtifact(artifact);
  return {
    ...normalized,
    artifactPath,
    baselinePath: path.join(productHome, "tasks", taskId, "baseline.json"),
    events: normalized.events ?? [],
    subscribers: new Set(),
  };
}

function normalizeLoadedArtifact(artifact) {
  const normalizedError = errorMessage(artifact.error);
  const serverRequests = Array.isArray(artifact.serverRequests) ? artifact.serverRequests : [];
  if ((artifact.status === "starting" || artifact.status === "running") && !artifact.finishedAt) {
    return {
      ...artifact,
      finishedAt: artifact.finishedAt ?? new Date().toISOString(),
      status: "failed",
      error: normalizedError ?? "Task stopped because the agent server restarted before completion.",
      events: [
        ...(artifact.events ?? []),
        {
          id: `stale-${artifact.id}`,
          ts: new Date().toISOString(),
          type: "task.failed",
          params: {
            taskId: artifact.id,
            error: "Task stopped because the agent server restarted before completion.",
          },
        },
      ],
      serverRequests,
    };
  }
  return {
    ...artifact,
    error: normalizedError,
    serverRequests,
  };
}

function listTasksFromDisk(productHome) {
  const tasksDir = path.join(productHome, "tasks");
  if (!fs.existsSync(tasksDir)) {
    return [];
  }
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TASK_ID_PATTERN.test(entry.name))
    .map((entry) => loadTaskFromDisk(productHome, entry.name))
    .filter(Boolean);
}

function summarizeTask(task) {
  const request = task.request ?? {};
  return {
    id: task.id,
    conversationId: task.conversationId ?? request.conversationId ?? request.conversation_id ?? null,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    status: task.status,
    queuePosition: task.queuePosition ?? null,
    provider: task.resolvedProvider ?? task.providerId ?? task.provider,
    model: task.model,
    workspacePath: task.workspacePath,
    prompt: promptPreview(request),
    finalMessage: task.finalMessage,
    error: errorMessage(task.error),
  };
}

function promptPreview(request) {
  if (typeof request.prompt === "string" && request.prompt.trim()) {
    return request.prompt.trim().slice(0, 160);
  }
  const input = Array.isArray(request.input) ? request.input : [];
  for (const message of input) {
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.find((item) => item.type === "input_text")?.text;
    if (text) {
      return text.trim().slice(0, 160);
    }
  }
  return "Untitled task";
}

function taskTitleFromTask(task) {
  if (!task) {
    return null;
  }
  return String(task.prompt || task.request?.prompt || task.finalMessage || errorMessage(task.error) || "").trim() || null;
}

function diffForUntrackedFile(workspacePath, relativePath) {
  const absolutePath = path.resolve(workspacePath, relativePath);
  if (!absolutePath.startsWith(`${workspacePath}${path.sep}`)) {
    return null;
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    return null;
  }
  const content = fs.readFileSync(absolutePath);
  if (content.includes(0) || content.length > 100_000) {
    return [
      `diff --git a/${relativePath} b/${relativePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relativePath}`,
      "@@",
      "+[binary or large file omitted]",
      "",
    ].join("\n");
  }
  const text = content.toString("utf8");
  const lines = text.split(/\r?\n/);
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function captureGitBaseline(workspacePath) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: workspacePath,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) {
    return { ok: false, reason: result.error.message, entries: [] };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: result.stderr.trim() || `git status exited ${result.status}`,
      entries: [],
    };
  }
  return {
    ok: true,
    reason: null,
    entries: result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((raw) => {
        const body = raw.slice(3);
        return {
          raw,
          path: body.includes(" -> ") ? body.split(" -> ").at(-1) : body,
        };
      }),
  };
}

function loadGitBaseline(task, productHome) {
  const baselinePath = task.baselinePath ?? path.join(productHome, "tasks", task.id, "baseline.json");
  if (!baselinePath || !fs.existsSync(baselinePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
}

function loadWorkspaceBaseline(task) {
  const baselinePath = task.workspaceBaselinePath;
  if (!baselinePath || !fs.existsSync(baselinePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
}

function readJsonlTail(filePath, limit) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit);
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });
}

export function publicTaskArtifact(task) {
  const serverRequests = task.serverRequests instanceof Map
    ? [...task.serverRequests.values()].map(publicServerRequest)
    : (task.serverRequests ?? []).map(publicServerRequest);
  return {
    id: task.id,
    conversationId: task.conversationId ?? task.request?.conversationId ?? task.request?.conversation_id ?? null,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    status: task.status,
    queuePosition: task.queuePosition ?? null,
    runtimeMode: task.runtimeMode ?? task.request?.runtimeMode ?? task.request?.runtime_mode ?? null,
    provider: task.resolvedProvider ?? task.providerId ?? task.provider,
    model: task.resolvedModel ?? task.model,
    workspacePath: task.workspacePath,
    threadId: task.threadId,
    turnId: task.turnId,
    finalMessage: task.finalMessage,
    error: errorMessage(task.error),
    networkAccess: task.networkAccess,
    configPath: task.configPath,
    transcriptPath: task.transcriptPath,
    eventsPath: task.eventsPath,
    artifactPath: task.artifactPath,
    request: task.request,
    environmentDiagnostics: task.environmentDiagnostics ?? null,
    autoContinuationCount: task.autoContinuationCount ?? 0,
    maxAutoContinuations: task.maxAutoContinuations ?? DEFAULT_MAX_AUTO_CONTINUATIONS,
    expectedArtifacts: task.expectedArtifacts ?? null,
    completedArtifacts: task.completedArtifacts ?? [],
    missingArtifacts: task.missingArtifacts ?? [],
    completionVerification: task.completionVerification ?? null,
    events: task.events,
    serverRequests,
  };
}

export function publicConversationArtifact(conversation) {
  return {
    id: conversation.id,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    status: conversation.status,
    title: conversation.title,
    workspacePath: conversation.workspacePath,
    provider: conversation.providerId ?? conversation.provider,
    model: conversation.model,
    approvalPolicy: conversation.approvalPolicy,
    sandbox: conversation.sandbox,
    networkAccess: conversation.networkAccess,
    runtimeMode: conversation.runtimeMode,
    threadId: conversation.threadId,
    taskIds: conversation.taskIds ?? [],
    artifactPath: conversation.artifactPath,
  };
}

function publicServerRequest(request) {
  return {
    id: String(request.id),
    method: request.method,
    params: request.params ?? {},
    status: request.status ?? "pending",
    createdAt: request.createdAt ?? null,
    resolvedAt: request.resolvedAt ?? null,
    result: request.result ?? null,
  };
}

function serverRequestResult(serverRequest, body) {
  if (Object.hasOwn(body, "result")) {
    return body.result;
  }

  if (serverRequest.method === "item/commandExecution/requestApproval") {
    return { decision: normalizeDecision(body.decision ?? body.action ?? "accept", true) };
  }
  if (serverRequest.method === "item/fileChange/requestApproval") {
    return { decision: normalizeDecision(body.decision ?? body.action ?? "accept", false) };
  }
  if (serverRequest.method === "item/tool/requestUserInput") {
    return { answers: normalizeUserInputAnswers(body.answers ?? {}) };
  }
  if (serverRequest.method === "mcpServer/elicitation/request") {
    return {
      action: body.action ?? "decline",
      content: body.content ?? null,
      _meta: body._meta ?? null,
    };
  }
  if (serverRequest.method === "item/permissions/requestApproval") {
    const decision = body.decision ?? body.action ?? "accept";
    const accepted = decision !== "decline" && decision !== "cancel";
    return {
      permissions: accepted
        ? cloneJson(body.permissions ?? serverRequest.params?.permissions ?? {})
        : {},
      scope: normalizePermissionScope(body.scope ?? (decision === "acceptForSession" ? "session" : "turn")),
      strictAutoReview: body.strictAutoReview ?? body.strict_auto_review ?? null,
    };
  }

  throw new Error(`Server request ${serverRequest.method} requires a raw result payload`);
}

function normalizeDecision(decision, allowCommandOnlyDecisions) {
  if (typeof decision === "object" && decision) {
    return decision;
  }
  const normalized = String(decision || "accept");
  const allowed = allowCommandOnlyDecisions
    ? new Set(["accept", "acceptForSession", "decline", "cancel"])
    : new Set(["accept", "acceptForSession", "decline", "cancel"]);
  if (!allowed.has(normalized)) {
    throw new Error(`Unsupported approval decision: ${normalized}`);
  }
  return normalized;
}

function normalizeUserInputAnswers(answers) {
  const normalized = {};
  for (const [key, value] of Object.entries(answers ?? {})) {
    if (value && typeof value === "object" && Array.isArray(value.answers)) {
      normalized[key] = value;
    } else if (Array.isArray(value)) {
      normalized[key] = { answers: value.map(String) };
    } else if (value != null) {
      normalized[key] = { answers: [String(value)] };
    }
  }
  return normalized;
}

function normalizePermissionScope(scope) {
  const normalized = String(scope || "turn").toLowerCase();
  return normalized === "session" ? "session" : "turn";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function errorMessage(error) {
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error.message === "string") {
    return error.message;
  }
  if (error.error) {
    return errorMessage(error.error);
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isTerminalStatus(status) {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function writeSse(response, event) {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}
