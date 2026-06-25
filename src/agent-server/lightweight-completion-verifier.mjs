import fs from "node:fs";
import path from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
]);

const LARK_DOC_URL_PATTERN = /https:\/\/[^\s"'<>)]*larkoffice\.com\/docx\/[A-Za-z0-9_-]+/g;

export function expectedArtifactsFromRequest(request = {}) {
  const prompt = promptTextFromRequest(request);
  const normalized = prompt.toLowerCase();
  const artifacts = [];
  const wantsHtml = /html|网页|页面|小游戏|静态网页/.test(normalized);
  const wantsMarkdown = /\bmd\b|markdown|\.md\b|md文件|说明文档|本地文档/.test(normalized);
  const wantsLarkDoc = /飞书文档|lark\s*doc|larkoffice|docx/.test(normalized);
  const wantsCodeChange = !wantsHtml && !wantsMarkdown && /\bbug\b|修改|修复|开发|实现|改代码|代码变更/.test(normalized);

  if (wantsHtml) {
    artifacts.push({
      kind: "html",
      type: "local_file",
      required: true,
      extensions: [".html", ".htm"],
      description: "HTML / webpage artifact",
    });
  }
  if (wantsMarkdown) {
    artifacts.push({
      kind: "markdown",
      type: "local_file",
      required: true,
      extensions: [".md"],
      description: "Markdown artifact",
    });
  }
  if (wantsLarkDoc) {
    artifacts.push({
      kind: "lark_doc",
      type: "external_link",
      required: true,
      description: "Verified Lark document URL from tool output",
    });
  }
  if (wantsCodeChange) {
    artifacts.push({
      kind: "code_change",
      type: "workspace_change",
      required: true,
      description: "Workspace file change or git diff",
    });
  }

  return {
    prompt,
    artifacts: artifacts.length
      ? artifacts
      : [{ kind: "text_answer", type: "text", required: true, description: "Text answer" }],
  };
}

export function captureWorkspaceSnapshot(workspacePath) {
  const files = new Map();
  walkWorkspace(workspacePath, workspacePath, files);
  return {
    capturedAt: new Date().toISOString(),
    workspacePath,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function verifyTaskCompletion(task, { baseline = null } = {}) {
  const expected = task.expectedArtifacts?.artifacts ?? [];
  const workspacePath = task.workspacePath;
  const before = baseline ?? task.workspaceBaseline ?? { files: [] };
  const after = fs.existsSync(workspacePath) ? captureWorkspaceSnapshot(workspacePath) : { files: [] };
  const changes = changedFiles(before, after);
  const completedArtifacts = [];
  const missingArtifacts = [];
  const unrecoverableErrors = unrecoverableErrorsFromTask(task);

  for (const artifact of expected) {
    if (artifact.kind === "text_answer") {
      const finalText = finalTextFromTaskEvents(task);
      if (finalText) {
        completedArtifacts.push({ ...artifact, textPreview: finalText.slice(0, 200) });
      } else {
        missingArtifacts.push({ ...artifact, reason: "未找到最终文本回答" });
      }
      continue;
    }

    if (artifact.kind === "html" || artifact.kind === "markdown") {
      const matched = changes.filter((file) =>
        artifact.extensions?.includes(path.extname(file.path).toLowerCase()) &&
        file.size > 20 &&
        !isUnsafeArtifactPath(workspacePath, file.path)
      );
      if (matched.length) {
        completedArtifacts.push(...matched.map((file) => ({
          ...artifact,
          path: path.join(workspacePath, file.path),
          relativePath: file.path,
          sizeBytes: file.size,
          source: "workspace_scan",
        })));
      } else {
        missingArtifacts.push({
          ...artifact,
          reason: `未找到任务期间新增或修改的 ${artifact.extensions?.join(" / ")} 文件`,
        });
      }
      continue;
    }

    if (artifact.kind === "lark_doc") {
      const urls = verifiedLarkDocUrlsFromEvents(task.events ?? []);
      if (urls.length) {
        completedArtifacts.push(...urls.map((url) => ({
          ...artifact,
          url,
          source: "tool_output",
        })));
      } else {
        missingArtifacts.push({
          ...artifact,
          reason: "未找到飞书工具成功输出的 docx 链接",
          unverifiedUrls: unverifiedLarkDocUrlsFromEvents(task.events ?? []),
        });
      }
      continue;
    }

    if (artifact.kind === "code_change") {
      if (changes.length || hasDiffEvent(task.events ?? [])) {
        completedArtifacts.push({
          ...artifact,
          source: changes.length ? "workspace_scan" : "turn.diff.updated",
          changedFiles: changes.map((file) => file.path).slice(0, 50),
        });
      } else {
        missingArtifacts.push({
          ...artifact,
          reason: "未检测到 workspace 文件变更或 git diff",
        });
      }
    }
  }

  const passed = missingArtifacts.length === 0 && unrecoverableErrors.length === 0;
  return {
    status: passed ? "passed" : unrecoverableErrors.length ? "unrecoverable_failed" : "recoverable_failed",
    ok: passed,
    reason: passed ? null : reasonFromMissing({ missingArtifacts, unrecoverableErrors }),
    expectedArtifacts: expected,
    completedArtifacts,
    missingArtifacts,
    unrecoverableErrors,
    changedFiles: changes,
  };
}

function promptTextFromRequest(request) {
  if (typeof request.prompt === "string") {
    return request.prompt;
  }
  const normalizedInput = Array.isArray(request.input) ? request.input : [];
  return normalizedInput
    .flatMap((message) => Array.isArray(message?.content) ? message.content : [])
    .map((part) => part?.text || part?.input_text || "")
    .filter(Boolean)
    .join("\n");
}

function walkWorkspace(root, currentPath, files) {
  if (!fs.existsSync(currentPath)) {
    return;
  }
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    if (entry.isDirectory() && DEFAULT_IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(root, fullPath);
    if (entry.isDirectory()) {
      walkWorkspace(root, fullPath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    try {
      const stat = fs.statSync(fullPath);
      files.set(relativePath, {
        path: relativePath,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
      });
    } catch {
      // Ignore files that disappear during scanning.
    }
  }
}

function changedFiles(before, after) {
  const beforeMap = new Map((before.files ?? []).map((file) => [file.path, file]));
  return (after.files ?? []).filter((file) => {
    const prior = beforeMap.get(file.path);
    return !prior || prior.size !== file.size || prior.mtimeMs !== file.mtimeMs;
  });
}

function isUnsafeArtifactPath(workspacePath, relativePath) {
  const absolutePath = path.resolve(workspacePath, relativePath);
  const workspaceRoot = path.resolve(workspacePath);
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    return true;
  }
  return absolutePath.includes(`${path.sep}.app${path.sep}Contents${path.sep}Resources${path.sep}`);
}

function verifiedLarkDocUrlsFromEvents(events) {
  return uniqueStrings(events.flatMap((event) => {
    const item = event.params?.item;
    if (event.type !== "item.completed" || !item || item.type === "agentMessage" || item.type === "userMessage" || item.error) {
      return [];
    }
    const text = [
      item.text,
      item.output,
      item.aggregatedOutput,
      item.result,
      item.command,
      item.commandActions,
    ].map((value) => typeof value === "string" ? value : JSON.stringify(value ?? "")).join("\n");
    if (!/lark-cli|lark|飞书|docx/i.test(text)) {
      return [];
    }
    return text.match(LARK_DOC_URL_PATTERN) ?? [];
  }));
}

function unverifiedLarkDocUrlsFromEvents(events) {
  return uniqueStrings(events.flatMap((event) => {
    const item = event.params?.item;
    if (item?.type !== "agentMessage") {
      return [];
    }
    return String(item.text || "").match(LARK_DOC_URL_PATTERN) ?? [];
  }));
}

function finalTextFromTaskEvents(task) {
  const messages = (task.events ?? [])
    .filter((event) => event.type === "item.completed")
    .map((event) => event.params?.item)
    .filter((item) => item?.type === "agentMessage" && typeof item.text === "string");
  return messages.at(-1)?.text?.trim() || task.finalMessage || "";
}

function hasDiffEvent(events) {
  return events.some((event) => event.type === "turn.diff.updated");
}

function unrecoverableErrorsFromTask(task) {
  const text = unrecoverableEvidenceText(task);
  const errors = [];
  if (/MODELHUB_AK is not set|provider_auth_error|unauthori[sz]ed|forbidden|鉴权|认证失败/i.test(text)) {
    errors.push({ code: "auth_error", message: "认证或 API key 错误" });
  }
  if (/provider_resource_exhausted|资源池资源不足|资源不足|rate limit|限流|-4302/i.test(text)) {
    errors.push({ code: "provider_resource_exhausted", message: "模型资源池不足或限流" });
  }
  if (/not writable|permission denied|EACCES|workspacePath does not exist|无法写入/i.test(text)) {
    errors.push({ code: "workspace_unavailable", message: "workspace 不可写或不可用" });
  }
  if (/lark.*auth|飞书.*认证|not logged in|login required/i.test(text)) {
    errors.push({ code: "lark_auth_error", message: "飞书认证失败" });
  }
  return errors;
}

function unrecoverableEvidenceText(task) {
  const chunks = [];
  if (task.error) {
    chunks.push(String(task.error));
  }
  for (const event of task.events ?? []) {
    if (event.type === "runtime.error") {
      chunks.push(JSON.stringify(event.params ?? {}));
      continue;
    }
    if (event.type !== "item.completed") {
      continue;
    }
    const item = event.params?.item;
    if (!item) {
      continue;
    }
    if (item.error) {
      chunks.push(JSON.stringify(item.error));
    }
    if (item.type === "commandExecution") {
      const exitCode = Number(item.exitCode ?? item.exit_code ?? 0);
      if (exitCode !== 0) {
        chunks.push([
          item.command,
          item.aggregatedOutput,
          item.stderr,
          item.error,
        ].map((value) => typeof value === "string" ? value : JSON.stringify(value ?? "")).join("\n"));
      }
    }
  }
  return chunks.filter(Boolean).join("\n");
}

function reasonFromMissing({ missingArtifacts, unrecoverableErrors }) {
  if (unrecoverableErrors.length) {
    return unrecoverableErrors.map((error) => error.message).join("；");
  }
  if (missingArtifacts.length) {
    return `缺少交付物：${missingArtifacts.map((item) => item.kind).join("、")}`;
  }
  return "任务未通过完成校验";
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}
