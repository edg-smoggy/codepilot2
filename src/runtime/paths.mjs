import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
export const UPSTREAM_ROOT = path.join(PROJECT_ROOT, "upstream", "openai-codex");
export const APP_SERVER_BIN = path.join(
  UPSTREAM_ROOT,
  "codex-rs",
  "target",
  "debug",
  "codex-app-server",
);
export const CONFIG_ROOT = path.join(PROJECT_ROOT, "config");
export const DEFAULT_PRODUCT_HOME = path.join(os.homedir(), ".internal-codex-runtime");
