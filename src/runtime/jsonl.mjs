import fs from "node:fs";
import path from "node:path";

const DEFAULT_REDACTION_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /("authorization"\s*:\s*")([^"]+)(")/gi,
  /(ARK_API_KEY=)[^\s"]+/g,
  /(MODELHUB_AK=)[^\s"]+/g,
  /(ak=)[A-Za-z0-9._~+/=-]+/gi,
];

export function redactSecrets(value, extraPatterns = []) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const pattern of [...DEFAULT_REDACTION_PATTERNS, ...extraPatterns]) {
    text = text.replace(pattern, (match, prefix, secret, suffix) => {
      if (prefix && suffix) {
        return `${prefix}[REDACTED]${suffix}`;
      }
      if (prefix) {
        return `${prefix}[REDACTED]`;
      }
      return match.startsWith("Bearer ") ? "Bearer [REDACTED]" : "[REDACTED]";
    });
  }
  return text;
}

export function createJsonlStream(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return fs.createWriteStream(filePath, { flags: "wx" });
}

export function appendJsonl(stream, event, options = {}) {
  if (!stream || stream.destroyed || stream.writableEnded) {
    return;
  }

  const safeEvent = JSON.parse(redactSecrets({ ts: new Date().toISOString(), ...event }, options.extraRedactionPatterns));
  stream.write(`${JSON.stringify(safeEvent)}\n`);
}

export function appendJsonlFile(filePath, event, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const safeEvent = JSON.parse(redactSecrets({ ts: new Date().toISOString(), ...event }, options.extraRedactionPatterns));
  fs.appendFileSync(filePath, `${JSON.stringify(safeEvent)}\n`);
}
