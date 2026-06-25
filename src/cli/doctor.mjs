#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { APP_SERVER_BIN, PROJECT_ROOT } from "../runtime/paths.mjs";
import { loadDotEnvLocal } from "../runtime/env-file.mjs";
import { startModelHubCrawlAdapter } from "../runtime/modelhub-crawl-adapter.mjs";
import { listProviders, loadProvider } from "../provider/registry.mjs";

loadDotEnvLocal();

function parseArgs(argv) {
  const args = {
    provider: "ark",
    directProbe: false,
    model: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--provider") {
      args.provider = argv[++i];
    } else if (arg === "--model") {
      args.model = argv[++i];
    } else if (arg === "--direct-probe") {
      args.directProbe = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function runDoctor(options = {}) {
  const providerId = options.provider ?? "ark";
  const provider = loadProvider(providerId);
  const checks = [];

  checks.push(check("app_server_binary", fs.existsSync(APP_SERVER_BIN), APP_SERVER_BIN));
  checks.push(check("provider_registered", true, provider.id));
  checks.push(check("provider_base_url", Boolean(provider.baseUrl), provider.baseUrl));
  checks.push(check("provider_wire_api", provider.wireApi === "responses", provider.wireApi));

  if (provider.modelCatalogJson) {
    const catalogPath = path.isAbsolute(provider.modelCatalogJson)
      ? provider.modelCatalogJson
      : path.join(PROJECT_ROOT, provider.modelCatalogJson);
    checks.push(check("model_catalog_file", fs.existsSync(catalogPath), catalogPath));
  }

  if (provider.auth?.type === "env") {
    const present = Boolean(process.env[provider.auth.envKey]);
    checks.push(check("provider_env_key", present, `${provider.auth.envKey} ${present ? "present" : "missing"}`));
  }

  let directProbe = null;
  if (options.directProbe) {
    directProbe = await probeProvider({ provider, model: options.model ?? provider.defaultModel });
    checks.push(check("direct_probe", directProbe.ok, directProbe.status ?? directProbe.reason));
  }

  return {
    ok: checks.every((item) => item.ok),
    provider: provider.id,
    providers: listProviders().map((item) => item.id),
    checks,
    directProbe,
  };
}

function check(name, ok, detail) {
  return {
    name,
    ok: Boolean(ok),
    detail,
  };
}

async function probeProvider({ provider, model }) {
  if (provider.auth?.type === "env" && !process.env[provider.auth.envKey]) {
    return { ok: true, skipped: true, reason: `${provider.auth.envKey} is not set` };
  }

  if (provider.adapter === "modelhub-crawl") {
    return probeModelHubAdapter({ model });
  }

  const headers = {
    "content-type": "application/json",
  };
  if (provider.auth?.type === "env") {
    headers.authorization = `Bearer ${process.env[provider.auth.envKey]}`;
  }

  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Say hello in one short sentence." }],
        },
      ],
    }),
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    bodyPreview: text.slice(0, 500),
  };
}

async function probeModelHubAdapter({ model }) {
  const adapter = await startModelHubCrawlAdapter({ defaultModel: model });
  try {
    const response = await fetch(`${adapter.url}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Say hello in one short sentence." }],
          },
        ],
      }),
    });
    const text = await response.text();
    return {
      ok: response.ok && text.includes("response.completed"),
      status: response.status,
      bodyPreview: text.slice(0, 500),
    };
  } finally {
    await adapter.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runDoctor(args);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
