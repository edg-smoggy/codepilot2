#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const productHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-codex-modelhub-matrix-"));
const workspaceRoot = path.join(productHome, "workspaces");

const fake = await startFakeModelHub();
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
  const scenarios = [];

  scenarios.push(await runPlainLinkScenario(baseUrl));
  scenarios.push(await runInspectWorkspaceScenario(baseUrl));
  scenarios.push(await runCommandFailureScenario(baseUrl));
  scenarios.push(await runPatchThenRunScenario(baseUrl));
  scenarios.push(await runImageInputScenario(baseUrl));
  scenarios.push(await runLongRunningCommandScenario(baseUrl));
  scenarios.push(await runMultiTurnScenario(baseUrl));

  const ok = scenarios.every((scenario) => scenario.ok);
  console.log(JSON.stringify({
    ok,
    productHome,
    fakeModelHub: {
      url: fake.url,
      requestCount: fake.requests.length,
    },
    scenarios,
  }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  server.kill("SIGTERM");
  await fake.close();
}

async function runPlainLinkScenario(baseUrl) {
  const workspace = makeWorkspace("plain-link", {
    "README.md": "# Plain link scenario\n",
  });
  const task = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "modelhub-gpt55",
    model: "gpt-5.5-2026-04-24",
    prompt: "SCENARIO:plain_link Return the Lark doc link only.",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  });
  return {
    id: "plain_link",
    ok: task.status === "completed"
      && task.finalMessage?.includes("https://bytedance.larkoffice.com/docx/RsAYdFAyVo7juOxx7q9c12JRn1f")
      && !task.usedTools.length,
    task,
  };
}

async function runInspectWorkspaceScenario(baseUrl) {
  const workspace = makeWorkspace("inspect-workspace", {
    "README.md": "# Inspect workspace scenario\n",
    "notes.txt": "important note\n",
  });
  const task = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "modelhub-gpt55",
    model: "gpt-5.5-2026-04-24",
    prompt: "SCENARIO:inspect_workspace Inspect the workspace files and report what you saw.",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  });
  const summary = fake.summaryFor("inspect_workspace");
  return {
    id: "inspect_workspace",
    ok: task.status === "completed"
      && task.finalMessage?.includes("README.md")
      && summary.assistantToolCallNames.includes("exec_command")
      && summary.toolCallOutputIds.includes("call_ls"),
    task,
    adapterHistory: summary,
  };
}

async function runCommandFailureScenario(baseUrl) {
  const workspace = makeWorkspace("command-failure", {
    "README.md": "# Command failure scenario\n",
  });
  const task = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "modelhub-gpt55",
    model: "gpt-5.5-2026-04-24",
    prompt: "SCENARIO:command_failure Run a missing script, handle the failure, and finish.",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  });
  const summary = fake.summaryFor("command_failure");
  return {
    id: "command_failure",
    ok: task.status === "completed"
      && task.finalMessage?.includes("failure was captured")
      && summary.assistantToolCallNames.includes("exec_command")
      && summary.toolCallOutputIds.includes("call_fail"),
    task,
    adapterHistory: summary,
  };
}

async function runPatchThenRunScenario(baseUrl) {
  const workspace = makeWorkspace("patch-then-run", {
    "calc.js": [
      "function add(a, b) {",
      "  return a - b;",
      "}",
      "",
      "console.log(add(2, 3));",
      "",
    ].join("\n"),
  });
  const calcPath = path.join(workspace, "calc.js");
  const task = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "modelhub-gpt55",
    model: "gpt-5.5-2026-04-24",
    prompt: "SCENARIO:patch_then_run Fix calc.js and run it.",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  });
  const summary = fake.summaryFor("patch_then_run");
  const fileText = fs.existsSync(calcPath) ? fs.readFileSync(calcPath, "utf8") : "";
  return {
    id: "patch_then_run",
    ok: task.status === "completed"
      && task.finalMessage?.includes("5")
      && fileText.includes("return a + b;")
      && summary.assistantToolCallNames.includes("apply_patch")
      && summary.assistantToolCallNames.includes("exec_command")
      && summary.toolCallOutputIds.includes("call_patch_calc")
      && summary.toolCallOutputIds.includes("call_run_calc"),
    file: {
      path: calcPath,
      text: fileText,
    },
    task,
    adapterHistory: summary,
  };
}

async function runImageInputScenario(baseUrl) {
  const workspace = makeWorkspace("image-input", {
    "README.md": "# Image input scenario\n",
  });
  const task = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "modelhub-gpt55",
    model: "gpt-5.5-2026-04-24",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.com/codepilot-smoke.png",
          },
          {
            type: "input_text",
            text: "SCENARIO:image_input Confirm the image input reached the model adapter.",
          },
        ],
      },
    ],
  });
  const summary = fake.summaryFor("image_input");
  return {
    id: "image_input",
    ok: task.status === "completed"
      && task.finalMessage?.includes("image input reached")
      && summary.imageUrlCount > 0,
    task,
    adapterHistory: summary,
  };
}

async function runLongRunningCommandScenario(baseUrl) {
  const workspace = makeWorkspace("long-running-command", {
    "README.md": "# Long running command scenario\n",
  });
  const task = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "modelhub-gpt55",
    model: "gpt-5.5-2026-04-24",
    prompt: "SCENARIO:long_running_command Start a long command and poll it.",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  });
  const summary = fake.summaryFor("long_running_command");
  return {
    id: "long_running_command",
    ok: task.status === "completed"
      && task.finalMessage?.includes("long-done")
      && summary.assistantToolCallNames.includes("exec_command")
      && summary.assistantToolCallNames.includes("write_stdin")
      && summary.toolCallOutputIds.includes("call_start_long")
      && summary.toolCallOutputIds.includes("call_poll_long"),
    task,
    adapterHistory: summary,
  };
}

async function runMultiTurnScenario(baseUrl) {
  const workspace = makeWorkspace("multi-turn", {
    "README.md": "# Multi turn scenario\n",
  });
  const first = await runTask(baseUrl, {
    workspacePath: workspace,
    provider: "modelhub-gpt55",
    model: "gpt-5.5-2026-04-24",
    prompt: "SCENARIO:multi_turn_first Remember the passphrase.",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  });
  const second = await runTask(
    baseUrl,
    {
      workspacePath: workspace,
      provider: "modelhub-gpt55",
      model: "gpt-5.5-2026-04-24",
      prompt: "SCENARIO:multi_turn_second What was the passphrase?",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      networkAccess: true,
    },
    `/v1/conversations/${encodeURIComponent(first.conversationId)}/turns`,
  );
  const summary = fake.summaryFor("multi_turn_second");
  return {
    id: "multi_turn_context",
    ok: first.status === "completed"
      && second.status === "completed"
      && first.conversationId === second.conversationId
      && first.threadId === second.threadId
      && second.finalMessage?.includes("orchid")
      && summary.sawAssistantText.includes("orchid"),
    first,
    second,
    adapterHistory: summary,
  };
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
    eventTypes: [...new Set(events.map((event) => event.type))],
    usedTools: [...new Set(events
      .map((event) => event.params?.item?.type)
      .filter((type) => type && type !== "userMessage" && type !== "agentMessage"))],
  };
}

async function startFakeModelHub() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      const scenarioId = scenarioIdFromRequest(body);
      requests.push({
        method: request.method,
        url: request.url,
        scenarioId,
        body,
      });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseForScenario(scenarioId, body)));
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
    summaryFor(scenarioId) {
      return summarizeRequests(requests.filter((request) => request.scenarioId === scenarioId).map((request) => request.body));
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function responseForScenario(scenarioId, body) {
  if (scenarioId === "plain_link") {
    return textResponse("https://bytedance.larkoffice.com/docx/RsAYdFAyVo7juOxx7q9c12JRn1f");
  }
  if (scenarioId === "inspect_workspace") {
    if (!hasToolOutput(body, "call_ls")) {
      return toolCallResponse({
        id: "call_ls",
        name: "exec_command",
        arguments: {
          cmd: "ls -1",
          yield_time_ms: 1000,
          max_output_tokens: 4000,
        },
      });
    }
    return textResponse("I inspected the workspace and saw README.md and notes.txt.");
  }
  if (scenarioId === "command_failure") {
    if (!hasToolOutput(body, "call_fail")) {
      return toolCallResponse({
        id: "call_fail",
        name: "exec_command",
        arguments: {
          cmd: "node definitely_missing_file.js",
          yield_time_ms: 1000,
          max_output_tokens: 4000,
        },
      });
    }
    return textResponse("The command failure was captured and the task can continue.");
  }
  if (scenarioId === "patch_then_run") {
    if (!hasToolOutput(body, "call_patch_calc")) {
      return toolCallResponse({
        id: "call_patch_calc",
        name: "apply_patch",
        arguments: {
          patch: [
            "*** Begin Patch",
            "*** Update File: calc.js",
            "@@",
            "-  return a - b;",
            "+  return a + b;",
            "*** End Patch",
            "",
          ].join("\n"),
        },
      });
    }
    if (!hasToolOutput(body, "call_run_calc")) {
      return toolCallResponse({
        id: "call_run_calc",
        name: "exec_command",
        arguments: {
          cmd: "node calc.js",
          yield_time_ms: 1000,
          max_output_tokens: 4000,
        },
      });
    }
    return textResponse("Fixed calc.js and verified the output is 5.");
  }
  if (scenarioId === "image_input") {
    return textResponse(imageUrlCount(body) > 0 ? "The image input reached the model adapter." : "No image input was forwarded.");
  }
  if (scenarioId === "long_running_command") {
    if (!hasToolOutput(body, "call_start_long")) {
      return toolCallResponse({
        id: "call_start_long",
        name: "exec_command",
        arguments: {
          cmd: "sleep 2; echo long-done",
          yield_time_ms: 250,
          max_output_tokens: 4000,
        },
      });
    }
    if (!hasToolOutput(body, "call_poll_long")) {
      const sessionId = sessionIdFromToolOutput(body, "call_start_long");
      if (!sessionId) {
        return textResponse(`No session id found in long command output: ${toolOutputText(body, "call_start_long").slice(0, 180)}`);
      }
      return toolCallResponse({
        id: "call_poll_long",
        name: "write_stdin",
        arguments: {
          session_id: Number(sessionId),
          chars: "",
          yield_time_ms: 3000,
          max_output_tokens: 4000,
        },
      });
    }
    const output = toolOutputText(body, "call_poll_long");
    return textResponse(output.includes("long-done") ? "Long command completed: long-done." : `Long command completed with output: ${output.slice(0, 120)}`);
  }
  if (scenarioId === "multi_turn_first") {
    return textResponse("The passphrase is orchid.");
  }
  if (scenarioId === "multi_turn_second") {
    const sawOrchid = assistantText(body).includes("orchid");
    return textResponse(sawOrchid ? "The previous passphrase was orchid." : "I did not receive the previous passphrase.");
  }
  return textResponse(`Unknown scenario: ${scenarioId || "none"}`);
}

function toolCallResponse(call) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
              },
            },
          ],
        },
      },
    ],
    usage: usage(),
  };
}

function textResponse(content) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
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

function summarizeRequests(bodies) {
  const messages = bodies.flatMap((body) => Array.isArray(body.messages) ? body.messages : []);
  return {
    requestCount: bodies.length,
    toolNames: [...new Set(bodies.flatMap((body) => Array.isArray(body.tools)
      ? body.tools.map((tool) => tool.function?.name || tool.name).filter(Boolean)
      : []))],
    assistantToolCallNames: [...new Set(messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function?.name || call.name)
      .filter(Boolean))],
    toolCallOutputIds: [...new Set(messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id)
      .filter(Boolean))],
    sawAssistantText: assistantText({ messages }),
    imageUrlCount: bodies.reduce((sum, body) => sum + imageUrlCount(body), 0),
  };
}

function scenarioIdFromRequest(body) {
  const text = messagesText(body);
  const matches = [...text.matchAll(/SCENARIO:([a-z0-9_]+)/gi)];
  return matches.at(-1)?.[1] || "unknown";
}

function messagesText(body) {
  return (body.messages ?? []).map((message) => contentText(message.content)).join("\n");
}

function assistantText(body) {
  return (body.messages ?? [])
    .filter((message) => message.role === "assistant")
    .map((message) => contentText(message.content))
    .join("\n");
}

function contentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => item?.text ?? item?.input_text ?? item?.output_text ?? "").join("");
  }
  if (content && typeof content === "object") {
    return content.text ?? content.input_text ?? content.output_text ?? JSON.stringify(content);
  }
  return "";
}

function hasToolOutput(body, callId) {
  return (body.messages ?? []).some((message) => message.role === "tool" && message.tool_call_id === callId);
}

function toolOutputText(body, callId) {
  return (body.messages ?? [])
    .filter((message) => message.role === "tool" && message.tool_call_id === callId)
    .map((message) => contentText(message.content))
    .join("\n");
}

function sessionIdFromToolOutput(body, callId) {
  const text = toolOutputText(body, callId);
  const match = text.match(/session[_ ]?id["']?\s*[:=]\s*(\d+)/i)
    || text.match(/session\s+ID\s+(\d+)/i)
    || text.match(/"session_id"\s*:\s*(\d+)/i);
  return match?.[1] || null;
}

function imageUrlCount(body) {
  return (body.messages ?? []).reduce((sum, message) => sum + contentImageUrlCount(message.content), 0);
}

function contentImageUrlCount(content) {
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.filter((item) => item?.type === "image_url" || item?.image_url || item?.imageUrl).length;
}

function makeWorkspace(name, files) {
  const workspace = path.join(workspaceRoot, name);
  fs.mkdirSync(workspace, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return workspace;
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
