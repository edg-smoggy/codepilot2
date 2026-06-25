#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), "..");
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const APP_NAME = "CodePilot";
const BUILD_ID = normalizeBuildId(process.env.CODEPILOT_BUILD_ID) ?? createBuildId();
const MACOS_DEPLOYMENT_TARGET = process.env.CODEPILOT_MACOS_DEPLOYMENT_TARGET || "11.0";
const SWIFT_TARGET = process.env.CODEPILOT_SWIFT_TARGET || `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macos${MACOS_DEPLOYMENT_TARGET}`;
const APP_ROOT = path.join(DIST_ROOT, `${APP_NAME}.app`);
const CONTENTS = path.join(APP_ROOT, "Contents");
const MACOS = path.join(CONTENTS, "MacOS");
const RESOURCES = path.join(CONTENTS, "Resources");
const RUNTIME = path.join(RESOURCES, "runtime");
const DMG_PATH = path.join(DIST_ROOT, `${APP_NAME}-internal-macos-${BUILD_ID}.dmg`);

const args = new Set(process.argv.slice(2));
const buildDmg = args.has("--dmg");
const embedLocalEnv = args.has("--embed-local-env") || process.env.CODEPILOT_EMBED_ENV === "1";

main();

function main() {
  ensurePrerequisites();
  resetOutput();
  createBundleLayout();
  compileSwiftApp();
  copyRuntime();
  copyNodeRuntime();
  writeManifest();
  if (buildDmg) {
    createDmg();
  }
  console.log(JSON.stringify({
    ok: true,
    buildId: BUILD_ID,
    embeddedEnv: embedLocalEnv,
    embeddedEnvKeys: embedLocalEnv ? envKeysFromFile(path.join(PROJECT_ROOT, ".env.local")) : [],
    app: APP_ROOT,
    dmg: buildDmg ? DMG_PATH : null,
    runtime: RUNTIME,
  }, null, 2));
}

function ensurePrerequisites() {
  assertFile(path.join(PROJECT_ROOT, "desktop/macos/CodePilotApp.swift"));
  assertFile(path.join(PROJECT_ROOT, "src/agent-server/server.mjs"));
  assertFile(path.join(PROJECT_ROOT, "web/index.html"));
  assertFile(path.join(
    PROJECT_ROOT,
    "upstream/openai-codex/codex-rs/target/debug/codex-app-server",
  ));
  run("swiftc", ["--version"], { quiet: true });
}

function resetOutput() {
  fs.rmSync(APP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(MACOS, { recursive: true });
  fs.mkdirSync(RESOURCES, { recursive: true });
}

function createBundleLayout() {
  fs.writeFileSync(path.join(CONTENTS, "Info.plist"), infoPlist());
  fs.writeFileSync(path.join(CONTENTS, "PkgInfo"), "APPL????");
}

function compileSwiftApp() {
  const moduleCachePath = path.join(DIST_ROOT, "swift-module-cache");
  fs.mkdirSync(moduleCachePath, { recursive: true });
  run("swiftc", [
    path.join(PROJECT_ROOT, "desktop/macos/CodePilotApp.swift"),
    "-target", SWIFT_TARGET,
    "-module-cache-path", moduleCachePath,
    "-framework", "AppKit",
    "-framework", "WebKit",
    "-o", path.join(MACOS, APP_NAME),
  ]);
}

function copyRuntime() {
  copyFile("package.json");
  copyEnvTemplate();
  copyDir("src");
  copyDir("web");
  copyDir("config");

  const upstreamRuntimeRoot = path.join(RUNTIME, "upstream/openai-codex");
  fs.mkdirSync(upstreamRuntimeRoot, { recursive: true });
  copyFile("upstream/openai-codex/LICENSE");
  copyFile("upstream/openai-codex/NOTICE");
  copyFile("upstream/openai-codex/codex-rs/models-manager/prompt.md");
  copyFile("upstream/openai-codex/codex-rs/target/debug/codex-app-server");
  fs.chmodSync(path.join(
    RUNTIME,
    "upstream/openai-codex/codex-rs/target/debug/codex-app-server",
  ), 0o755);
}

function writeManifest() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const manifest = {
    appName: APP_NAME,
    version: packageJson.version,
    buildId: BUILD_ID,
    macosDeploymentTarget: MACOS_DEPLOYMENT_TARGET,
    swiftTarget: SWIFT_TARGET,
    runtimeEntrypoint: "src/agent-server/server.mjs",
    appServerBinary: "upstream/openai-codex/codex-rs/target/debug/codex-app-server",
    userDataDir: "~/Library/Application Support/CodePilot",
    envFile: "~/Library/Application Support/CodePilot/.env.local",
    embeddedEnv: embedLocalEnv,
    nodeResolution: [
      "CODEPILOT_NODE",
      "Resources/node/bin/node",
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ],
    extensionPoints: {
      providers: "config/providers/*.json",
      modelCatalogs: "config/model-catalogs/*.json",
      frontend: "web/index.html",
      desktopShell: "desktop/macos/CodePilotApp.swift",
    },
  };
  fs.writeFileSync(path.join(RESOURCES, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(RESOURCES, "build-info.json"), `${JSON.stringify({
    appName: APP_NAME,
    version: packageJson.version,
    buildId: BUILD_ID,
    builtAt: new Date().toISOString(),
    embeddedEnv: embedLocalEnv,
    macosDeploymentTarget: MACOS_DEPLOYMENT_TARGET,
    swiftTarget: SWIFT_TARGET,
  }, null, 2)}\n`);
}

function copyNodeRuntime() {
  const nodeSource = findNodeRuntime();
  if (!nodeSource) {
    console.warn("warning: no standalone Node runtime found; app will fall back to system Node.");
    return;
  }
  const dest = path.join(RESOURCES, "node/bin/node");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(nodeSource, dest);
  fs.chmodSync(dest, 0o755);
}

function findNodeRuntime() {
  const candidates = [
    process.env.CODEPILOT_BUNDLE_NODE,
    "/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node",
    process.execPath,
  ].filter(Boolean);
  return candidates.find((candidate) =>
    fs.existsSync(candidate)
    && fs.statSync(candidate).isFile()
    && isMostlyStandaloneMachO(candidate)
  ) ?? null;
}

function isMostlyStandaloneMachO(binaryPath) {
  if (process.platform !== "darwin") {
    return true;
  }
  const result = spawnSync("otool", ["-L", binaryPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return false;
  }
  return !result.stdout.split(/\r?\n/).some((line) =>
    line.includes("/opt/homebrew/")
    || line.includes("/usr/local/opt/")
    || line.includes("@rpath/")
  );
}

function createDmg() {
  fs.rmSync(DMG_PATH, { force: true });
  run("hdiutil", [
    "create",
    "-volname", `${APP_NAME} Internal ${BUILD_ID}`,
    "-srcfolder", APP_ROOT,
    "-ov",
    "-format", "UDZO",
    DMG_PATH,
  ]);
}

function createBuildId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function normalizeBuildId(value) {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/[^0-9A-Za-z._-]/g, "-").replace(/-+/g, "-");
  return normalized || null;
}

function copyFile(relativePath) {
  const source = path.join(PROJECT_ROOT, relativePath);
  const dest = path.join(RUNTIME, relativePath);
  assertFile(source);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

function copyEnvTemplate() {
  const source = path.join(PROJECT_ROOT, embedLocalEnv ? ".env.local" : ".env.local.example");
  const dest = path.join(RUNTIME, ".env.local.example");
  assertFile(source);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

function envKeysFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
    .filter(Boolean);
}

function copyDir(relativePath) {
  const source = path.join(PROJECT_ROOT, relativePath);
  const dest = path.join(RUNTIME, relativePath);
  assertDir(source);
  fs.cpSync(source, dest, {
    recursive: true,
    dereference: false,
    filter: (item) => {
      const name = path.basename(item);
      return ![".DS_Store", "node_modules", "target"].includes(name);
    },
  });
}

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
  return result;
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing required file: ${filePath}`);
  }
}

function assertDir(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Missing required directory: ${dirPath}`);
  }
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>com.internal.codepilot</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>${BUILD_ID.replace(/\D/g, "").slice(0, 18) || "1"}</string>
  <key>LSMinimumSystemVersion</key>
  <string>${MACOS_DEPLOYMENT_TARGET}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
`;
}
