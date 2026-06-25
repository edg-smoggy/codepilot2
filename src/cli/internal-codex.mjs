#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { DEFAULT_PRODUCT_HOME } from "../runtime/paths.mjs";
import { loadDotEnvLocal } from "../runtime/env-file.mjs";
import { listProviders } from "../provider/registry.mjs";
import { TaskManager, publicTaskArtifact } from "../agent-server/task-manager.mjs";
import { runDoctor } from "./doctor.mjs";

loadDotEnvLocal();

function parseArgs(argv) {
  const args = {
    command: argv[0] ?? "help",
    provider: null,
    model: null,
    workspacePath: process.cwd(),
    prompt: null,
    jsonPath: null,
    productHome: process.env.INTERNAL_CODEX_HOME ?? DEFAULT_PRODUCT_HOME,
    timeoutMs: null,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--provider") {
      args.provider = requireValue(argv, ++i, arg);
    } else if (arg === "--model") {
      args.model = requireValue(argv, ++i, arg);
    } else if (arg === "--workspace") {
      args.workspacePath = requireValue(argv, ++i, arg);
    } else if (arg === "--prompt") {
      args.prompt = requireValue(argv, ++i, arg);
    } else if (arg === "--json") {
      args.jsonPath = requireValue(argv, ++i, arg);
    } else if (arg === "--product-home") {
      args.productHome = requireValue(argv, ++i, arg);
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number.parseInt(requireValue(argv, ++i, arg), 10);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp();
    return;
  }

  if (args.command === "models") {
    console.log(JSON.stringify({ providers: listProviders() }, null, 2));
    return;
  }

  if (args.command === "doctor") {
    const result = await runDoctor({ provider: args.provider ?? "ark", model: args.model });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (args.command !== "run") {
    throw new Error(`Unknown command: ${args.command}`);
  }

  const request = args.jsonPath
    ? JSON.parse(fs.readFileSync(path.resolve(args.jsonPath), "utf8"))
    : {
        workspacePath: path.resolve(args.workspacePath),
        prompt: args.prompt,
        provider: args.provider ?? "mock",
        model: args.model ?? undefined,
      };
  if (args.timeoutMs) {
    request.turnTimeoutMs = args.timeoutMs;
  }

  const manager = new TaskManager({ productHome: args.productHome });
  const task = await manager.startTask(request);
  let lastPrinted = 0;
  while (task.status === "starting" || task.status === "running") {
    for (const event of task.events.slice(lastPrinted)) {
      printEvent(event);
    }
    lastPrinted = task.events.length;
    await delay(100);
  }
  for (const event of task.events.slice(lastPrinted)) {
    printEvent(event);
  }

  const artifact = publicTaskArtifact(task);
  console.log(JSON.stringify({
    ok: artifact.status === "completed",
    taskId: artifact.id,
    status: artifact.status,
    finalMessage: artifact.finalMessage,
    artifactPath: artifact.artifactPath,
  }, null, 2));

  if (artifact.status !== "completed") {
    process.exitCode = 1;
  }
}

function printEvent(event) {
  if (event.type === "item.completed" && event.params?.item?.type === "agentMessage") {
    console.log(event.params.item.text);
    return;
  }
  if (event.type.startsWith("task.") || event.type === "turn.completed") {
    console.error(`[${event.type}]`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`internal-codex

Commands:
  doctor [--provider ark|mock|modelhub-gpt55]
  models
  run --workspace <path> --prompt <text> [--provider mock|ark|modelhub-gpt55] [--model <id>]
  run --json <request.json>

Environment:
  INTERNAL_CODEX_HOME   Product state directory, default ${DEFAULT_PRODUCT_HOME}
  ARK_API_KEY           Required when --provider ark
  MODELHUB_AK           Required when --provider modelhub-gpt55
  .env.local            Loaded automatically from the project root

Examples:
  node src/cli/internal-codex.mjs run --provider mock --prompt "Say hello"
  node src/cli/internal-codex.mjs run --provider ark --model ep-20260427114346-pfqwk --prompt "Inspect this repo"
  node src/cli/internal-codex.mjs run --provider modelhub-gpt55 --prompt "Say hello"
`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
