#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_URL = process.env.CODEPILOT_BASE_URL || "http://127.0.0.1:8765";
const PROVIDER = process.env.CODEPILOT_PROVIDER || "modelhub-gpt55";
const MODEL = process.env.CODEPILOT_MODEL || "gpt-5.5-2026-04-24";
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const RUN_ROOT = path.join(os.tmpdir(), `codepilot-real-task-suite-${RUN_ID}`);
const SCREENSHOT_PATH = "/var/folders/4n/_77n1cjn05d6q4q118wx_jtc0000gn/T/codex-clipboard-1b79042c-5be0-4501-ba67-ecd2e6aee51e.png";

fs.mkdirSync(RUN_ROOT, { recursive: true });

const commonInstruction = [
  "你正在被用于 CodePilot 真实能力测试。",
  "请直接执行任务，不要向用户追问。",
  "如果遇到认证、权限、网络、CLI 缺失或接口失败，请停止无效重试，明确记录失败原因。",
  "不要编造已经创建成功的链接、文件或数据。",
  "最终请用简短结构输出：状态、产物/链接、本地文件、关键过程、错误或风险。",
].join("\n");

const tasks = [
  {
    id: "lark_sheet_dashboard",
    title: "飞书表格自动生成数据看板",
    prompt: [
      "帮我创建一个飞书电子表格，标题用“CodePilot自动测试-任务数据看板-${RUN_ID}”。",
      "里面放 30 条 CodePilot 任务测试记录，字段包括任务名、类型、耗时、是否成功、失败原因、使用工具。",
      "再新增一个汇总 sheet，统计成功率、平均耗时、各类型任务数量。",
      "最后把表格链接发我。",
    ].join("\n"),
  },
  {
    id: "lark_task_subtasks",
    title: "创建飞书任务并拆子任务",
    prompt: [
      "帮我创建一个飞书任务，标题是“CodePilot自动测试-M3验收-${RUN_ID}”。",
      "下面拆 6 个子任务：模型调用、工具调用、文件修改、历史记录、前端交互、错误恢复。",
      "每个子任务写一句验收标准。",
      "创建完成后返回任务链接或任务关键信息。",
    ].join("\n"),
  },
  {
    id: "ui_screenshot_review",
    title: "读截图并生成 UI 问题清单",
    prompt: [
      fs.existsSync(SCREENSHOT_PATH)
        ? `请查看这张本地前端截图：${SCREENSHOT_PATH}`
        : "请基于当前 CodePilot 前端交互形态做一次 UI 走查。",
      "识别页面里的交互问题、文案问题、布局问题。",
      "在当前 workspace 生成 ui_review.json，数组字段包括 severity、area、problem、suggestion。",
      "最后总结最值得优先修复的 3 个问题。",
    ].join("\n"),
  },
  {
    id: "long_progress_tracking",
    title: "本地长任务实时跟踪",
    prompt: [
      "在当前 workspace 创建一个脚本 progress_task.js，模拟 10 秒任务进度输出，每秒打印一次进度。",
      "然后运行它，持续轮询直到结束。",
      "最后总结输出内容，并保留脚本文件。",
    ].join("\n"),
  },
  {
    id: "failing_test_fix",
    title: "故意制造测试失败再修复",
    prompt: [
      "在当前 workspace 创建一个很小的 JS 函数和测试文件。",
      "先让测试失败并运行一次确认失败。",
      "然后修复函数，再跑测试直到通过。",
      "最后告诉我失败原因和修复点。",
    ].join("\n"),
  },
  {
    id: "git_audit_change",
    title: "使用 Git 做一次可审计变更",
    prompt: [
      "在当前临时 workspace 初始化 git。",
      "创建一个文件并提交一次。",
      "然后修改该文件，再生成 diff，总结这次变更。",
      "不要自动提交第二次修改。",
    ].join("\n"),
  },
  {
    id: "csv_to_lark_sheet_backup",
    title: "CSV 到飞书表格再本地备份",
    prompt: [
      "生成一个本地 CSV，内容是 20 条模型调用成本记录，字段包括 date、model、input_tokens、output_tokens、cost、task_type。",
      "再把它导入或写入飞书表格，标题用“CodePilot自动测试-模型成本-${RUN_ID}”。",
      "最后在本地生成 cost_report.md 汇总报告，并返回飞书表格链接和本地报告路径。",
    ].join("\n"),
  },
  {
    id: "calendar_free_time",
    title: "查询日历空闲时间但不创建会议",
    prompt: [
      "帮我查看 2026-06-23 上午 09:00 到 12:00 的日历空闲时间。",
      "找出 3 个适合开 30 分钟 CodePilot 评审会的时间段。",
      "只查询，不创建会议。",
    ].join("\n"),
  },
  {
    id: "lark_base_case_library",
    title: "创建飞书多维表格测试库",
    prompt: [
      "帮我创建一个飞书多维表格，名字叫“CodePilot自动测试-测试用例库-${RUN_ID}”。",
      "字段包括用例名、模块、优先级、状态、负责人、最近运行时间。",
      "写入 10 条样例用例，并返回链接。",
    ].join("\n"),
  },
  {
    id: "mcp_resources_read",
    title: "MCP resources 读取测试",
    prompt: [
      "查看当前可用的 MCP resources。",
      "挑一个和当前 runtime 或 workspace 相关的资源读出来，解释它是什么。",
      "如果没有可用资源，也要说明为空，并在当前 workspace 生成 mcp_resources_report.md 记录过程。",
    ].join("\n"),
  },
];

const results = [];

console.log(JSON.stringify({
  event: "suite.started",
  runId: RUN_ID,
  runRoot: RUN_ROOT,
  baseUrl: BASE_URL,
  provider: PROVIDER,
  model: MODEL,
  taskCount: tasks.length,
}, null, 2));

for (const [index, task] of tasks.entries()) {
  const workspacePath = path.join(RUN_ROOT, task.id);
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "README.md"), `# ${task.title}\n\nRun ${RUN_ID}\n`);
  const startedAt = Date.now();
  console.log(JSON.stringify({
    event: "task.started",
    index: index + 1,
    total: tasks.length,
    id: task.id,
    title: task.title,
    workspacePath,
  }));

  try {
    const artifact = await runCodePilotTask({
      workspacePath,
      prompt: `${commonInstruction}\n\n任务：\n${interpolateRunId(task.prompt)}`,
      timeoutMs: 360_000,
    });
    const result = summarizeArtifact(task, artifact, workspacePath, startedAt);
    results.push(result);
    console.log(JSON.stringify({
      event: "task.finished",
      id: task.id,
      status: result.status,
      elapsedMs: result.elapsedMs,
      finalPreview: result.finalPreview,
      error: result.error,
      usedTools: result.usedTools,
    }));
  } catch (error) {
    const result = {
      id: task.id,
      title: task.title,
      workspacePath,
      status: "runner_failed",
      elapsedMs: Date.now() - startedAt,
      error: error.message,
      finalMessage: null,
      finalPreview: null,
      usedTools: [],
      eventTypes: [],
      files: listWorkspaceFiles(workspacePath),
    };
    results.push(result);
    console.log(JSON.stringify({
      event: "task.runner_failed",
      id: task.id,
      error: error.message,
    }));
  }
}

const summary = {
  runId: RUN_ID,
  runRoot: RUN_ROOT,
  baseUrl: BASE_URL,
  provider: PROVIDER,
  model: MODEL,
  totals: {
    tasks: results.length,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status !== "completed").length,
  },
  results,
};

const summaryJsonPath = path.join(RUN_ROOT, "summary.json");
const summaryMdPath = path.join(RUN_ROOT, "summary.md");
fs.writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(summaryMdPath, renderMarkdownSummary(summary));

console.log(JSON.stringify({
  event: "suite.finished",
  ok: summary.totals.failed === 0,
  summaryJsonPath,
  summaryMdPath,
  totals: summary.totals,
}, null, 2));

if (summary.totals.failed > 0) {
  process.exitCode = 1;
}

async function runCodePilotTask({ workspacePath, prompt, timeoutMs }) {
  const createResponse = await fetch(`${BASE_URL}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspacePath,
      provider: PROVIDER,
      model: MODEL,
      prompt,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      networkAccess: true,
    }),
  });
  const created = await createResponse.json();
  if (!createResponse.ok) {
    throw new Error(`create failed: ${JSON.stringify(created)}`);
  }

  const deadline = Date.now() + timeoutMs;
  let artifact = null;
  while (Date.now() < deadline) {
    const artifactResponse = await fetch(`${BASE_URL}${created.artifactUrl}`);
    artifact = await artifactResponse.json();
    if (["completed", "failed", "interrupted"].includes(artifact.status)) {
      return artifact;
    }
    await delay(3000);
  }
  throw new Error(`timeout waiting for task ${created.taskId}`);
}

function summarizeArtifact(task, artifact, workspacePath, startedAt) {
  const events = Array.isArray(artifact.events) ? artifact.events : [];
  return {
    id: task.id,
    title: task.title,
    workspacePath,
    taskId: artifact.id,
    conversationId: artifact.conversationId,
    threadId: artifact.threadId,
    status: artifact.status,
    elapsedMs: Date.now() - startedAt,
    finalMessage: artifact.finalMessage ?? null,
    finalPreview: preview(artifact.finalMessage),
    error: errorText(artifact.error),
    usedTools: [...new Set(events
      .map((event) => event.params?.item?.type)
      .filter((type) => type && type !== "userMessage" && type !== "agentMessage"))],
    eventTypes: [...new Set(events.map((event) => event.type))],
    fileChangePaths: [...new Set(events
      .flatMap((event) => event.params?.item?.changes ?? [])
      .map((change) => change.path)
      .filter(Boolean))],
    files: listWorkspaceFiles(workspacePath),
  };
}

function listWorkspaceFiles(workspacePath) {
  const files = [];
  walk(workspacePath, files, workspacePath);
  return files.slice(0, 80);
}

function walk(currentPath, files, root) {
  if (!fs.existsSync(currentPath)) return;
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files, root);
    } else if (entry.isFile()) {
      files.push(path.relative(root, fullPath));
    }
  }
}

function renderMarkdownSummary(summary) {
  const lines = [
    `# CodePilot Real Task Suite ${summary.runId}`,
    "",
    `- Run root: \`${summary.runRoot}\``,
    `- Provider: \`${summary.provider}\``,
    `- Model: \`${summary.model}\``,
    `- Completed: ${summary.totals.completed}/${summary.totals.tasks}`,
    "",
    "| Task | Status | Tools | Final / Error |",
    "| --- | --- | --- | --- |",
  ];
  for (const result of summary.results) {
    const text = result.status === "completed"
      ? (result.finalPreview || "")
      : (result.error || result.finalPreview || "");
    lines.push(`| ${result.id} | ${result.status} | ${result.usedTools.join(", ") || "-"} | ${escapeTable(text)} |`);
  }
  lines.push("");
  for (const result of summary.results) {
    lines.push(`## ${result.id}`);
    lines.push("");
    lines.push(`- Title: ${result.title}`);
    lines.push(`- Workspace: \`${result.workspacePath}\``);
    lines.push(`- Status: ${result.status}`);
    lines.push(`- Tools: ${result.usedTools.join(", ") || "-"}`);
    if (result.finalMessage) {
      lines.push(`- Final: ${result.finalMessage.replace(/\n/g, " ").slice(0, 1000)}`);
    }
    if (result.error) {
      lines.push(`- Error: ${result.error}`);
    }
    if (result.files.length) {
      lines.push(`- Files: ${result.files.map((file) => `\`${file}\``).join(", ")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function interpolateRunId(text) {
  return text.replaceAll("${RUN_ID}", RUN_ID);
}

function preview(value) {
  if (!value) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, 220);
}

function errorText(error) {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function escapeTable(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 260);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
