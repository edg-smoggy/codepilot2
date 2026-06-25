import fs from "node:fs";
import path from "node:path";

import { PROJECT_ROOT } from "./paths.mjs";

export function loadDotEnvLocal(filePath = path.join(PROJECT_ROOT, ".env.local")) {
  if (!fs.existsSync(filePath)) {
    return { loaded: false, path: filePath, keys: [] };
  }

  const keys = [];
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || process.env[parsed.key] !== undefined) {
      continue;
    }
    process.env[parsed.key] = parsed.value;
    keys.push(parsed.key);
  }

  return { loaded: true, path: filePath, keys };
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) {
    return null;
  }

  return {
    key: match[1],
    value: parseEnvValue(match[2]),
  };
}

function parseEnvValue(rawValue) {
  const value = rawValue.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "");
}
