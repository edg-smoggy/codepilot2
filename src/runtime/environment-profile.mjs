import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_COMMANDS = [
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "git",
  "ssh",
  "gh",
  "python3",
  "cargo",
];

const EXTRA_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

const SECRET_ENV_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|COOKIE|AUTH)/i;

export function buildRuntimeEnvironment({
  productHome,
  workspacePath,
  runtimeMode = "product",
  overrides = {},
} = {}) {
  const shellEnv = readLoginShellEnv();
  const env = {
    ...shellEnv,
    ...process.env,
    ...overrides,
  };

  env.HOME = env.HOME || os.homedir();
  env.SHELL = env.SHELL || process.env.SHELL || "/bin/zsh";
  env.PATH = mergedPath(shellEnv.PATH, process.env.PATH, overrides.PATH);
  env.INTERNAL_CODEX_PRODUCT_HOME = productHome || "";
  env.INTERNAL_CODEX_WORKSPACE = workspacePath || "";
  env.INTERNAL_CODEX_RUNTIME_MODE = runtimeMode;

  if (!env.NODE_EXTRA_CA_CERTS) {
    const certificatePath = firstExistingPath([
      "/etc/ssl/cert.pem",
      "/usr/local/etc/openssl@3/cert.pem",
      "/opt/homebrew/etc/openssl@3/cert.pem",
    ]);
    if (certificatePath) {
      env.NODE_EXTRA_CA_CERTS = certificatePath;
    }
  }

  return { env, shellEnvLoaded: Object.keys(shellEnv).length > 0 };
}

export function collectEnvironmentDiagnostics({
  productHome,
  codexHome,
  workspacePath,
  runtimeMode = "product",
  commands = DEFAULT_COMMANDS,
} = {}) {
  const runtime = buildRuntimeEnvironment({ productHome, workspacePath, runtimeMode });
  const env = runtime.env;
  const gitRoot = workspacePath ? commandOutput("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspacePath,
    env,
    timeout: 5_000,
  }) : null;
  const resolvedGitRoot = gitRoot?.ok ? gitRoot.stdout.trim() : null;
  const skillRoots = discoverSkillRoots({
    workspacePath,
    gitRoot: resolvedGitRoot,
    codexHome,
  });

  return {
    generatedAt: new Date().toISOString(),
    runtimeMode,
    platform: {
      type: os.type(),
      release: os.release(),
      arch: os.arch(),
      shell: env.SHELL || null,
      home: env.HOME || null,
    },
    paths: {
      productHome: productHome || null,
      codexHome: codexHome || null,
      workspacePath: workspacePath || null,
      gitRoot: resolvedGitRoot,
      pathEntries: splitPath(env.PATH).slice(0, 40),
    },
    env: redactEnvironmentSnapshot(env),
    executables: Object.fromEntries(commands.map((command) => [command, executableInfo(command, { env, cwd: workspacePath })])),
    npm: npmDiagnostics({ env, cwd: workspacePath }),
    git: {
      root: resolvedGitRoot,
      rootError: gitRoot?.ok ? null : gitRoot?.stderr || gitRoot?.error || null,
    },
    skills: skillRoots,
    files: runtimeFiles({ codexHome }),
    shellEnvLoaded: runtime.shellEnvLoaded,
  };
}

export function discoverSkillRoots({ workspacePath, gitRoot, codexHome } = {}) {
  const candidates = uniqueValues([
    codexHome ? path.join(codexHome, "skills") : null,
    path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    workspacePath ? path.join(workspacePath, ".agents", "skills") : null,
    gitRoot ? path.join(gitRoot, ".agents", "skills") : null,
  ].filter(Boolean));

  return candidates.map((root) => {
    const exists = fs.existsSync(root);
    const isDirectory = exists && fs.statSync(root).isDirectory();
    const entries = isDirectory
      ? fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => isDirectoryEntry(path.join(root, entry.name)))
        .map((entry) => entry.name)
        .sort()
      : [];
    return {
      path: root,
      exists,
      isDirectory,
      count: entries.length,
      sample: entries.slice(0, 30),
    };
  });
}

export function redactEnvironmentSnapshot(env) {
  const keys = [
    "ARK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "npm_config_registry",
    "NPM_CONFIG_REGISTRY",
    "npm_config_userconfig",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSH_AUTH_SOCK",
  ];
  const snapshot = {};
  for (const key of keys) {
    if (env[key] == null || env[key] === "") {
      continue;
    }
    snapshot[key] = SECRET_ENV_RE.test(key) ? "[set]" : String(env[key]);
  }
  return snapshot;
}

function npmDiagnostics({ env, cwd }) {
  const result = {};
  for (const key of ["registry", "strict-ssl", "cafile", "userconfig"]) {
    const command = commandOutput("npm", ["config", "get", key], {
      cwd,
      env,
      timeout: 4_000,
    });
    result[key] = command.ok ? command.stdout.trim() : null;
    if (!command.ok) {
      result[`${key}Error`] = command.stderr || command.error || null;
    }
  }
  return result;
}

function executableInfo(command, { env, cwd } = {}) {
  const which = commandOutput("which", [command], { env, cwd, timeout: 2_000 });
  const version = commandOutput(command, versionArgsFor(command), { env, cwd, timeout: 4_000 });
  return {
    path: which.ok ? which.stdout.trim().split(/\r?\n/)[0] : null,
    version: version.ok ? (version.stdout || version.stderr).trim().split(/\r?\n/)[0] : null,
    error: version.ok ? null : version.stderr || version.error || null,
  };
}

function versionArgsFor(command) {
  if (command === "ssh") {
    return ["-V"];
  }
  return ["--version"];
}

function runtimeFiles({ codexHome }) {
  if (!codexHome) {
    return {};
  }
  const files = {};
  for (const [key, relativePath] of Object.entries({
    config: "config.toml",
    auth: "auth.json",
    credentials: "credentials.json",
    plugins: "plugins",
    skills: "skills",
  })) {
    const absolutePath = path.join(codexHome, relativePath);
    files[key] = {
      path: absolutePath,
      exists: fs.existsSync(absolutePath),
      kind: fs.existsSync(absolutePath)
        ? fs.statSync(absolutePath).isDirectory() ? "directory" : "file"
        : null,
      symlink: fs.existsSync(absolutePath) ? safeLstat(absolutePath)?.isSymbolicLink() ?? false : false,
    };
  }
  return files;
}

function readLoginShellEnv() {
  const shell = process.env.SHELL || "/bin/zsh";
  if (!fs.existsSync(shell)) {
    return {};
  }
  const result = spawnSync(shell, ["-lc", "env"], {
    encoding: "utf8",
    timeout: 2_500,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    return {};
  }
  const env = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function commandOutput(command, args, { cwd, env, timeout = 3_000 } = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
      env,
      encoding: "utf8",
      timeout,
    });
    if (result.error) {
      return { ok: false, error: result.error.message, stdout: result.stdout || "", stderr: result.stderr || "" };
    }
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout || "",
      stderr: (result.stderr || "").trim(),
    };
  } catch (error) {
    return { ok: false, error: error.message, stdout: "", stderr: "" };
  }
}

function mergedPath(...values) {
  return uniqueValues([
    ...values.flatMap(splitPath),
    ...EXTRA_PATHS,
  ]).join(path.delimiter);
}

function splitPath(value) {
  return String(value || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function firstExistingPath(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) || null;
}

function safeLstat(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return null;
  }
}

function isDirectoryEntry(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}
