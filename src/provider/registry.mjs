import fs from "node:fs";
import path from "node:path";

import { CONFIG_ROOT } from "../runtime/paths.mjs";

export function loadProviderRegistry(configRoot = CONFIG_ROOT) {
  const providersDir = path.join(configRoot, "providers");
  const files = fs
    .readdirSync(providersDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const providers = new Map();
  for (const file of files) {
    const provider = JSON.parse(fs.readFileSync(path.join(providersDir, file), "utf8"));
    validateProvider(provider, file);
    providers.set(provider.id, provider);
  }
  return providers;
}

export function loadProvider(id, configRoot = CONFIG_ROOT) {
  const providers = loadProviderRegistry(configRoot);
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return provider;
}

export function listProviders(configRoot = CONFIG_ROOT) {
  return [...loadProviderRegistry(configRoot).values()].map((provider) => ({
    id: provider.id,
    name: provider.name,
    defaultModel: provider.defaultModel,
    models: provider.models ?? [],
    auth: provider.auth,
    baseUrl: provider.baseUrl,
  }));
}

function validateProvider(provider, file) {
  for (const key of ["id", "name", "baseUrl", "wireApi"]) {
    if (!provider[key]) {
      throw new Error(`${file} missing required provider field: ${key}`);
    }
  }
  if (!provider.defaultModel && !provider.models?.[0]?.id) {
    throw new Error(`${file} must define defaultModel or at least one model`);
  }
}
