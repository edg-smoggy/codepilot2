#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadDotEnvLocal } from "../src/runtime/env-file.mjs";

loadDotEnvLocal();

const BASE_URL = process.env.CODEPILOT_BASE_URL || "http://127.0.0.1:8765";
const PROVIDER = process.env.CODEPILOT_PROVIDER || "ark";
const MODEL = process.env.CODEPILOT_MODEL || process.env.ARK_MODEL || "ep-20260427114346-pfqwk";
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const RUN_ROOT = path.join(os.tmpdir(), `codepilot-complex-user-${RUN_ID}`);
const WORKSPACE = path.join(RUN_ROOT, "workspace");
const REPORT_JSON = path.join(RUN_ROOT, "complex-user-regression.json");
const REPORT_MD = path.join(RUN_ROOT, "complex-user-regression.md");

const commonPrefix = [
  "你正在被用于 CodePilot 复杂用户回归测试。",
  "请像真实 Codex agent 一样直接执行任务，不要编造结果。",
  "如果工具、网络、飞书、权限或命令失败，请明确记录失败原因并停止无效重试。",
  "最终回答要简洁，包含状态、产物路径/链接、关键动作、错误或风险。",
].join("\n");

const turns = [
  {
    id: "workspace_readonly",
    prompt: "你好，先确认一下你现在在哪个 workspace，能不能读取当前目录。不要改文件，只告诉我你看到的项目大概是什么。",
  },
  {
    id: "healthcheck_report",
    prompt: [
      "帮我做一个完整巡检：读取项目结构，找一个最小可修的问题；如果有测试就跑测试，没有就自己写一个最小 smoke；",
      "最后生成 `outputs/healthcheck_report.md`，里面要包含：项目概览、你运行过的命令、发现的问题、修改了哪些文件、后续建议。",
    ].join(""),
  },
  {
    id: "interrupt_running_task",
    prompt: "请做一个较慢的巡检任务：先每秒输出一次进度，持续 20 秒，然后继续检查项目并更新 `outputs/healthcheck_report.md`。",
    interruptAfterMs: 5000,
    timeoutMs: 90000,
  },
  {
    id: "resume_after_interrupt",
    prompt: "刚才我中断了，你继续完成上一个巡检任务。不要从头瞎猜，先检查当前已经生成了哪些文件和 git diff，然后接着做。",
  },
  {
    id: "html_dashboard",
    prompt: [
      "把刚才的 Markdown 报告再生成一个可打开的 HTML 看板，文件名叫 `outputs/healthcheck_dashboard.html`。",
      "页面要能直接本地打开，包含状态卡片、命令记录、文件变更、风险项。",
    ].join(""),
  },
  {
    id: "lark_doc_healthcheck",
    prompt: [
      "你再创建一个飞书文档，把这次巡检结论写进去。",
      "文档标题用“CodePilot 巡检回归测试 - complex-user-workspace - 2026-06-22”。创建成功后必须返回可点击链接。",
    ].join(""),
  },
  {
    id: "link_check",
    prompt: "我点不开链接，你检查一下你刚才返回的是不是标准 URL。如果不是，重新输出一个完整可点击链接；如果创建失败，就明确说明失败原因，不要编。",
  },
  {
    id: "git_diff_audit",
    prompt: "现在请只看 git diff，告诉我哪些变更是你这次任务产生的，哪些可能是任务前已有的。不要接受或回滚任何变更。",
  },
  {
    id: "report_rewrite",
    prompt: [
      "帮我把 `outputs/healthcheck_report.md` 里的“后续建议”改成更适合给研发负责人看的版本，语气简洁、结论明确。",
      "改完后展示这一个文件的 diff 摘要。",
    ].join(""),
  },
  {
    id: "history_recovery",
    before: async (ctx) => {
      ctx.historyBeforeTurn = await apiJson(`/v1/conversations/${encodeURIComponent(ctx.conversationId)}`);
    },
    prompt: "我刷新了一下页面，然后从历史记录点回这个会话。你还记得刚才做到哪一步了吗？请基于历史和文件状态回答，不要重新执行重任务。",
  },
  {
    id: "expected_failure_record",
    prompt: [
      "现在故意跑一个可能失败的命令：尝试读取一个不存在的文件 `not_exists_12345.md`，",
      "然后把失败原因写进报告的“异常处理验证”一节。要求失败要被正确记录，不要让整个任务看起来假成功。",
    ].join(""),
  },
  {
    id: "phase_one_summary",
    prompt: [
      "请给我一个阶段一交付总结，包含：状态、本地产物路径、飞书链接、实际执行过的关键命令、修改文件列表、失败/风险、我下一步应该点哪里查看或打开产物。",
    ].join(""),
  },
  {
    id: "big_project_spec",
    prompt: [
      "现在基于当前 workspace，新建一个小型但完整的前端项目，名字叫 `dev-weekly-console`。",
      "目标是做一个“研发周报控制台”：可以录入项目、负责人、本周进展、风险、下周计划，并在页面里展示汇总看板。",
      "先不要写代码，先生成 `dev-weekly-console/SPEC.md`，写清楚功能范围、页面结构、数据结构、验收标准。",
    ].join(""),
  },
  {
    id: "big_project_v1",
    timeoutMs: 300000,
    prompt: [
      "按照刚才的 SPEC 开始实现第一版。要求：",
      "用原生 HTML/CSS/JS，不引入远程依赖；入口文件是 `dev-weekly-console/index.html`；数据可以存在 localStorage；",
      "页面至少包含：项目列表、周报录入表单、风险列表、下周计划、汇总统计；样式要像一个内部工作台，不要像营销页。",
    ].join(""),
  },
  {
    id: "big_project_qa",
    prompt: [
      "运行一个本地验证：检查 `dev-weekly-console/index.html` 是否存在，检查页面里是否包含项目列表、风险、下周计划、统计这些关键区域。",
      "如果能用 Playwright 或浏览器检查更好；不行就用命令行静态检查。把验证结果写进 `dev-weekly-console/QA.md`。",
    ].join(""),
  },
  {
    id: "big_project_enhance",
    timeoutMs: 300000,
    prompt: [
      "我觉得这个系统还不够像真实产品。继续增强：",
      "增加筛选：按负责人、风险等级、项目状态筛选；增加示例数据；增加“导出 Markdown 周报”按钮；",
      "增加“清空数据”二次确认；移动端也要能用。",
    ].join(""),
  },
  {
    id: "big_project_product_qa",
    timeoutMs: 240000,
    prompt: [
      "再做一次质量检查：从产品角度检查 UI、交互、空状态、错误提示、移动端布局、数据持久化。",
      "发现问题就直接修。最后更新 `dev-weekly-console/QA.md`，记录你修了什么。",
    ].join(""),
  },
  {
    id: "lark_doc_big_project",
    prompt: [
      "现在帮我创建一份飞书文档，标题叫“研发周报控制台第一版验收说明”。",
      "内容包括：产品目标、核心功能、文件路径、如何本地打开、已知限制、后续迭代建议。返回可点击链接。",
    ].join(""),
  },
  {
    id: "team_summary_requirement",
    timeoutMs: 300000,
    prompt: [
      "现在我作为业务负责人追加需求：这个系统要支持“按团队汇总”，一个负责人可以属于不同团队。",
      "你先改 SPEC，再改实现，再更新 QA。不要破坏已有功能。",
    ].join(""),
  },
  {
    id: "history_versions_requirement",
    timeoutMs: 300000,
    prompt: [
      "我再追加一个复杂需求：增加“周报历史版本”。",
      "用户每次导出 Markdown 时，都要保存一个历史快照，可以在页面查看历史列表并复制任意一版。继续完成并更新 QA。",
    ].join(""),
  },
  {
    id: "big_project_final_acceptance",
    prompt: [
      "最后做一个总验收：请你像交付给内部试用一样整理结果。必须包含：",
      "大项目完成状态、主要产物路径、如何打开、功能清单、已执行验证、未覆盖风险、推荐下一步、这次大项目过程中你真实修改了哪些文件。",
    ].join(""),
  },
];

const results = [];
const ctx = {
  conversationId: null,
  threadId: null,
  historyBeforeTurn: null,
};

await main();

async function main() {
  setupWorkspace();
  console.log(JSON.stringify({
    event: "complex_user_regression.started",
    runId: RUN_ID,
    runRoot: RUN_ROOT,
    workspace: WORKSPACE,
    provider: PROVIDER,
    model: MODEL,
    turnCount: turns.length,
  }, null, 2));

  await apiJson("/v1/health");

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const startedAt = Date.now();
    console.log(JSON.stringify({
      event: "turn.started",
      index: index + 1,
      total: turns.length,
      id: turn.id,
    }));

    try {
      if (turn.before) {
        await turn.before(ctx);
      }
      const created = await createTurn(turn);
      ctx.conversationId = created.conversationId;
      ctx.threadId = created.threadId;

      if (turn.interruptAfterMs) {
        await delay(turn.interruptAfterMs);
        await apiJson(`/v1/tasks/${encodeURIComponent(created.taskId)}/interrupt`, { method: "POST" });
      }

      const artifact = await waitForArtifact(created, turn.timeoutMs ?? 240000);
      const diff = await tryJson(`/v1/tasks/${encodeURIComponent(created.taskId)}/diff`);
      const logs = await tryJson(`/v1/tasks/${encodeURIComponent(created.taskId)}/logs?limit=80`);
      const result = summarizeTurn({ turn, artifact, diff, logs, startedAt, index });
      results.push(result);
      console.log(JSON.stringify({
        event: "turn.finished",
        id: turn.id,
        status: result.status,
        elapsedMs: result.elapsedMs,
        tools: result.usedItems,
        finalPreview: result.finalPreview,
        error: result.error,
      }));
    } catch (error) {
      const result = {
        id: turn.id,
        status: "runner_failed",
        elapsedMs: Date.now() - startedAt,
        error: error.stack || error.message,
        finalPreview: null,
        usedItems: [],
        files: listFiles(WORKSPACE),
      };
      results.push(result);
      console.log(JSON.stringify({
        event: "turn.runner_failed",
        id: turn.id,
        error: error.message,
      }));
    }

    writeReport();
  }

  writeReport();
  console.log(JSON.stringify({
    event: "complex_user_regression.finished",
    reportJson: REPORT_JSON,
    reportMd: REPORT_MD,
    completed: results.filter((item) => item.status === "completed").length,
    failed: results.filter((item) => item.status !== "completed").length,
  }, null, 2));
}

function setupWorkspace() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, "README.md"), [
    "# Complex User Workspace",
    "",
    "This repo is used to test CodePilot as a realistic coding agent.",
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(WORKSPACE, "src"), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, "src", "math.js"), [
    "export function sum(values) {",
    "  return values.reduce((total, value) => total + value, 0);",
    "}",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(WORKSPACE, "src", "math.test.js"), [
    "import { sum } from './math.js';",
    "if (sum([1, 2, 3]) !== 6) {",
    "  throw new Error('sum failed');",
    "}",
    "console.log('math smoke ok');",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(WORKSPACE, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node src/math.test.js",
    },
  }, null, 2) + "\n");
  spawnSync("git", ["init"], { cwd: WORKSPACE, stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: WORKSPACE, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "baseline"], { cwd: WORKSPACE, stdio: "ignore" });
  fs.writeFileSync(path.join(WORKSPACE, "preexisting_notes.md"), "This dirty file existed before the agent task.\n");
}

async function createTurn(turn) {
  const endpoint = ctx.conversationId
    ? `/v1/conversations/${encodeURIComponent(ctx.conversationId)}/turns`
    : "/v1/tasks";
  return apiJson(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspacePath: WORKSPACE,
      provider: PROVIDER,
      model: MODEL,
      prompt: `${commonPrefix}\n\n用户当前请求：\n${turn.prompt}`,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      networkAccess: true,
      turnTimeoutMs: turn.timeoutMs ?? 240000,
    }),
  });
}

async function waitForArtifact(created, timeoutMs) {
  const deadline = Date.now() + timeoutMs + 15000;
  let artifact = null;
  while (Date.now() < deadline) {
    artifact = await apiJson(created.artifactUrl);
    if (["completed", "failed", "interrupted"].includes(artifact.status)) {
      return artifact;
    }
    await delay(3000);
  }
  return artifact ?? { status: "unknown", error: "timeout without artifact" };
}

function summarizeTurn({ turn, artifact, diff, logs, startedAt, index }) {
  const events = Array.isArray(artifact.events) ? artifact.events : [];
  const usedItems = [...new Set(events
    .map((event) => event.params?.item?.type)
    .filter((type) => type && type !== "userMessage"))];
  return {
    index: index + 1,
    id: turn.id,
    taskId: artifact.id,
    conversationId: artifact.conversationId,
    threadId: artifact.threadId,
    status: artifact.status,
    elapsedMs: Date.now() - startedAt,
    finalMessage: artifact.finalMessage,
    finalPreview: preview(artifact.finalMessage),
    error: errorText(artifact.error),
    usedItems,
    eventTypes: [...new Set(events.map((event) => event.type))],
    commandCount: events.filter((event) => event.params?.item?.type === "commandExecution").length,
    fileChangeCount: events.filter((event) => event.params?.item?.type === "fileChange").length,
    diffStatus: diff?.status ?? null,
    diffFiles: (diff?.files ?? []).map((file) => file.path || file.file).filter(Boolean),
    logSample: {
      events: logs?.events?.length ?? 0,
      transcript: logs?.transcript?.length ?? 0,
    },
    files: listFiles(WORKSPACE),
  };
}

function writeReport() {
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  const report = {
    runId: RUN_ID,
    runRoot: RUN_ROOT,
    workspace: WORKSPACE,
    provider: PROVIDER,
    model: MODEL,
    conversationId: ctx.conversationId,
    threadId: ctx.threadId,
    totals: {
      turns: results.length,
      completed: results.filter((item) => item.status === "completed").length,
      failed: results.filter((item) => item.status !== "completed").length,
    },
    files: listFiles(WORKSPACE),
    results,
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(REPORT_MD, markdownReport(report));
}

function markdownReport(report) {
  const lines = [
    `# Complex User Regression ${report.runId}`,
    "",
    `- Workspace: \`${report.workspace}\``,
    `- Provider: \`${report.provider}\``,
    `- Model: \`${report.model}\``,
    `- Conversation: \`${report.conversationId ?? ""}\``,
    `- Completed: ${report.totals.completed}/${report.totals.turns}`,
    "",
    "| # | Turn | Status | Items | Final / Error |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const result of report.results) {
    const text = result.status === "completed"
      ? result.finalPreview
      : (result.error || result.finalPreview || "");
    lines.push(`| ${result.index} | ${result.id} | ${result.status} | ${result.usedItems.join(", ") || "-"} | ${escapeTable(text)} |`);
  }
  lines.push("", "## Files", "");
  for (const file of report.files.slice(0, 120)) {
    lines.push(`- \`${file}\``);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function apiJson(pathname, options = {}) {
  const url = pathname.startsWith("http") ? pathname : `${BASE_URL}${pathname}`;
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function tryJson(pathname) {
  try {
    return await apiJson(pathname);
  } catch {
    return null;
  }
}

function listFiles(root) {
  const out = [];
  walk(root, root, out);
  return out.slice(0, 200);
}

function walk(root, current, out) {
  if (!fs.existsSync(current)) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full));
    }
  }
}

function preview(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 260);
}

function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 360);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
