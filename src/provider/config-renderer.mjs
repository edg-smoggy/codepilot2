import fs from "node:fs";
import path from "node:path";

import { PROJECT_ROOT } from "../runtime/paths.mjs";
import { loadProvider } from "./registry.mjs";

const CODEX_PROMPT_PATH = path.join(
  PROJECT_ROOT,
  "upstream/openai-codex/codex-rs/models-manager/prompt.md",
);
const DEFAULT_PERSONALITY_HEADER =
  "You are Codex, a coding agent based on GPT-5. You and the user share the same workspace and collaborate to achieve the user's goals.";
const LOCAL_FRIENDLY_TEMPLATE =
  "You optimize for team morale and being a supportive teammate as much as code quality.";
const LOCAL_PRAGMATIC_TEMPLATE = "You are a deeply pragmatic, effective software engineer.";
const PERSONALITY_PLACEHOLDER = "{{ personality }}";

export function renderRuntimeConfig({
  codexHome,
  providerId,
  model,
  approvalPolicy = "on-request",
  sandboxMode = "workspace-write",
  baseUrlOverride,
  providerOverride,
}) {
  const provider = providerOverride ?? loadProvider(providerId);
  const resolvedModel = model ?? provider.defaultModel ?? provider.models?.[0]?.id;
  const providerBlockId = provider.id;
  const configPath = path.join(codexHome, "config.toml");
  const lines = [
    `model = ${tomlString(resolvedModel)}`,
    `model_provider = ${tomlString(providerBlockId)}`,
    `approval_policy = ${tomlString(approvalPolicy)}`,
    `sandbox_mode = ${tomlString(sandboxMode)}`,
  ];

  if (provider.codexInstructions === "upstream-default") {
    lines.push(`personality = ${tomlString("pragmatic")}`);
    lines.push("include_collaboration_mode_instructions = true");
    lines.push("suppress_unstable_features_warning = true");
  }

  if (provider.modelCatalogJson) {
    const catalogPath = path.isAbsolute(provider.modelCatalogJson)
      ? provider.modelCatalogJson
      : path.join(PROJECT_ROOT, provider.modelCatalogJson);
    const effectiveCatalogPath = effectiveModelCatalogPath({ codexHome, provider, catalogPath });
    lines.push(`model_catalog_json = ${tomlString(effectiveCatalogPath)}`);
  }

  if (provider.codexInstructions === "upstream-default") {
    lines.push("", "[features]");
    lines.push("personality = true");
  }

  lines.push("", `[model_providers.${providerBlockId}]`);
  lines.push(`name = ${tomlString(provider.name)}`);
  lines.push(`base_url = ${tomlString(baseUrlOverride ?? provider.baseUrl)}`);
  lines.push(`wire_api = ${tomlString(provider.wireApi)}`);

  if (provider.auth?.type === "env") {
    lines.push(`env_key = ${tomlString(provider.auth.envKey)}`);
    if (provider.auth.instructions) {
      lines.push(`env_key_instructions = ${tomlString(provider.auth.instructions)}`);
    }
  } else if (provider.auth?.type === "bearer") {
    lines.push(`experimental_bearer_token = ${tomlString(provider.auth.token)}`);
  }

  if (Number.isInteger(provider.requestMaxRetries)) {
    lines.push(`request_max_retries = ${provider.requestMaxRetries}`);
  }
  if (Number.isInteger(provider.streamMaxRetries)) {
    lines.push(`stream_max_retries = ${provider.streamMaxRetries}`);
  }
  if (Number.isInteger(provider.streamIdleTimeoutMs)) {
    lines.push(`stream_idle_timeout_ms = ${provider.streamIdleTimeoutMs}`);
  }
  if (typeof provider.supportsWebsockets === "boolean") {
    lines.push(`supports_websockets = ${provider.supportsWebsockets}`);
  }
  if (typeof provider.requiresOpenAiAuth === "boolean") {
    lines.push(`requires_openai_auth = ${provider.requiresOpenAiAuth}`);
  }

  appendTable(lines, providerBlockId, "query_params", provider.queryParams);
  appendTable(lines, providerBlockId, "http_headers", provider.httpHeaders);
  appendTable(lines, providerBlockId, "env_http_headers", provider.envHttpHeaders);

  if (provider.auth?.type === "command") {
    lines.push("", `[model_providers.${providerBlockId}.auth]`);
    lines.push(`command = ${tomlString(provider.auth.command)}`);
    if (provider.auth.args?.length) {
      lines.push(`args = [${provider.auth.args.map(tomlString).join(", ")}]`);
    }
    if (provider.auth.timeoutMs) {
      lines.push(`timeout_ms = ${provider.auth.timeoutMs}`);
    }
    if (provider.auth.refreshIntervalMs !== undefined) {
      lines.push(`refresh_interval_ms = ${provider.auth.refreshIntervalMs}`);
    }
    if (provider.auth.cwd) {
      lines.push(`cwd = ${tomlString(provider.auth.cwd)}`);
    }
  }

  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(configPath, `${lines.join("\n")}\n`);
  return {
    configPath,
    provider,
    model: resolvedModel,
  };
}

function effectiveModelCatalogPath({ codexHome, provider, catalogPath }) {
  if (provider.codexInstructions !== "upstream-default") {
    return catalogPath;
  }
  if (!fs.existsSync(CODEX_PROMPT_PATH)) {
    throw new Error(`Missing upstream Codex prompt: ${CODEX_PROMPT_PATH}`);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const baseInstructions = fs.readFileSync(CODEX_PROMPT_PATH, "utf8").trimEnd();
  const modelMessages = {
    instructions_template: `${DEFAULT_PERSONALITY_HEADER}\n\n${PERSONALITY_PLACEHOLDER}\n\n${baseInstructions}`,
    instructions_variables: {
      personality_default: "",
      personality_friendly: LOCAL_FRIENDLY_TEMPLATE,
      personality_pragmatic: LOCAL_PRAGMATIC_TEMPLATE,
    },
  };

  catalog.models = (catalog.models ?? []).map((model) => ({
    ...model,
    base_instructions: baseInstructions,
    model_messages: modelMessages,
  }));

  fs.mkdirSync(codexHome, { recursive: true });
  const generatedPath = path.join(codexHome, "model-catalog.generated.json");
  fs.writeFileSync(generatedPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return generatedPath;
}

function appendTable(lines, providerBlockId, tableName, values) {
  if (!values || Object.keys(values).length === 0) {
    return;
  }
  lines.push("", `[model_providers.${providerBlockId}.${tableName}]`);
  for (const [key, value] of Object.entries(values)) {
    lines.push(`${tomlBareKey(key)} = ${tomlString(value)}`);
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlBareKey(value) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}
