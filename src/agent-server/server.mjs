#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_PRODUCT_HOME, PROJECT_ROOT } from "../runtime/paths.mjs";
import { loadDotEnvLocal } from "../runtime/env-file.mjs";
import { listProviders } from "../provider/registry.mjs";
import { TaskManager, isUnsafeWorkspacePath, publicConversationArtifact, publicTaskArtifact } from "./task-manager.mjs";

const WEB_ROOT = path.join(PROJECT_ROOT, "web");

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: Number.parseInt(process.env.INTERNAL_CODEX_PORT ?? "8765", 10),
    productHome: process.env.INTERNAL_CODEX_HOME ?? DEFAULT_PRODUCT_HOME,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      args.host = argv[++i];
    } else if (arg === "--port") {
      args.port = Number.parseInt(argv[++i], 10);
    } else if (arg === "--product-home") {
      args.productHome = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function createAgentServer({ productHome }) {
  const manager = new TaskManager({ productHome });

  return http.createServer(async (request, response) => {
    try {
      await route({ request, response, manager, productHome });
    } catch (error) {
      sendJson(response, statusForError(error), {
        error: error.message,
      });
    }
  });
}

async function route({ request, response, manager, productHome }) {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/health") {
    const defaultWorkspace = ensureDefaultWorkspace();
    sendJson(response, 200, {
      ok: true,
      productHome,
      projectRoot: PROJECT_ROOT,
      defaultWorkspace,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, { providers: listProviders() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/environment") {
    sendJson(response, 200, manager.getEnvironmentDiagnostics({
      workspacePath: url.searchParams.get("workspacePath") || undefined,
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/workspaces/select") {
    const body = await readJson(request);
    const selectedPath = await chooseWorkspaceFolder(isUnsafeWorkspacePath(body.defaultPath) ? undefined : body.defaultPath);
    sendJson(response, 200, { ok: true, path: selectedPath });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/tasks") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    sendJson(response, 200, { tasks: manager.listTasks({ limit }) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/conversations") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    sendJson(response, 200, { conversations: manager.listConversations({ limit }) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/tasks") {
    const body = await readJson(request);
    const task = await manager.startTask(body);
    sendJson(response, 202, {
      taskId: task.id,
      conversationId: task.conversationId,
      threadId: task.threadId,
      turnId: task.turnId,
      status: task.status,
      eventsUrl: `/v1/tasks/${task.id}/events`,
      artifactUrl: `/v1/tasks/${task.id}/artifact`,
    });
    return;
  }

  const conversationDetail = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
  if (request.method === "GET" && conversationDetail) {
    const conversation = manager.getConversation(conversationDetail[1]);
    if (!conversation) {
      sendJson(response, 404, { error: "Conversation not found" });
      return;
    }
    const tasks = (conversation.taskIds ?? [])
      .map((taskId) => manager.getTask(taskId))
      .filter(Boolean)
      .map(publicTaskArtifact);
    sendJson(response, 200, {
      ...publicConversationArtifact(conversation),
      tasks,
    });
    return;
  }

  const conversationTurn = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/turns$/);
  if (request.method === "POST" && conversationTurn) {
    const body = await readJson(request);
    const task = await manager.startTask({
      ...body,
      conversationId: conversationTurn[1],
    });
    sendJson(response, 202, {
      taskId: task.id,
      conversationId: task.conversationId,
      threadId: task.threadId,
      turnId: task.turnId,
      status: task.status,
      eventsUrl: `/v1/tasks/${task.id}/events`,
      artifactUrl: `/v1/tasks/${task.id}/artifact`,
    });
    return;
  }

  const taskEvents = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/events$/);
  if (request.method === "GET" && taskEvents) {
    if (!manager.subscribe(taskEvents[1], response)) {
      sendJson(response, 404, { error: "Task not found" });
    }
    return;
  }

  const taskArtifact = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/artifact$/);
  if (request.method === "GET" && taskArtifact) {
    const task = manager.getTask(taskArtifact[1]);
    if (!task) {
      sendJson(response, 404, { error: "Task not found" });
      return;
    }
    sendJson(response, 200, publicTaskArtifact(task));
    return;
  }

  const taskLogs = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/logs$/);
  if (request.method === "GET" && taskLogs) {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "400", 10);
    const logs = manager.getTaskLogs(taskLogs[1], { limit });
    if (!logs) {
      sendJson(response, 404, { error: "Task not found" });
      return;
    }
    sendJson(response, 200, logs);
    return;
  }

  const taskDetail = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
  if (request.method === "GET" && taskDetail) {
    const task = manager.getTask(taskDetail[1]);
    if (!task) {
      sendJson(response, 404, { error: "Task not found" });
      return;
    }
    sendJson(response, 200, publicTaskArtifact(task));
    return;
  }

  const taskDiff = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/diff$/);
  if (request.method === "GET" && taskDiff) {
    const diff = manager.getDiff(taskDiff[1]);
    if (!diff) {
      sendJson(response, 404, { error: "Task not found" });
      return;
    }
    sendJson(response, 200, diff);
    return;
  }

  const taskInterrupt = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/interrupt$/);
  if (request.method === "POST" && taskInterrupt) {
    await manager.interrupt(taskInterrupt[1]);
    sendJson(response, 202, { ok: true });
    return;
  }

  const taskServerRequest = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/server-requests\/([^/]+)\/resolve$/);
  if (request.method === "POST" && taskServerRequest) {
    const body = await readJson(request);
    const resolved = await manager.resolveServerRequest(taskServerRequest[1], taskServerRequest[2], body);
    sendJson(response, 202, { ok: true, request: resolved });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/files/view") {
    const file = resolveSafeResource({
      targetPath: url.searchParams.get("path"),
      workspacePath: url.searchParams.get("workspacePath"),
      productHome,
      requireFile: true,
    });
    const stat = fs.statSync(file.path);
    const contentType = contentTypeFor(file.path);
    const maxBytes = 1024 * 1024;
    sendJson(response, 200, {
      path: file.path,
      name: path.basename(file.path),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      contentType,
      truncated: stat.size > maxBytes,
      text: isTextContent(file.path, contentType)
        ? fs.readFileSync(file.path, "utf8").slice(0, maxBytes)
        : null,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/files/download") {
    const file = resolveSafeResource({
      targetPath: url.searchParams.get("path"),
      workspacePath: url.searchParams.get("workspacePath"),
      productHome,
      requireFile: true,
    });
    response.writeHead(200, {
      "content-type": contentTypeFor(file.path),
      "content-disposition": contentDisposition(path.basename(file.path)),
      "cache-control": "no-cache",
    });
    fs.createReadStream(file.path).pipe(response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/files/open") {
    const body = await readJson(request);
    const file = resolveSafeResource({
      targetPath: body.path,
      workspacePath: body.workspacePath,
      productHome,
      requireFile: false,
    });
    await openNativePath(file.path, { reveal: false });
    sendJson(response, 202, { ok: true, path: file.path });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/files/reveal") {
    const body = await readJson(request);
    const file = resolveSafeResource({
      targetPath: body.path,
      workspacePath: body.workspacePath,
      productHome,
      requireFile: false,
    });
    await openNativePath(file.path, { reveal: true });
    sendJson(response, 202, { ok: true, path: file.path });
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    if (serveStatic(request, response, url.pathname)) {
      return;
    }
  }

  sendJson(response, 404, { error: "Not found" });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON request body: ${error.message}`));
      }
    });
    request.on("error", reject);
  });
}

function resolveSafeResource({ targetPath, workspacePath, productHome, requireFile }) {
  if (!targetPath || typeof targetPath !== "string") {
    throw httpError(400, "file path is required");
  }
  const basePath = workspacePath && typeof workspacePath === "string"
    ? path.resolve(workspacePath)
    : PROJECT_ROOT;
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(basePath, targetPath);
  const roots = [PROJECT_ROOT, productHome];
  if (workspacePath && fs.existsSync(basePath)) {
    roots.push(basePath);
  }
  const allowed = roots.some((root) => isPathInside(resolved, path.resolve(root)));
  if (!allowed) {
    throw httpError(403, `file is outside allowed roots: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) {
    throw httpError(404, `file not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (requireFile && !stat.isFile()) {
    throw httpError(400, `path is not a file: ${resolved}`);
  }
  return { path: resolved, stat };
}

function isPathInside(targetPath, rootPath) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

function isTextContent(filePath, contentType) {
  if (contentType.startsWith("text/") || contentType.includes("json")) {
    return true;
  }
  return [".md", ".markdown", ".jsonl", ".csv", ".tsv", ".log"].includes(path.extname(filePath).toLowerCase());
}

function contentDisposition(filename) {
  const fallback = filename.replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function chooseWorkspaceFolder(defaultPath) {
  const platform = process.platform;
  const startingPath = typeof defaultPath === "string" && fs.existsSync(defaultPath)
    ? path.resolve(defaultPath)
    : undefined;

  if (platform === "darwin") {
    const args = startingPath
      ? [
          "-e",
          `set defaultLocation to POSIX file "${appleScriptString(startingPath)}"`,
          "-e",
          `POSIX path of (choose folder with prompt "选择 CodePilot 工作区" default location defaultLocation)`,
        ]
      : ["-e", `POSIX path of (choose folder with prompt "选择 CodePilot 工作区")`];
    return runPickerCommand("osascript", args);
  }

  if (platform === "win32") {
    const commands = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '选择 CodePilot 工作区'",
      startingPath ? `$dialog.SelectedPath = '${powershellSingleQuoted(startingPath)}'` : "",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) } else { exit 3 }",
    ].filter(Boolean);
    return runPickerCommand("powershell.exe", ["-NoProfile", "-Command", commands.join("; ")]);
  }

  if (platform === "linux") {
    const args = ["--file-selection", "--directory", "--title", "选择 CodePilot 工作区"];
    if (startingPath) {
      args.push("--filename", `${startingPath}${path.sep}`);
    }
    return runPickerCommand("zenity", args);
  }

  throw httpError(501, `folder picker is unsupported on ${platform}`);
}

function runPickerCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      reject(httpError(500, `failed to open workspace picker: ${error.message}`));
    });
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0 && output) {
        resolve(output);
      } else if (code === 1 || code === 3 || /cancel/i.test(detail)) {
        reject(httpError(400, "已取消选择工作区"));
      } else {
        reject(httpError(500, `workspace picker exited with ${code}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

function ensureDefaultWorkspace() {
  const workspacePath = path.join(os.homedir(), "Documents", "CodePilot Workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function powershellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function openNativePath(targetPath, { reveal }) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === "darwin") {
    command = "open";
    args = reveal ? ["-R", targetPath] : [targetPath];
  } else if (platform === "win32") {
    command = "explorer.exe";
    args = reveal ? ["/select,", targetPath] : [targetPath];
  } else {
    command = "xdg-open";
    args = [reveal ? path.dirname(targetPath) : targetPath];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", (error) => reject(httpError(500, `failed to open file: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(httpError(500, `open command exited with ${code}`));
      }
    });
  });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function serveStatic(request, response, urlPathname) {
  const pathname = urlPathname === "/" ? "/index.html" : urlPathname;
  const resolved = path.resolve(WEB_ROOT, `.${decodeURIComponent(pathname)}`);
  if (!resolved.startsWith(`${WEB_ROOT}${path.sep}`) && resolved !== path.join(WEB_ROOT, "index.html")) {
    return false;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return false;
  }
  response.writeHead(200, {
    "content-type": contentTypeFor(resolved),
    "cache-control": "no-cache",
  });
  if (request.method === "HEAD") {
    response.end();
  } else {
    fs.createReadStream(resolved).pipe(response);
  }
  return true;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }
  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }
  if (ext === ".js") {
    return "text/javascript; charset=utf-8";
  }
  if (ext === ".json") {
    return "application/json; charset=utf-8";
  }
  if (ext === ".md" || ext === ".markdown") {
    return "text/markdown; charset=utf-8";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".svg") {
    return "image/svg+xml; charset=utf-8";
  }
  if ([".txt", ".log", ".jsonl", ".csv", ".tsv"].includes(ext)) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function statusForError(error) {
  if (Number.isInteger(error.statusCode)) {
    return error.statusCode;
  }
  if (/not found|unknown provider|workspacePath does not exist/i.test(error.message)) {
    return 404;
  }
  if (/must include|unsupported|invalid json/i.test(error.message)) {
    return 400;
  }
  return 500;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.productHome, { recursive: true });
  loadDotEnvLocal(path.join(args.productHome, ".env.local"));
  loadDotEnvLocal();
  const server = await createAgentServer({ productHome: args.productHome });
  server.listen(args.port, args.host, () => {
    const address = server.address();
    console.log(
      JSON.stringify({
        ok: true,
        url: `http://${address.address}:${address.port}`,
        productHome: args.productHome,
      }),
    );
  });
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  const entryPath = path.resolve(process.argv[1]);
  if (entryPath === modulePath) {
    return true;
  }
  try {
    return fs.realpathSync(entryPath) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}
