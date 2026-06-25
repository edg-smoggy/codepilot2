const STREAM_EVENT_TYPES = [
  "task.started",
  "task.completed",
  "task.failed",
  "task.continuation.started",
  "turn.verification.passed",
  "turn.verification.failed",
  "task.interrupt.requested",
  "remoteControl.status.changed",
  "thread.started",
  "thread.status.changed",
  "turn.started",
  "turn.completed",
  "turn.diff.updated",
  "turn.plan.updated",
  "item.started",
  "item.completed",
  "item.agentMessage.delta",
  "item.plan.delta",
  "item.reasoning.summaryTextDelta",
  "item.reasoning.summaryPartAdded",
  "item.reasoning.textDelta",
  "item.commandExecution.outputDelta",
  "item.commandExecution.terminalInteraction",
  "item.fileChange.outputDelta",
  "item.fileChange.patchUpdated",
  "item.mcpToolCall.progress",
  "command.exec.outputDelta",
  "process.outputDelta",
  "process.exited",
  "item.commandExecution.requestApproval",
  "item.fileChange.requestApproval",
  "item.permissions.requestApproval",
  "item.tool.requestUserInput",
  "mcpServer.elicitation.request",
  "serverRequest.response.sent",
  "serverRequest.rejected",
  "runtime.environment.ready",
  "runtime.error",
  "runtime.warning"
];

const SILENT_EVENT_TYPES = new Set([
  "account.rateLimits.updated",
  "remoteControl.status.changed",
  "thread.settings.updated",
  "thread.tokenUsage.updated",
  "turn.context.updated",
  "turn.tokenUsage.updated"
]);

const DEFAULT_PROVIDER_ID = "modelhub-gpt55";
const DEFAULT_PROVIDER_VERSION = "modelhub-gpt55-2026-06-18-controls";
const LEGACY_DEFAULT_PROVIDER_ID = "ark";
const WORKSPACE_STORAGE_KEY = "codepilot.workspace";
const RECENT_WORKSPACES_STORAGE_KEY = "codepilot.recentWorkspaces";
const SEEN_CONVERSATION_TASKS_STORAGE_KEY = "codepilot.seenConversationTasks";
const LEGACY_WORKSPACE_BASENAMES = new Set([["Agent", "Bench", "Workspace"].join(" ")]);
const MAX_RECENT_WORKSPACES = 8;
const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENTS = 4;
const TEXT_ATTACHMENT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "jsonl", "csv", "tsv", "log"]);
const IMAGE_ATTACHMENT_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const IMAGE_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const RESOURCE_FILE_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "jsonl", "csv", "tsv", "log", "html", "pdf", "png", "jpg", "jpeg", "webp"]);
const FALLBACK_PROVIDERS = [
  {
    id: "modelhub-gpt55",
    name: "ModelHub GPT-5.5",
    defaultModel: "gpt-5.5-2026-04-24",
    models: [{ id: "gpt-5.5-2026-04-24", name: "GPT-5.5 2026-04-24" }]
  },
  {
    id: "ark",
    name: "Volcengine Ark",
    defaultModel: "ep-20260427114346-pfqwk",
    models: [{ id: "ep-20260427114346-pfqwk", name: "Ark / Seed2.0 endpoint" }]
  },
  {
    id: "mock",
    name: "Local Mock Responses",
    defaultModel: "mock-model",
    models: [{ id: "mock-model", name: "Mock model" }]
  }
];

const state = {
  providers: [],
  tasks: [],
  conversations: [],
  activeConversation: null,
  activeArtifact: null,
  activeDiff: null,
  environmentDiagnostics: null,
  showDiagnostics: false,
  diagnosticsLoading: false,
  attachments: [],
  eventSource: null,
  renderTaskTimer: null,
  isSubmitting: false,
  isComposing: false,
  defaultWorkspace: "",
  recentWorkspaces: [],
  workspaceFilter: "",
  seenConversationTasks: loadSeenConversationTasks()
};

const els = {
  main: document.querySelector(".main"),
  taskList: document.getElementById("taskList"),
  sessionTitle: document.getElementById("sessionTitle"),
  sessionMeta: document.getElementById("sessionMeta"),
  taskStatus: document.getElementById("taskStatus"),
  serverStatus: document.getElementById("serverStatus"),
  environmentBtn: document.getElementById("environmentBtn"),
  diagnosticsPanel: document.getElementById("diagnosticsPanel"),
  workspaceInput: document.getElementById("workspaceInput"),
  providerSelect: document.getElementById("providerSelect"),
  modelInput: document.getElementById("modelInput"),
  approvalSelect: document.getElementById("approvalSelect"),
  attachBtn: document.getElementById("attachBtn"),
  fileInput: document.getElementById("fileInput"),
  attachmentList: document.getElementById("attachmentList"),
  inputBox: document.getElementById("inputBox"),
  sendBtn: document.getElementById("sendBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  newTaskBtn: document.getElementById("newTaskBtn"),
  messages: document.getElementById("messages"),
  modeLabel: document.getElementById("modeLabel"),
  workspaceMenuBtn: document.getElementById("workspaceMenuBtn"),
  workspaceLabel: document.getElementById("workspaceLabel"),
  workspacePopover: document.getElementById("workspacePopover"),
  workspaceSearch: document.getElementById("workspaceSearch"),
  workspaceOptions: document.getElementById("workspaceOptions"),
  chooseWorkspaceBtn: document.getElementById("chooseWorkspaceBtn"),
  defaultWorkspaceBtn: document.getElementById("defaultWorkspaceBtn"),
  toast: document.getElementById("toast")
};

init();

async function init() {
  bindEvents();
  renderEmpty();
  state.recentWorkspaces = loadRecentWorkspaces().filter(isSelectableWorkspacePath);
  saveRecentWorkspaces();
  const savedWorkspace = localStorage.getItem(WORKSPACE_STORAGE_KEY);
  if (savedWorkspace && isSelectableWorkspacePath(savedWorkspace)) {
    setWorkspace(savedWorkspace, { saveRecent: true, render: false });
  } else if (savedWorkspace) {
    localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  }

  let health = null;
  try {
    health = await apiJson("/v1/health");
    els.serverStatus.textContent = "已连接";
  } catch (error) {
    els.serverStatus.textContent = "未连接";
    showToast(error.message);
  }

  state.defaultWorkspace = health?.defaultWorkspace || "";
  if (!currentWorkspace() || isUnsafeWorkspacePath(currentWorkspace())) {
    setWorkspace(state.defaultWorkspace, { saveRecent: true, render: false });
  }
  renderWorkspacePicker();

  try {
    const models = await apiJson("/v1/models");
    state.providers = models.providers || [];
  } catch (error) {
    state.providers = FALLBACK_PROVIDERS;
    showToast(`模型列表加载失败，已使用本地默认配置: ${error.message}`);
  }
  renderProviders();

  try {
    await loadTasks();
  } catch (error) {
    showToast(`历史加载失败: ${error.message}`);
  }
}

function bindEvents() {
  els.sendBtn.addEventListener("click", () => {
    if (canCancelActiveTask()) {
      cancelActiveTask();
    } else {
      sendTask();
    }
  });
  els.refreshBtn.addEventListener("click", loadTasks);
  els.cancelBtn.addEventListener("click", cancelActiveTask);
  els.newTaskBtn.addEventListener("click", newTask);
  els.environmentBtn.addEventListener("click", toggleEnvironmentDiagnostics);
  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", async () => {
    await addFiles([...els.fileInput.files]);
    els.fileInput.value = "";
  });
  els.providerSelect.addEventListener("change", () => {
    localStorage.setItem("codepilot.provider", els.providerSelect.value);
    localStorage.setItem("codepilot.providerDefaultVersion", DEFAULT_PROVIDER_VERSION);
    renderModelsForCurrentProvider();
  });
  els.modelInput.addEventListener("change", () => {
    localStorage.setItem(modelStorageKey(els.providerSelect.value), els.modelInput.value);
  });
  els.approvalSelect.addEventListener("change", () => {
    renderApprovalLabel();
  });
  els.inputBox.addEventListener("input", () => autoResize(els.inputBox));
  els.inputBox.addEventListener("paste", async (event) => {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    await addFiles(files, { source: "paste" });
  });
  els.inputBox.addEventListener("compositionstart", () => {
    state.isComposing = true;
  });
  els.inputBox.addEventListener("compositionend", () => {
    state.isComposing = false;
  });
  els.inputBox.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      if (event.isComposing || state.isComposing || event.keyCode === 229) {
        return;
      }
      event.preventDefault();
      sendTask();
    }
  });
  els.workspaceMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleWorkspaceMenu();
  });
  els.workspacePopover.addEventListener("click", (event) => event.stopPropagation());
  els.workspaceSearch.addEventListener("input", () => {
    state.workspaceFilter = els.workspaceSearch.value;
    renderWorkspacePicker();
  });
  els.chooseWorkspaceBtn.addEventListener("click", chooseWorkspace);
  els.defaultWorkspaceBtn.addEventListener("click", () => {
    if (isWorkspaceLocked()) {
      showToast("当前会话工作区已固定，请新建对话后选择工作区");
      return;
    }
    setWorkspace(state.defaultWorkspace || currentWorkspace(), { saveRecent: true });
    closeWorkspaceMenu();
  });
  document.addEventListener("click", closeWorkspaceMenu);
}

async function loadTasks() {
  const data = await apiJson("/v1/conversations?limit=80");
  state.conversations = (data.conversations || [])
    .filter((conversation) => !isLegacyWorkspacePath(conversation.workspacePath));
  state.tasks = state.conversations;
  mergeRecentWorkspaces(workspacesFromConversations());
  renderSidebar();
  renderWorkspacePicker();
}

function currentWorkspace() {
  return els.workspaceInput.value.trim();
}

function loadRecentWorkspaces() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_WORKSPACES_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.trim()) : [];
  } catch {
    return [];
  }
}

function saveRecentWorkspaces() {
  localStorage.setItem(RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(state.recentWorkspaces.slice(0, MAX_RECENT_WORKSPACES)));
}

function loadSeenConversationTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_CONVERSATION_TASKS_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveSeenConversationTasks() {
  localStorage.setItem(SEEN_CONVERSATION_TASKS_STORAGE_KEY, JSON.stringify(state.seenConversationTasks));
}

function conversationSeenMarker(conversation) {
  return conversation?.lastTaskId || conversation?.tasks?.at(-1)?.id || conversation?.updatedAt || conversation?.id || "";
}

function markConversationSeen(conversation) {
  const marker = conversationSeenMarker(conversation);
  if (!conversation?.id || !marker || state.seenConversationTasks[conversation.id] === marker) {
    return;
  }
  state.seenConversationTasks[conversation.id] = marker;
  saveSeenConversationTasks();
}

function isUnreadCompletedConversation(conversation) {
  if (!conversation || state.activeConversation?.id === conversation.id) {
    return false;
  }
  const status = conversation.lastTaskStatus || conversation.status;
  if (status !== "completed") {
    return false;
  }
  const marker = conversationSeenMarker(conversation);
  return Boolean(marker && state.seenConversationTasks[conversation.id] !== marker);
}

function mergeRecentWorkspaces(paths) {
  let changed = false;
  for (const workspacePath of paths) {
    const normalized = String(workspacePath || "").trim();
    if (!isSelectableWorkspacePath(normalized) || state.recentWorkspaces.includes(normalized)) {
      continue;
    }
    state.recentWorkspaces.push(normalized);
    changed = true;
  }
  if (changed) {
    state.recentWorkspaces = uniqueStrings(state.recentWorkspaces).slice(0, MAX_RECENT_WORKSPACES);
    saveRecentWorkspaces();
  }
}

function setWorkspace(workspacePath, { saveRecent = true, render = true, persist = true, force = false } = {}) {
  const normalized = String(workspacePath || "").trim();
  if (!normalized) {
    return;
  }
  if (isWorkspaceLocked() && !force) {
    showToast("当前会话工作区已固定，请在新对话里重新选择");
    return;
  }
  if (isUnsafeWorkspacePath(normalized)) {
    showToast("不能把安装包内部目录作为工作区，请选择普通项目文件夹");
    return;
  }
  if (isLegacyWorkspacePath(normalized)) {
    showToast("已忽略旧版测试工作区，请选择正常项目文件夹");
    return;
  }
  els.workspaceInput.value = normalized;
  if (persist) {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, normalized);
  }
  if (saveRecent) {
    state.recentWorkspaces = [normalized, ...state.recentWorkspaces.filter((item) => item !== normalized)]
      .slice(0, MAX_RECENT_WORKSPACES);
    saveRecentWorkspaces();
  }
  state.environmentDiagnostics = null;
  if (state.showDiagnostics) {
    loadEnvironmentDiagnostics();
  }
  if (render) {
    renderWorkspacePicker();
  }
}

function workspacesFromConversations() {
  return uniqueStrings(state.conversations.map((conversation) => conversation.workspacePath).filter(isSelectableWorkspacePath));
}

function workspaceOptions() {
  return uniqueStrings([
    currentWorkspace(),
    ...state.recentWorkspaces,
    ...workspacesFromConversations(),
    state.defaultWorkspace,
  ].filter(Boolean)).filter(isSelectableWorkspacePath);
}

function isSelectableWorkspacePath(workspacePath) {
  const normalized = String(workspacePath || "").trim();
  return Boolean(normalized) && !isUnsafeWorkspacePath(normalized) && !isLegacyWorkspacePath(normalized);
}

function isLegacyWorkspacePath(workspacePath) {
  return LEGACY_WORKSPACE_BASENAMES.has(basename(workspacePath));
}

function isWorkspaceLocked() {
  return Boolean(state.activeConversation || state.activeArtifact);
}

function activeWorkspacePath() {
  return state.activeConversation?.workspacePath
    || state.activeArtifact?.workspacePath
    || currentWorkspace();
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function renderWorkspacePicker() {
  const selected = currentWorkspace();
  const locked = isWorkspaceLocked();
  els.workspaceLabel.textContent = selected ? basename(selected) : "选择工作区";
  els.workspaceMenuBtn.title = locked
    ? `${selected || "选择工作区"}（当前会话已固定）`
    : selected || "选择工作区";
  els.workspaceMenuBtn.disabled = locked;
  els.workspaceMenuBtn.classList.toggle("locked", locked);
  els.workspaceMenuBtn.setAttribute("aria-disabled", locked ? "true" : "false");
  els.chooseWorkspaceBtn.disabled = locked;
  els.defaultWorkspaceBtn.disabled = locked;
  if (locked) {
    closeWorkspaceMenu();
  }

  const filter = state.workspaceFilter.trim().toLowerCase();
  const options = workspaceOptions().filter((workspacePath) => {
    if (!filter) return true;
    return workspacePath.toLowerCase().includes(filter) || basename(workspacePath).toLowerCase().includes(filter);
  });

  els.workspaceOptions.innerHTML = options.length
    ? options.map((workspacePath) => `
        <button class="workspace-option" type="button" data-workspace-path="${escapeHtml(workspacePath)}">
          <span aria-hidden="true">${workspacePath === selected ? "✓" : "▣"}</span>
          <span class="workspace-option-name">${escapeHtml(basename(workspacePath))}</span>
          <span class="workspace-option-path">${escapeHtml(parentPath(workspacePath))}</span>
        </button>
      `).join("")
    : `<div class="workspace-option-path" style="padding:8px 9px;max-width:none;">没有匹配的项目</div>`;

  els.workspaceOptions.querySelectorAll(".workspace-option").forEach((button) => {
    button.addEventListener("click", () => {
      setWorkspace(button.dataset.workspacePath, { saveRecent: true });
      closeWorkspaceMenu();
    });
  });
}

function toggleWorkspaceMenu() {
  if (isWorkspaceLocked()) {
    showToast("当前会话工作区已固定，请新建对话后选择工作区");
    return;
  }
  if (els.workspacePopover.hidden) {
    openWorkspaceMenu();
  } else {
    closeWorkspaceMenu();
  }
}

function openWorkspaceMenu() {
  state.workspaceFilter = "";
  els.workspaceSearch.value = "";
  renderWorkspacePicker();
  els.workspacePopover.hidden = false;
  requestAnimationFrame(() => els.workspaceSearch.focus());
}

function closeWorkspaceMenu() {
  els.workspacePopover.hidden = true;
}

async function chooseWorkspace() {
  if (isWorkspaceLocked()) {
    showToast("当前会话工作区已固定，请新建对话后选择工作区");
    return;
  }
  const previousHtml = els.chooseWorkspaceBtn.innerHTML;
  els.chooseWorkspaceBtn.disabled = true;
  els.chooseWorkspaceBtn.innerHTML = `<span aria-hidden="true">…</span><span>正在打开...</span>`;
  try {
    const data = await apiJson("/v1/workspaces/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultPath: currentWorkspace() || state.defaultWorkspace })
    });
    if (data.path) {
      setWorkspace(data.path, { saveRecent: true });
      closeWorkspaceMenu();
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    els.chooseWorkspaceBtn.disabled = false;
    els.chooseWorkspaceBtn.innerHTML = previousHtml;
  }
}

async function toggleEnvironmentDiagnostics() {
  state.showDiagnostics = !state.showDiagnostics;
  renderDiagnosticsPanel();
  if (state.showDiagnostics && !state.environmentDiagnostics) {
    await loadEnvironmentDiagnostics();
  }
}

async function loadEnvironmentDiagnostics() {
  const workspacePath = els.workspaceInput.value.trim();
  state.diagnosticsLoading = true;
  renderDiagnosticsPanel();
  try {
    const query = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : "";
    state.environmentDiagnostics = await apiJson(`/v1/environment${query}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    state.diagnosticsLoading = false;
    renderDiagnosticsPanel();
  }
}

function renderDiagnosticsPanel() {
  if (!state.showDiagnostics) {
    els.diagnosticsPanel.classList.add("hidden");
    els.diagnosticsPanel.innerHTML = "";
    return;
  }
  els.diagnosticsPanel.classList.remove("hidden");
  const diag = state.environmentDiagnostics;
  if (state.diagnosticsLoading && !diag) {
    els.diagnosticsPanel.innerHTML = `<div class="diagnostics-inner"><div class="diagnostics-title">正在读取本地运行环境...</div></div>`;
    return;
  }
  if (!diag) {
    els.diagnosticsPanel.innerHTML = `
      <div class="diagnostics-inner">
        <div class="diagnostics-header">
          <span class="diagnostics-title">本地运行环境</span>
          <button class="chip-btn" type="button" id="diagnosticsReloadBtn">重新读取</button>
        </div>
      </div>
    `;
    els.diagnosticsPanel.querySelector("#diagnosticsReloadBtn")?.addEventListener("click", loadEnvironmentDiagnostics);
    return;
  }

  const commandLines = ["node", "npm", "npx", "git", "ssh"]
    .map((name) => {
      const info = diag.executables?.[name] || {};
      return `${name}: ${info.path || "not found"}${info.version ? ` · ${info.version}` : ""}`;
    });
  const skillLines = (diag.skills || []).map((root) =>
    `${root.exists ? "ok" : "missing"} · ${root.path} · ${root.count || 0} skills`,
  );
  els.diagnosticsPanel.innerHTML = `
    <div class="diagnostics-inner">
      <div class="diagnostics-header">
        <span class="diagnostics-title">本地运行环境</span>
        <button class="chip-btn" type="button" id="diagnosticsReloadBtn">重新读取</button>
      </div>
      <div class="diagnostics-grid">
        ${diagnosticsItemHtml("workspace", diag.paths?.workspacePath)}
        ${diagnosticsItemHtml("codex home", diag.paths?.codexHome)}
        ${diagnosticsItemHtml("npm registry", diag.npm?.registry || diag.env?.npm_config_registry || diag.env?.NPM_CONFIG_REGISTRY)}
        ${diagnosticsItemHtml("CA cert", diag.env?.NODE_EXTRA_CA_CERTS || "not set")}
      </div>
      <div class="diagnostics-list">
        ${commandLines.map((line) => `<div class="diagnostics-line">${escapeHtml(line)}</div>`).join("")}
        ${skillLines.map((line) => `<div class="diagnostics-line">${escapeHtml(line)}</div>`).join("")}
      </div>
    </div>
  `;
  els.diagnosticsPanel.querySelector("#diagnosticsReloadBtn")?.addEventListener("click", loadEnvironmentDiagnostics);
}

function diagnosticsItemHtml(label, value) {
  return `
    <div class="diagnostics-item">
      <div class="diagnostics-label">${escapeHtml(label)}</div>
      <div class="diagnostics-value" title="${escapeHtml(value || "")}">${escapeHtml(value || "unknown")}</div>
    </div>
  `;
}

function renderProviders() {
  els.providerSelect.disabled = state.providers.length === 0;
  if (!state.providers.length) {
    els.providerSelect.innerHTML = `<option value="">模型服务不可用</option>`;
    renderModelsForCurrentProvider();
    return;
  }
  els.providerSelect.innerHTML = state.providers
    .map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name || provider.id)}</option>`)
    .join("");
  const providerId = preferredProviderId();
  if (providerId) {
    els.providerSelect.value = providerId;
    localStorage.setItem("codepilot.provider", providerId);
    localStorage.setItem("codepilot.providerDefaultVersion", DEFAULT_PROVIDER_VERSION);
  }
  renderModelsForCurrentProvider();
}

function preferredProviderId() {
  const hasProvider = (id) => state.providers.some((provider) => provider.id === id);
  const savedProvider = localStorage.getItem("codepilot.provider");
  const defaultVersion = localStorage.getItem("codepilot.providerDefaultVersion");
  const shouldMigrateLegacyDefault = defaultVersion !== DEFAULT_PROVIDER_VERSION
    && (!savedProvider || savedProvider === LEGACY_DEFAULT_PROVIDER_ID);
  if (shouldMigrateLegacyDefault && hasProvider(DEFAULT_PROVIDER_ID)) {
    return DEFAULT_PROVIDER_ID;
  }
  if (savedProvider && hasProvider(savedProvider)) {
    return savedProvider;
  }
  if (hasProvider(DEFAULT_PROVIDER_ID)) {
    return DEFAULT_PROVIDER_ID;
  }
  return state.providers[0]?.id || "";
}

function renderModelsForCurrentProvider() {
  const provider = currentProvider();
  const models = modelOptions(provider);
  if (!models.length) {
    els.modelInput.innerHTML = `<option value="">模型不可用</option>`;
    els.modelInput.value = "";
    els.modelInput.disabled = true;
    return;
  }
  els.modelInput.innerHTML = models
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`)
    .join("");
  const savedModel = localStorage.getItem(modelStorageKey(provider?.id));
  const defaultModel = provider?.defaultModel || models[0]?.id || "";
  const selectedModel = models.some((model) => model.id === savedModel) ? savedModel : defaultModel;
  els.modelInput.value = selectedModel;
  els.modelInput.disabled = false;
}

function modelOptions(provider) {
  if (!provider) return [];
  const byId = new Map();
  for (const model of provider.models || []) {
    if (model?.id) {
      byId.set(model.id, { id: model.id, name: model.name || model.id });
    }
  }
  if (provider.defaultModel && !byId.has(provider.defaultModel)) {
    byId.set(provider.defaultModel, { id: provider.defaultModel, name: provider.defaultModel });
  }
  return [...byId.values()];
}

function modelStorageKey(providerId) {
  return `codepilot.model.${providerId || "unknown"}`;
}

function renderApprovalLabel() {
  els.modeLabel.textContent = els.approvalSelect.value === "never" ? "权限: 自动执行" : "权限: 请求批准";
}

async function addFiles(files, { source = "picker" } = {}) {
  if (!files.length) return;
  const imageCount = state.attachments.filter((file) => file.kind === "image").length;
  const incomingImageCount = files.filter(isImageAttachment).length;
  if (imageCount + incomingImageCount > MAX_IMAGE_ATTACHMENTS) {
    showToast(`最多附加 ${MAX_IMAGE_ATTACHMENTS} 张图片`);
    return;
  }
  const currentBytes = state.attachments.reduce((sum, file) => sum + file.size, 0);
  let nextBytes = currentBytes;
  for (const file of files) {
    try {
      const attachment = await readAttachment(file);
      if (nextBytes + attachment.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        showToast("附件总大小超过 12MB，先减少文件再试");
        break;
      }
      state.attachments.push(attachment);
      nextBytes += attachment.size;
    } catch (error) {
      showToast(error.message);
    }
  }
  renderAttachments();
  if (source === "paste" && incomingImageCount > 0) {
    showToast(`已粘贴 ${incomingImageCount} 张图片`);
  }
}

async function readAttachment(file) {
  if (isImageAttachment(file)) {
    return readImageAttachment(file);
  }
  if (isTextAttachment(file)) {
    return readTextAttachment(file);
  }
  throw new Error(`暂不支持 ${file.name}，支持 Markdown、文本和 PNG/JPG/WebP 图片`);
}

async function readTextAttachment(file) {
  if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} 超过 1MB，先拆小一点再传`);
  }
  const text = await file.text();
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
    kind: "text",
    name: file.name,
    type: file.type || "text/plain",
    size: file.size,
    text,
  };
}

async function readImageAttachment(file) {
  if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} 超过 5MB，先压缩后再传`);
  }
  const dataUrl = await readFileAsDataUrl(file);
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
    kind: "image",
    name: file.name || `pasted-image-${Date.now()}.png`,
    type: file.type || "image/png",
    size: file.size,
    dataUrl,
  };
}

function isTextAttachment(file) {
  const extension = fileExtension(file.name);
  return TEXT_ATTACHMENT_EXTENSIONS.has(extension) || String(file.type || "").startsWith("text/");
}

function isImageAttachment(file) {
  const type = String(file.type || "").toLowerCase();
  const extension = fileExtension(file.name);
  return IMAGE_ATTACHMENT_TYPES.has(type) || IMAGE_ATTACHMENT_EXTENSIONS.has(extension);
}

function imageFilesFromClipboard(clipboardData) {
  if (!clipboardData?.items) return [];
  return [...clipboardData.items]
    .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
    .map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      const extension = imageExtensionForType(file.type) || "png";
      return file.name
        ? file
        : new File([file], `pasted-image-${Date.now()}-${index + 1}.${extension}`, { type: file.type || "image/png" });
    })
    .filter(Boolean);
}

function imageExtensionForType(type) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/png") return "png";
  return "";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`读取 ${file.name || "图片"} 失败`));
    reader.readAsDataURL(file);
  });
}

function renderAttachments() {
  els.attachmentList.classList.toggle("has-files", state.attachments.length > 0);
  els.attachmentList.innerHTML = state.attachments.map((file, index) => attachmentChipHtml(file, index)).join("");
  els.attachmentList.querySelectorAll("[data-attachment-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.attachments.splice(Number(button.dataset.attachmentIndex), 1);
      renderAttachments();
    });
  });
}

function attachmentChipHtml(file, index) {
  if (file.kind === "image") {
    return `
      <span class="attachment-chip image">
        <img class="attachment-thumb" src="${escapeAttribute(file.dataUrl)}" alt="">
        <span class="attachment-meta">
          <span class="attachment-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span>${escapeHtml(formatBytes(file.size))}</span>
        </span>
        <button class="attachment-remove" data-attachment-index="${index}" title="移除附件">x</button>
      </span>
    `;
  }
  return `
    <span class="attachment-chip">
      <span class="attachment-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span>${escapeHtml(formatBytes(file.size))}</span>
      <button class="attachment-remove" data-attachment-index="${index}" title="移除附件">x</button>
    </span>
  `;
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

function buildTaskPrompt(userPrompt) {
  const prompt = userPrompt.trim();
  if (!prompt && state.attachments.length === 0) {
    return "";
  }
  const head = prompt || "请阅读附件内容，并按附件中的要求执行。";
  const blocks = textAttachments().map((file) => {
    const fence = markdownFenceFor(file.text);
    return [
      `附件: ${file.name}`,
      `类型: ${file.type || "text/plain"}`,
      `大小: ${formatBytes(file.size)}`,
      "",
      fence,
      file.text,
      fence,
    ].join("\n");
  });
  return blocks.length ? `${head}\n\n${blocks.join("\n\n")}` : head;
}

function buildTaskInput(userPrompt) {
  const images = imageAttachments();
  if (!images.length) {
    return null;
  }
  const text = buildTaskPrompt(userPrompt);
  return [{
    role: "user",
    content: [
      ...images.map((image) => ({
        type: "input_image",
        image_url: image.dataUrl,
      })),
      {
        type: "input_text",
        text,
      },
    ],
  }];
}

function visibleUserPrompt(userPrompt) {
  const prompt = userPrompt.trim() || "请阅读附件内容，并按附件中的要求执行。";
  if (!state.attachments.length) {
    return prompt;
  }
  const fileList = state.attachments.map((file) => {
    const label = file.kind === "image" ? "图片" : "附件";
    return `- ${label}: ${file.name} (${formatBytes(file.size)})`;
  }).join("\n");
  return `${prompt}\n\n已附加文件:\n${fileList}`;
}

function textAttachments() {
  return state.attachments.filter((file) => file.kind !== "image");
}

function imageAttachments() {
  return state.attachments.filter((file) => file.kind === "image");
}

function markdownFenceFor(text) {
  const matches = String(text).match(/`{3,}/g) || [];
  const longest = matches.reduce((max, item) => Math.max(max, item.length), 2);
  return "`".repeat(longest + 1);
}

function fileExtension(name) {
  const match = String(name || "").toLowerCase().match(/\.([^.]+)$/);
  return match?.[1] || "";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderSidebar() {
  if (!state.conversations.length) {
    els.taskList.innerHTML = `<div class="nav-item">暂无历史会话</div>`;
    return;
  }

  const groups = new Map();
  for (const conversation of state.conversations) {
    const project = basename(conversation.workspacePath || "unknown");
    if (!groups.has(project)) {
      groups.set(project, []);
    }
    groups.get(project).push(conversation);
  }

  els.taskList.innerHTML = [...groups.entries()].map(([project, conversations]) => `
    <div class="project-group">
      <div class="project-header" data-project="${escapeHtml(project)}">
        <span class="project-chevron">▾</span>
        <span class="item-title">${escapeHtml(project)}</span>
      </div>
      <div class="project-sessions">
        ${conversations.map((conversation) => sidebarTaskHtml(conversation)).join("")}
      </div>
    </div>
  `).join("");

  els.taskList.querySelectorAll(".project-header").forEach((header) => {
    header.addEventListener("click", () => {
      const sessions = header.parentElement.querySelector(".project-sessions");
      sessions.classList.toggle("collapsed");
      header.querySelector(".project-chevron").textContent = sessions.classList.contains("collapsed") ? "▸" : "▾";
    });
  });
  els.taskList.querySelectorAll(".sidebar-item").forEach((item) => {
    item.addEventListener("click", () => selectConversation(item.dataset.conversationId));
  });
}

function sidebarTaskHtml(conversation) {
  const active = state.activeConversation?.id === conversation.id ? " active" : "";
  const liveStatus = conversation.lastTaskStatus || conversation.status;
  let indicator = "";
  if (liveStatus === "queued") {
    indicator = `<span class="active-dot queued" title="排队中"></span>`;
  } else if (liveStatus === "running" || liveStatus === "starting") {
    indicator = `<span class="active-ellipsis" title="运行中">...</span>`;
  } else if (isUnreadCompletedConversation(conversation)) {
    indicator = `<span class="active-dot unread-complete" title="有新的完成结果"></span>`;
  }
  return `
    <div class="sidebar-item${active}" data-conversation-id="${escapeHtml(conversation.id)}">
      <span class="item-title">${escapeHtml(conversationTitle(conversation))}</span>
      ${indicator || `<span class="item-meta">${escapeHtml(relativeTime(conversation.updatedAt || conversation.createdAt))}</span>`}
    </div>
  `;
}

async function selectTask(taskId) {
  closeStream();
  try {
    const [artifact, diff] = await Promise.all([
      apiJson(`/v1/tasks/${encodeURIComponent(taskId)}/artifact`),
      apiJson(`/v1/tasks/${encodeURIComponent(taskId)}/diff`).catch(() => null)
    ]);
    state.activeArtifact = artifact;
    state.activeDiff = diff;
    renderTask();
    renderSidebar();
    if (isRunning(artifact.status)) {
      openStream(taskId);
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function selectConversation(conversationId) {
  closeStream();
  try {
    const conversation = await apiJson(`/v1/conversations/${encodeURIComponent(conversationId)}`);
    const tasks = conversation.tasks || [];
    const artifact = tasks.at(-1) || null;
    const diff = artifact
      ? await apiJson(`/v1/tasks/${encodeURIComponent(artifact.id)}/diff`).catch(() => null)
      : null;
    state.activeConversation = conversation;
    state.activeArtifact = artifact;
    state.activeDiff = diff;
    markConversationSeen(conversation);
    if (conversation.workspacePath) {
      setWorkspace(conversation.workspacePath, {
        saveRecent: false,
        persist: false,
        force: true
      });
    }
    renderTask();
    renderSidebar();
    if (artifact && isRunning(artifact.status)) {
      openStream(artifact.id);
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function sendTask() {
  if (state.isSubmitting) return;
  const previousInputValue = els.inputBox.value;
  const previousAttachments = [...state.attachments];
  const userPrompt = previousInputValue.trim();
  const prompt = buildTaskPrompt(userPrompt);
  const input = buildTaskInput(userPrompt);
  const workspacePath = activeWorkspacePath();
  if (!prompt) return;
  if (!workspacePath) {
    showToast("先填 workspace 路径");
    return;
  }
  if (!els.providerSelect.value || !els.modelInput.value.trim()) {
    showToast("模型服务或模型不可用，刷新后重试");
    return;
  }

  const conversationId = state.activeConversation?.id || state.activeArtifact?.conversationId || null;
  const visiblePrompt = visibleUserPrompt(userPrompt);
  let taskCreated = false;

  state.isSubmitting = true;
  closeStream();
  const optimisticArtifact = {
    id: "pending",
    conversationId,
    createdAt: new Date().toISOString(),
    status: "starting",
    provider: els.providerSelect.value,
    model: els.modelInput.value.trim(),
    workspacePath,
    request: { prompt: visiblePrompt },
    events: [{
      id: "local-user",
      ts: new Date().toISOString(),
      type: "item.completed",
      params: { item: { type: "userMessage", content: [{ type: "text", text: visiblePrompt }] } }
    }]
  };
  state.activeArtifact = optimisticArtifact;
  state.activeDiff = null;
  if (conversationId && state.activeConversation) {
    state.activeConversation = {
      ...state.activeConversation,
      tasks: [...(state.activeConversation.tasks || []), optimisticArtifact]
    };
  }
  renderTask();
  scrollMessagesToBottom();
  els.inputBox.value = "";
  clearAttachments();
  autoResize(els.inputBox);
  updateButtons();

  try {
    const endpoint = conversationId
      ? `/v1/conversations/${encodeURIComponent(conversationId)}/turns`
      : "/v1/tasks";
    const created = await apiJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspacePath,
        provider: els.providerSelect.value,
        model: els.modelInput.value.trim(),
        prompt,
        ...(input ? { input } : {}),
        approvalPolicy: els.approvalSelect.value,
        sandbox: "danger-full-access",
        networkAccess: true
      })
    });
    taskCreated = true;
    const artifact = await apiJson(created.artifactUrl);
    state.activeArtifact = artifact;
    state.activeDiff = null;
    state.isSubmitting = false;
    if (created.conversationId) {
      state.activeConversation = await apiJson(`/v1/conversations/${encodeURIComponent(created.conversationId)}`);
    }
    renderTask();
    openStream(created.taskId);
    await loadTasks();
  } catch (error) {
    if (!taskCreated) {
      els.inputBox.value = previousInputValue;
      state.attachments = previousAttachments;
      renderAttachments();
      autoResize(els.inputBox);
    }
    optimisticArtifact.status = "failed";
    optimisticArtifact.error = error.message;
    state.activeArtifact = optimisticArtifact;
    renderTask();
    showToast(error.message);
  } finally {
    state.isSubmitting = false;
    updateButtons();
  }
}

async function cancelActiveTask() {
  const id = state.activeArtifact?.id;
  if (!canCancelActiveTask()) return;
  try {
    await apiJson(`/v1/tasks/${encodeURIComponent(id)}/interrupt`, { method: "POST" });
    showToast("已发送取消请求");
  } catch (error) {
    showToast(error.message);
  }
}

function openStream(taskId) {
  closeStream();
  const source = new EventSource(`/v1/tasks/${encodeURIComponent(taskId)}/events`);
  state.eventSource = source;
  const handleEvent = async (message) => {
    const event = JSON.parse(message.data);
    if (!state.activeArtifact || state.activeArtifact.id !== taskId) return;
    const existing = new Set((state.activeArtifact.events || []).map((item) => item.id));
    if (!existing.has(event.id)) {
      state.activeArtifact.events = [...(state.activeArtifact.events || []), event];
    }
    mergeServerRequestFromEvent(state.activeArtifact, event);
    if (event.type === "task.started") {
      state.activeArtifact.status = "starting";
      state.activeArtifact.queuePosition = null;
      updateActiveConversationTask(state.activeArtifact);
      scheduleRenderTask();
      return;
    }
    if (event.type === "task.completed" || event.type === "task.failed" || event.type === "task.interrupted" || event.type === "turn.completed") {
      const [artifact, diff] = await Promise.all([
        apiJson(`/v1/tasks/${encodeURIComponent(taskId)}/artifact`),
        apiJson(`/v1/tasks/${encodeURIComponent(taskId)}/diff`).catch(() => null)
      ]);
      state.activeArtifact = artifact;
      state.activeDiff = diff;
      if (artifact.conversationId) {
        state.activeConversation = await apiJson(`/v1/conversations/${encodeURIComponent(artifact.conversationId)}`);
        markConversationSeen(state.activeConversation);
      }
      closeStream();
      await loadTasks();
      renderTask();
    } else {
      updateActiveConversationTask(state.activeArtifact);
      scheduleRenderTask();
    }
  };
  for (const eventType of STREAM_EVENT_TYPES) {
    source.addEventListener(eventType, handleEvent);
  }
  source.onerror = () => {
    if (!state.activeArtifact || !isRunning(state.activeArtifact.status)) {
      closeStream();
    }
  };
}

function scheduleRenderTask() {
  if (state.renderTaskTimer) return;
  state.renderTaskTimer = window.setTimeout(() => {
    state.renderTaskTimer = null;
    renderTask();
  }, 120);
}

function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (state.renderTaskTimer) {
    window.clearTimeout(state.renderTaskTimer);
    state.renderTaskTimer = null;
  }
}

function renderTask() {
  const artifact = state.activeArtifact;
  if (!artifact) {
    renderEmpty();
    return;
  }
  setNewChatMode(false);
  renderWorkspacePicker();
  const conversation = state.activeConversation;
  const tasks = conversation?.tasks?.length ? conversation.tasks : [artifact];
  const latestTask = tasks.at(-1) || artifact;
  const title = conversation ? conversationTitle(conversation) : taskTitle(latestTask);
  if (conversation) {
    markConversationSeen(conversation);
  }
  if (!state.environmentDiagnostics && latestTask.environmentDiagnostics) {
    state.environmentDiagnostics = latestTask.environmentDiagnostics;
  }
  els.sessionTitle.textContent = title;
  els.sessionMeta.textContent = `${basename(latestTask.workspacePath || "")} · ${latestTask.provider || "provider"} · ${latestTask.model || "model"}`;
  setStatus(latestTask.status);
  updateButtons();
  renderDiagnosticsPanel();

  const diffCards = parseDiffCards(state.activeDiff?.diff || "");

  els.messages.innerHTML = tasks.map((task) => taskMessageHtml(task, task.id === latestTask.id, diffCards, state.activeDiff)).join("");

  els.messages.querySelectorAll(".tool-block").forEach((block) => {
    block.querySelector(".tool-header").addEventListener("click", () => block.classList.toggle("expanded"));
  });
  els.messages.querySelectorAll("[data-server-request]").forEach((button) => {
    button.addEventListener("click", () => resolveServerRequest(button));
  });
  els.messages.querySelectorAll("[data-file-action]").forEach((button) => {
    button.addEventListener("click", () => handleFileAction(button));
  });
  els.messages.querySelectorAll("[data-copy-text]").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(button.dataset.copyText || "");
      showToast("已复制");
    });
  });
  scrollMessagesToBottom();
}

function taskMessageHtml(task, isLatest, diffCards, diff) {
  const events = task.events || [];
  const userText = userPromptFromArtifact(task);
  const terminal = isTerminalStatus(task.status);
  const rawFinalText = task.finalMessage || (task.status === "failed" ? `任务失败：${errorText(task.error) || "unknown error"}` : null);
  const timeline = liveTimelineFromEvents(events, task);
  const finalAssistant = finalAssistantFromTimeline(timeline);
  const finalText = rawFinalText || (terminal ? finalAssistant?.text : null);
  const processTimeline = terminal ? timelineWithoutFinalAnswer(timeline, finalText) : timeline;
  const showFallbackFinal = !terminal && finalText && !timelineContainsText(timeline, finalText);
  const showFallbackActivity = !timeline.length && (isRunning(task.status) || events.some((event) => eventLabel(event)));
  const resources = terminal ? resourcesFromText(finalText || timelineText(timeline), task) : [];
  const terminalBody = terminal ? `
        ${resultSummaryHtml(task, finalText)}
        ${resourceCardsHtml(resources, task)}
        ${isLatest ? diffSummaryHtml(diffCards, diff) : ""}
        ${isLatest ? diffCards.slice(0, 6).map(diffCardHtml).join("") : ""}
        ${processPanelHtml(processTimeline, task, activityFromEvents(events, task))}
        ${artifactHtml(task)}
        ${reactionBarHtml(task, finalText)}
  ` : `
        ${agentStatusHtml(task)}
        ${pendingApprovalsHtml(task)}
        ${liveTimelineHtml(timeline, task)}
        ${showFallbackFinal ? `<div class="msg-content">${renderMarkdown(finalText, task)}</div>` : ""}
        ${showFallbackActivity ? activityHtml(activityFromEvents(events, task), task) : ""}
        ${isLatest ? diffSummaryHtml(diffCards, diff) : ""}
        ${isLatest ? diffCards.slice(0, 6).map(diffCardHtml).join("") : ""}
        ${artifactHtml(task)}
        ${reactionBarHtml(task, finalText)}
  `;
  return `
    <div class="message">
      <div class="message-user">${escapeHtml(userText || "新任务")}</div>
    </div>
    <div class="message">
      <div class="message-agent">
        ${terminalBody}
      </div>
    </div>
  `;
}

function finalAssistantFromTimeline(timeline) {
  return [...timeline].reverse().find((item) => item.kind === "assistant" && item.phase === "final_answer" && String(item.text || "").trim());
}

function timelineWithoutFinalAnswer(timeline, finalText) {
  const normalizedFinal = normalizeComparableText(finalText);
  return timeline.filter((item) => {
    if (item.kind !== "assistant" || item.phase !== "final_answer") {
      return true;
    }
    const normalizedItem = normalizeComparableText(item.text);
    if (!normalizedItem) {
      return false;
    }
    return !(normalizedFinal && (normalizedFinal.includes(normalizedItem) || normalizedItem.includes(normalizedFinal)));
  });
}

function timelineText(timeline) {
  return timeline
    .filter((item) => item.kind === "assistant" || item.kind === "reasoning" || item.kind === "notice")
    .map((item) => item.text || "")
    .join("\n");
}

function resultSummaryHtml(task, finalText) {
  const text = finalText || (task.status === "failed" ? `任务失败：${errorText(task.error) || "unknown error"}` : "");
  if (!text) return "";
  const failed = task.status === "failed";
  return `
    <section class="result-section${failed ? " failed" : ""}">
      <div class="section-title">${failed ? "任务失败" : "最终结果"}</div>
      <div class="msg-content">${renderMarkdown(text, task)}</div>
    </section>
  `;
}

function processPanelHtml(timeline, task, activity) {
  const timelineHtml = timeline.length ? liveTimelineHtml(timeline, task) : "";
  const activityHtmlBody = !timeline.length && activity.length
    ? `<div class="tool-steps">${activity.map(stepHtml).join("")}</div>`
    : "";
  const body = timelineHtml || activityHtmlBody;
  if (!body) return "";
  const count = timeline.length || activity.length;
  const failed = task.status === "failed";
  return `
    <div class="tool-block process-panel${failed ? " failed" : ""}">
      <div class="tool-header">
        <span class="tool-label">${failed ? "执行过程" : "执行过程"} ${count} 项</span>
        <span class="tool-chevron">▶</span>
      </div>
      <div class="tool-body">
        ${body}
      </div>
    </div>
  `;
}

function renderEmpty() {
  setNewChatMode(true);
  renderWorkspacePicker();
  els.sessionTitle.textContent = "新任务";
  els.sessionMeta.textContent = "本地运行时";
  setStatus("idle");
  updateButtons();
  renderDiagnosticsPanel();
  els.messages.innerHTML = "";
}

function setNewChatMode(enabled) {
  els.main.classList.toggle("new-chat", enabled);
}

function agentStatusHtml(artifact) {
  if (artifact.status === "failed") {
    return `<div class="msg-content"><p>任务没有完成，我把错误和运行过程留在下面。</p></div>`;
  }
  if (!isRunning(artifact.status)) {
    return "";
  }
  const label = runningLabel(artifact);
  return `<div class="agent-status-line"><span class="thinking-dot"></span>${escapeHtml(label)}</div>`;
}

function activityHtml(activity, artifact) {
  if (!activity.length && !isRunning(artifact.status)) return "";
  const expanded = isRunning(artifact.status) ? " expanded" : "";
  const label = isRunning(artifact.status)
    ? `运行过程 ${activity.length} 个事件`
    : `已处理 ${activity.length} 个事件`;
  return `
    <div class="tool-block${expanded}">
      <div class="tool-header">
        <span class="tool-label">${escapeHtml(label)}</span>
        <span class="tool-chevron">▶</span>
      </div>
      <div class="tool-body">
        ${activity.length ? activity.map(stepHtml).join("") : `<div class="tool-step"><span class="step-status pending"></span>等待 runtime 事件...</div>`}
      </div>
    </div>
  `;
}

function reactionBarHtml(task, finalText) {
  if (!isTerminalStatus(task.status)) return "";
  const copyText = finalText || errorText(task.error) || "";
  const retry = task.status === "failed" ? `<button class="reaction-btn" title="重试">↺</button>` : "";
  return `
    <div class="reaction-bar">
      ${retry}
      ${copyText ? `<button class="reaction-btn" data-copy-text="${escapeHtml(copyText)}" title="复制">⧉</button>` : ""}
      ${task.status === "completed" ? `<button class="reaction-btn" title="赞">赞</button><button class="reaction-btn" title="踩">踩</button><button class="reaction-btn" title="分享">↗</button>` : ""}
      <span class="timestamp">${escapeHtml(timeOf(task.finishedAt || task.createdAt))}</span>
    </div>
  `;
}

function stepHtml(step) {
  return `<div class="tool-step"><span class="step-status ${escapeHtml(step.status)}"></span>${escapeHtml(step.text)}</div>`;
}

function liveTimelineFromEvents(events, artifact) {
  const timeline = [];
  const byKey = new Map();

  const upsert = (key, create, update) => {
    let item = byKey.get(key);
    if (!item) {
      item = create();
      byKey.set(key, item);
      timeline.push(item);
    }
    update?.(item);
    return item;
  };

  for (const event of events) {
    const params = event.params || {};
    const item = params.item;
    const itemId = params.itemId || item?.id || event.id;

    if (event.type === "item.agentMessage.delta") {
      const delta = String(params.delta || "");
      if (!delta) continue;
      upsert(`assistant:${itemId}`, () => ({
        kind: "assistant",
        key: `assistant:${itemId}`,
        phase: "commentary",
        text: "",
        status: isRunning(artifact.status) ? "pending" : "completed",
      }), (entry) => {
        entry.text += delta;
        entry.status = isRunning(artifact.status) ? "pending" : "completed";
      });
      continue;
    }

    if (event.type === "item.reasoning.summaryTextDelta") {
      const delta = String(params.delta || "");
      if (!delta) continue;
      upsert(`reasoning:${itemId}:${params.summaryIndex ?? 0}`, () => ({
        kind: "reasoning",
        key: `reasoning:${itemId}:${params.summaryIndex ?? 0}`,
        text: "",
        status: "pending",
      }), (entry) => {
        entry.text += delta;
      });
      continue;
    }

    if (event.type === "item.reasoning.summaryPartAdded") {
      upsert(`reasoning-break:${event.id}`, () => ({
        kind: "reasoning",
        key: `reasoning-break:${event.id}`,
        text: "",
        status: "completed",
      }));
      continue;
    }

    if (event.type === "item.commandExecution.outputDelta") {
      upsert(`command:${itemId}`, () => ({
        kind: "command",
        key: `command:${itemId}`,
        command: "命令执行中",
        output: "",
        status: "pending",
      }), (entry) => {
        entry.output = `${entry.output || ""}${params.delta || ""}`;
      });
      continue;
    }

    if (event.type === "item.fileChange.patchUpdated") {
      upsert(`file:${itemId}`, () => ({
        kind: "file",
        key: `file:${itemId}`,
        changes: [],
        status: "pending",
      }), (entry) => {
        entry.changes = params.changes || entry.changes || [];
      });
      continue;
    }

    if (event.type === "item.mcpToolCall.progress") {
      upsert(`tool:${itemId}`, () => ({
        kind: "tool",
        key: `tool:${itemId}`,
        tool: "MCP 工具",
        server: "",
        progress: [],
        status: "pending",
      }), (entry) => {
        if (params.message) {
          entry.progress = [...(entry.progress || []), String(params.message)];
        }
      });
      continue;
    }

    if (event.type === "runtime.error" || event.type === "runtime.warning" || event.type === "task.failed") {
      const message = errorText(params.error) || errorText(params.message) || errorText(artifact.error);
      if (message) {
        timeline.push({
          kind: "notice",
          key: `notice:${event.id}`,
          text: message,
          status: event.type === "runtime.warning" ? "warning" : "failed",
        });
      }
      continue;
    }

    if (event.type === "task.continuation.started") {
      timeline.push({
        kind: "notice",
        key: `continuation:${event.id}`,
        text: "检测到任务未完成，继续推进。",
        status: "info",
      });
      continue;
    }

    if (event.type !== "item.started" && event.type !== "item.completed") {
      continue;
    }

    if (!item || item.type === "userMessage") {
      continue;
    }

    if (item.type === "agentMessage") {
      const text = String(item.text || "");
      if (!text) continue;
      upsert(`assistant:${item.id || itemId}`, () => ({
        kind: "assistant",
        key: `assistant:${item.id || itemId}`,
        phase: item.phase || "final_answer",
        text: "",
        status: "completed",
      }), (entry) => {
        entry.text = text.length >= entry.text.length ? text : entry.text;
        entry.phase = item.phase || entry.phase || "final_answer";
        entry.status = "completed";
      });
      continue;
    }

    if (item.type === "reasoning") {
      const text = [...(item.summary || []), ...(item.content || [])].filter(Boolean).join("\n\n");
      if (text) {
        upsert(`reasoning:${item.id || itemId}:completed`, () => ({
          kind: "reasoning",
          key: `reasoning:${item.id || itemId}:completed`,
          text,
          status: "completed",
        }), (entry) => {
          entry.text = text;
          entry.status = "completed";
        });
      }
      continue;
    }

    if (item.type === "commandExecution") {
      upsert(`command:${item.id || itemId}`, () => ({
        kind: "command",
        key: `command:${item.id || itemId}`,
        command: item.command || "",
        cwd: item.cwd,
        output: "",
        status: "pending",
      }), (entry) => {
        entry.command = item.command || entry.command || "";
        entry.cwd = item.cwd || entry.cwd;
        entry.output = item.aggregatedOutput || item.aggregated_output || entry.output || "";
        entry.exitCode = item.exitCode ?? item.exit_code ?? entry.exitCode;
        entry.durationMs = item.durationMs ?? item.duration_ms ?? entry.durationMs;
        entry.status = statusFromToolStatus(item.status, entry.exitCode);
      });
      continue;
    }

    if (item.type === "fileChange") {
      upsert(`file:${item.id || itemId}`, () => ({
        kind: "file",
        key: `file:${item.id || itemId}`,
        changes: [],
        status: "pending",
      }), (entry) => {
        entry.changes = item.changes || entry.changes || [];
        entry.status = statusFromToolStatus(item.status);
      });
      continue;
    }

    if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
      upsert(`tool:${item.id || itemId}`, () => ({
        kind: "tool",
        key: `tool:${item.id || itemId}`,
        tool: item.tool || "工具",
        server: item.server || item.namespace || "",
        arguments: item.arguments,
        result: null,
        error: null,
        status: "pending",
        progress: [],
      }), (entry) => {
        entry.tool = item.tool || entry.tool;
        entry.server = item.server || item.namespace || entry.server;
        entry.arguments = item.arguments ?? entry.arguments;
        entry.result = item.result ?? item.contentItems ?? item.content_items ?? entry.result;
        entry.error = item.error ?? entry.error;
        entry.durationMs = item.durationMs ?? item.duration_ms ?? entry.durationMs;
        entry.status = statusFromToolStatus(item.status, item.error ? 1 : 0);
      });
      continue;
    }

    if (item.type === "webSearch") {
      upsert(`web:${item.id || itemId}`, () => ({
        kind: "tool",
        key: `web:${item.id || itemId}`,
        tool: "web search",
        server: "",
        arguments: item.query,
        result: item.action,
        status: "completed",
      }));
      continue;
    }

    timeline.push({
      kind: "tool",
      key: `item:${item.id || itemId}`,
      tool: item.type,
      status: event.type === "item.started" ? "pending" : "completed",
    });
  }

  return timeline.filter((item) => {
    if (item.kind === "assistant" || item.kind === "reasoning" || item.kind === "notice") {
      return Boolean(String(item.text || "").trim());
    }
    return true;
  }).slice(-120);
}

function liveTimelineHtml(timeline, task) {
  if (!timeline.length) return "";
  return `<div class="live-timeline">${timeline.map((item) => liveTimelineItemHtml(item, task)).join("")}</div>`;
}

function liveTimelineItemHtml(item, task) {
  if (item.kind === "assistant") {
    const phaseClass = item.phase === "final_answer" ? "final-answer" : "commentary";
    return `<div class="live-assistant msg-content ${phaseClass}">${renderMarkdown(item.text, task)}</div>`;
  }
  if (item.kind === "reasoning") {
    return `<div class="live-reasoning">${renderMarkdown(item.text)}</div>`;
  }
  if (item.kind === "notice") {
    const failed = item.status === "failed";
    const warning = item.status === "warning";
    return liveToolHtml({
      ...item,
      icon: failed ? "x" : warning ? "!" : "i",
      title: failed ? `运行错误：${item.text}` : `运行提示：${item.text}`,
      detail: item.text,
    });
  }
  if (item.kind === "command") {
    return liveToolHtml(commandTimelineView(item));
  }
  if (item.kind === "file") {
    return liveToolHtml(fileTimelineView(item));
  }
  return liveToolHtml(toolTimelineView(item));
}

function liveToolHtml(view) {
  const status = view.status || "";
  const copyButton = view.copyText ? `
    <button class="live-tool-copy" type="button" data-copy-text="${escapeAttribute(view.copyText)}" title="复制完整命令">复制</button>
  ` : "";
  const detail = view.detailHtml ? `
    <details class="live-tool-detail">
      <summary>${escapeHtml(view.detailLabel || "查看详情")}</summary>
      ${view.detailHtml}
    </details>
  ` : view.detail ? `
    <details class="live-tool-detail">
      <summary>${escapeHtml(view.detailLabel || "查看详情")}</summary>
      <pre>${escapeHtml(limitText(view.detail, 6000))}</pre>
    </details>
  ` : "";
  return `
    <div class="live-tool ${escapeHtml(status)}">
      <div class="live-tool-line">
        <span class="live-tool-icon">${escapeHtml(view.icon || "·")}</span>
        <span class="live-tool-title" title="${escapeAttribute(view.title || "")}">${escapeHtml(view.title || "")}</span>
        ${copyButton}
      </div>
      ${detail}
    </div>
  `;
}

function commandTimelineView(item) {
  const command = item.command || "命令";
  const duration = item.durationMs ? ` · ${formatDurationMs(item.durationMs)}` : "";
  const title = item.status === "pending"
    ? `正在运行 ${command}`
    : item.status === "failed"
      ? `命令失败 ${command}${duration}`
      : `已运行 1 条命令 ${command}${duration}`;
  return {
    status: item.status,
    icon: "$",
    title,
    detailHtml: commandDetailHtml(item, command),
    detailLabel: "查看命令详情",
    copyText: command,
  };
}

function commandDetailHtml(item, command) {
  const metadata = [
    item.cwd ? ["目录", item.cwd] : null,
    item.exitCode != null ? ["退出码", String(item.exitCode)] : null,
    item.durationMs ? ["耗时", formatDurationMs(item.durationMs)] : null,
  ].filter(Boolean);
  const output = String(item.output || "").trim();
  return `
    <div class="command-detail">
      <div class="command-detail-label">完整命令</div>
      <pre class="command-detail-command">${escapeHtml(command)}</pre>
      ${metadata.length ? `
        <div class="command-detail-grid">
          ${metadata.map(([label, value]) => `
            <div class="command-detail-key">${escapeHtml(label)}</div>
            <div class="command-detail-value">${escapeHtml(value)}</div>
          `).join("")}
        </div>
      ` : ""}
      ${output ? `
        <div class="command-detail-label">命令输出</div>
        <pre>${escapeHtml(limitText(output, 6000))}</pre>
      ` : ""}
    </div>
  `;
}

function fileTimelineView(item) {
  const changes = item.changes || [];
  const files = uniqueStrings(changes.map((change) => change.path || change.file || change.filePath).filter(Boolean));
  const stats = changes.reduce((acc, change) => {
    const diff = String(change.diff || "");
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith("+") && !line.startsWith("+++")) acc.adds += 1;
      if (line.startsWith("-") && !line.startsWith("---")) acc.removes += 1;
    }
    return acc;
  }, { adds: 0, removes: 0 });
  const count = files.length || changes.length || 1;
  const verb = item.status === "pending" ? "正在编辑" : item.status === "failed" ? "编辑失败" : "已编辑";
  const statsText = stats.adds || stats.removes ? ` +${stats.adds} -${stats.removes}` : "";
  return {
    status: item.status,
    icon: "D",
    title: `${verb} ${count} 个文件${statsText}`,
    detail: files.length ? files.join("\n") : "",
    detailLabel: "文件列表",
  };
}

function toolTimelineView(item) {
  const name = [item.server, item.tool].filter(Boolean).join(".");
  const duration = item.durationMs ? ` · ${formatDurationMs(item.durationMs)}` : "";
  const title = item.status === "pending"
    ? `正在调用 ${name || "工具"}`
    : item.status === "failed"
      ? `工具调用失败 ${name || "工具"}${duration}`
      : `已调用 ${name || "工具"}${duration}`;
  const detailParts = [];
  if (item.progress?.length) detailParts.push(item.progress.join("\n"));
  if (item.arguments != null) detailParts.push(`arguments:\n${formatJsonLike(item.arguments)}`);
  if (item.result != null) detailParts.push(`result:\n${formatJsonLike(item.result)}`);
  if (item.error) detailParts.push(`error:\n${errorText(item.error)}`);
  return {
    status: item.status,
    icon: "◇",
    title,
    detail: detailParts.join("\n\n"),
    detailLabel: "工具详情",
  };
}

function timelineContainsText(timeline, text) {
  const normalized = normalizeComparableText(text);
  if (!normalized) return false;
  return timeline
    .filter((item) => item.kind === "assistant")
    .some((item) => normalizeComparableText(item.text).includes(normalized) || normalized.includes(normalizeComparableText(item.text)));
}

function normalizeComparableText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function statusFromToolStatus(status, exitCode) {
  if (status === "inProgress" || status === "running" || status === "pending") return "pending";
  if (status === "failed" || status === "declined" || (Number.isInteger(exitCode) && exitCode !== 0)) return "failed";
  return "completed";
}

function formatJsonLike(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function limitText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n... truncated ${text.length - maxLength} chars`;
}

function formatDurationMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function diffSummaryHtml(cards, diff) {
  if (!diff) return "";
  if (!cards.length) {
    return `
      <div class="change-summary">
        <div class="change-info">
          <span class="change-icon">D</span>
          <div>
            <div class="change-text">未检测到 git diff</div>
            <div class="change-stats">${escapeHtml(diff.reason || "workspace 当前没有未提交变更")}</div>
          </div>
        </div>
      </div>
    `;
  }
  const adds = cards.reduce((sum, card) => sum + card.adds, 0);
  const removes = cards.reduce((sum, card) => sum + card.removes, 0);
  return `
    <div class="change-summary">
      <div class="change-info">
        <span class="change-icon">D</span>
        <div>
          <div class="change-text">已检测到 ${cards.length} 个文件变更</div>
          <div class="change-stats"><span class="stat-add">+${adds}</span> <span class="stat-remove">-${removes}</span></div>
        </div>
      </div>
      <div class="change-actions">
        <span class="action-link">查看</span>
      </div>
    </div>
  `;
}

function diffCardHtml(card) {
  const lines = card.lines.slice(0, 220).map((line) => {
    const klass = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : line.startsWith("@@") || line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file") ? "meta" : "";
    return `<span class="diff-line ${klass}">${escapeHtml(line || " ")}</span>`;
  }).join("");
  return `
    <div class="diff-card">
      <div class="diff-card-header">
        <span class="diff-file">${escapeHtml(card.file)}</span>
        <span class="diff-stats"><span class="stat-add">+${card.adds}</span> <span class="stat-remove">-${card.removes}</span></span>
      </div>
      <div class="diff-content">${lines}</div>
    </div>
  `;
}

function pendingApprovalsHtml(task) {
  const requests = pendingServerRequests(task);
  if (!requests.length) return "";
  return requests.map((request) => approvalCardHtml(task, request)).join("");
}

function pendingServerRequests(task) {
  const byId = new Map();
  for (const request of task.serverRequests || []) {
    byId.set(String(request.id), { ...request, id: String(request.id) });
  }
  for (const event of task.events || []) {
    const requestId = event.params?.serverRequestId;
    if (isApprovalRequestEvent(event) && requestId) {
      const params = { ...(event.params || {}) };
      delete params.serverRequestId;
      byId.set(String(requestId), {
        id: String(requestId),
        method: event.rawMethod || event.type.replaceAll(".", "/"),
        params,
        status: "pending",
        createdAt: event.ts
      });
    }
    if ((event.type === "serverRequest.response.sent" || event.type === "serverRequest.rejected") && event.params?.requestId) {
      const existing = byId.get(String(event.params.requestId));
      if (existing) {
        existing.status = event.type === "serverRequest.rejected" ? "rejected" : "resolved";
        existing.resolvedAt = event.ts;
      }
    }
  }
  return [...byId.values()].filter((request) => request.status === "pending");
}

function approvalCardHtml(task, request) {
  return `
    <div class="approval-card" data-request-card data-method="${escapeHtml(request.method)}">
      <div class="approval-header">
        <span class="approval-title">${escapeHtml(approvalTitle(request))}</span>
        <span class="approval-method">${escapeHtml(shortMethod(request.method))}</span>
      </div>
      <div class="approval-body">
        ${approvalBodyHtml(request)}
        <details class="raw-artifact" style="margin-top:10px;">
          <summary>原始请求</summary>
          <pre>${escapeHtml(JSON.stringify(request.params || {}, null, 2))}</pre>
        </details>
      </div>
      <div class="approval-actions">
        ${approvalButtonsHtml(task, request)}
      </div>
    </div>
  `;
}

function approvalTitle(request) {
  if (request.method === "item/commandExecution/requestApproval") return "需要确认命令执行";
  if (request.method === "item/fileChange/requestApproval") return "需要确认文件变更";
  if (request.method === "item/permissions/requestApproval") return "需要确认权限变更";
  if (request.method === "item/tool/requestUserInput") return "工具请求用户输入";
  if (request.method === "mcpServer/elicitation/request") return "插件请求确认";
  return "需要用户确认";
}

function approvalBodyHtml(request) {
  const params = request.params || {};
  if (request.method === "item/commandExecution/requestApproval") {
    const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
    return `
      ${params.reason ? `<div>${formatMessage(params.reason)}</div>` : ""}
      ${command ? `<div>命令：<code>${escapeHtml(command)}</code></div>` : ""}
      ${params.cwd ? `<div>目录：<code>${escapeHtml(params.cwd)}</code></div>` : ""}
    `;
  }
  if (request.method === "item/fileChange/requestApproval") {
    return `
      ${params.reason ? `<div>${formatMessage(params.reason)}</div>` : ""}
      ${params.grantRoot ? `<div>范围：<code>${escapeHtml(params.grantRoot)}</code></div>` : ""}
      ${params.itemId ? `<div>item：<code>${escapeHtml(params.itemId)}</code></div>` : ""}
    `;
  }
  if (request.method === "item/permissions/requestApproval") {
    const defaultResult = {
      permissions: params.permissions || {},
      scope: "turn",
      strictAutoReview: null
    };
    return `
      ${params.reason ? `<div>${formatMessage(params.reason)}</div>` : ""}
      ${params.cwd ? `<div>目录：<code>${escapeHtml(params.cwd)}</code></div>` : ""}
      <div>请求权限会按它声明的范围授予，可选择本轮或本会话。</div>
      <div class="approval-field">
        <label>raw result</label>
        <textarea class="approval-json" data-result-json>${escapeHtml(JSON.stringify(defaultResult, null, 2))}</textarea>
      </div>
    `;
  }
  if (request.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    if (!questions.length) {
      return `<div>工具请求补充输入，但没有提供结构化问题；可以用 raw result 回应。</div>${rawResultEditorHtml({ answers: {} })}`;
    }
    return questions.map((question) => userInputQuestionHtml(request, question)).join("");
  }
  if (request.method === "mcpServer/elicitation/request") {
    const elicitation = params.request || {};
    const defaultContent = elicitation.requestedSchema || elicitation.requested_schema ? {} : null;
    return `
      <div>${escapeHtml(params.serverName || "MCP server")} 请求确认。</div>
      ${elicitation.message ? `<div>${formatMessage(elicitation.message)}</div>` : ""}
      <div class="approval-field">
        <label>content JSON</label>
        <textarea class="approval-json" data-mcp-content>${escapeHtml(defaultContent == null ? "" : JSON.stringify(defaultContent, null, 2))}</textarea>
      </div>
    `;
  }
  return `<div>未知请求类型，可以提交 raw JSON result。</div>${rawResultEditorHtml({})}`;
}

function userInputQuestionHtml(request, question) {
  const options = Array.isArray(question.options) ? question.options : [];
  const fieldName = `answer-${request.id}-${question.id}`;
  const inputType = question.isSecret || question.is_secret ? "password" : "text";
  return `
    <div class="approval-question" data-question-id="${escapeHtml(question.id)}">
      <div class="approval-question-title">${escapeHtml(question.header || question.id)}</div>
      <div class="approval-question-prompt">${escapeHtml(question.question || "")}</div>
      ${options.length ? `
        <div class="approval-options">
          ${options.map((option) => `
            <label class="approval-option">
              <input type="radio" name="${escapeHtml(fieldName)}" data-answer-option="${escapeHtml(question.id)}" value="${escapeHtml(option.label)}">
              <span>
                <strong>${escapeHtml(option.label)}</strong>
                ${option.description ? `<br><span>${escapeHtml(option.description)}</span>` : ""}
              </span>
            </label>
          `).join("")}
        </div>
      ` : ""}
      <input class="approval-input" type="${inputType}" data-answer-id="${escapeHtml(question.id)}" placeholder="${options.length ? "自定义回答" : "输入回答"}">
    </div>
  `;
}

function rawResultEditorHtml(defaultValue) {
  return `
    <div class="approval-field">
      <label>raw result</label>
      <textarea class="approval-json" data-result-json>${escapeHtml(JSON.stringify(defaultValue, null, 2))}</textarea>
    </div>
  `;
}

function approvalButtonsHtml(task, request) {
  const base = `data-server-request data-task-id="${escapeHtml(task.id)}" data-request-id="${escapeHtml(request.id)}"`;
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
    return `
      <button class="btn-secondary" type="button" ${base} data-decision="decline">拒绝</button>
      <button class="btn-secondary" type="button" ${base} data-decision="cancel">取消</button>
      <button class="btn-secondary" type="button" ${base} data-decision="acceptForSession">本会话允许</button>
      <button class="btn-primary" type="button" ${base} data-decision="accept">允许一次</button>
    `;
  }
  if (request.method === "mcpServer/elicitation/request") {
    return `
      <button class="btn-secondary" type="button" ${base} data-action="decline">拒绝</button>
      <button class="btn-secondary" type="button" ${base} data-action="cancel">取消</button>
      <button class="btn-primary" type="button" ${base} data-action="accept">接受</button>
    `;
  }
  if (request.method === "item/permissions/requestApproval") {
    return `
      <button class="btn-secondary" type="button" ${base} data-decision="decline">拒绝</button>
      <button class="btn-secondary" type="button" ${base} data-raw-result="true">提交 JSON</button>
      <button class="btn-secondary" type="button" ${base} data-decision="acceptForSession" data-scope="session">本会话允许</button>
      <button class="btn-primary" type="button" ${base} data-decision="accept" data-scope="turn">允许本轮</button>
    `;
  }
  if (request.method === "item/tool/requestUserInput") {
    return `
      <button class="btn-secondary" type="button" ${base} data-reject="true">拒绝请求</button>
      <button class="btn-primary" type="button" ${base} data-submit-answers="true">提交回答</button>
    `;
  }
  return `
    <button class="btn-secondary" type="button" ${base} data-reject="true">拒绝请求</button>
    <button class="btn-primary" type="button" ${base} data-raw-result="true">提交 JSON</button>
  `;
}

function shortMethod(method) {
  return String(method || "request").replace("item/", "").replace("/requestApproval", "");
}

function artifactHtml(artifact) {
  const raw = JSON.stringify(redactArtifact(artifact), null, 2);
  const failed = artifact.status === "failed";
  return `
    <details class="raw-artifact${failed ? " failed" : ""}">
      <summary>${failed ? "调试信息 / 原始日志" : "调试信息"}</summary>
      <pre>${linkifyUrls(raw)}</pre>
    </details>
  `;
}

function activityFromEvents(events, artifact) {
  const steps = [];
  for (const event of events) {
    const text = eventLabel(event);
    if (text) {
      steps.push({
        text,
        status: event.type.includes("failed") || event.type.includes("error") ? "failed" : isRunning(artifact.status) && event === events.at(-1) ? "pending" : ""
      });
    }
  }
  return steps.slice(-80);
}

function eventLabel(event) {
  if (SILENT_EVENT_TYPES.has(event.type)) return null;
  const item = event.params?.item;
  if (event.type === "item.completed" && item?.type === "userMessage") return null;
  if (event.type === "item.completed" && item?.type === "agentMessage") return "Agent message completed";
  if (event.type === "item.started" && item?.type) return `Started ${item.type}`;
  if (event.type === "item.completed" && item?.type) return `Completed ${item.type}`;
  if (event.type === "turn.started") return "Turn started";
  if (event.type === "turn.completed") return "Turn completed";
  if (event.type === "thread.started") return "Thread started";
  if (event.type === "thread.status.changed") return `Thread status: ${event.params?.status?.type || "changed"}`;
  if (event.type === "task.queued") return event.params?.queuePosition ? `Task queued: #${event.params.queuePosition}` : "Task queued";
  if (event.type === "task.started") return "Task started";
  if (event.type === "task.completed") return "Task completed";
  if (event.type === "task.failed") return `Task failed: ${errorText(event.params?.error)}`;
  if (event.type === "turn.verification.passed") return "Completion verified";
  if (event.type === "turn.verification.failed") return `Completion check failed: ${event.params?.reason || "missing artifacts"}`;
  if (event.type === "task.interrupted") return "Task interrupted";
  if (event.type === "item.commandExecution.requestApproval") return `Approval needed: ${event.params?.command || event.params?.reason || "command execution"}`;
  if (event.type === "item.fileChange.requestApproval") return `Approval needed: ${event.params?.reason || "file change"}`;
  if (event.type === "item.permissions.requestApproval") return `Approval needed: ${event.params?.reason || "permissions"}`;
  if (event.type === "item.tool.requestUserInput") return "User input requested by tool";
  if (event.type === "mcpServer.elicitation.request") return "MCP confirmation requested";
  if (event.type === "serverRequest.response.sent") return "Server request response sent";
  if (event.type === "serverRequest.rejected") return "Server request rejected";
  if (event.type === "runtime.environment.ready") return `Runtime environment ready: ${event.params?.npmRegistry || "npm registry unknown"}`;
  if (event.type === "runtime.error") return `Runtime error: ${errorText(event.params?.error) || errorText(event.params?.message)}`;
  if (event.type === "runtime.warning" && errorText(event.params?.message).includes("Skill descriptions were shortened")) return null;
  if (event.type === "runtime.warning") return `Runtime warning: ${errorText(event.params?.message)}`;
  return null;
}

function parseDiffCards(diffText) {
  if (!diffText) return [];
  const sections = diffText.split(/\ndiff --git /);
  return sections.map((section, index) => {
    const text = index === 0 ? section : `diff --git ${section}`;
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    if (!lines.length) return null;
    const file = extractDiffFile(lines);
    const adds = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removes = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    return { file, adds, removes, lines };
  }).filter(Boolean);
}

function extractDiffFile(lines) {
  const plus = lines.find((line) => line.startsWith("+++ b/"));
  if (plus) return plus.slice(6);
  const header = lines.find((line) => line.startsWith("diff --git "));
  if (header) return header.replace(/^diff --git a\//, "").replace(/ b\/.*$/, "");
  return "changed file";
}

function userPromptFromArtifact(artifact) {
  if (artifact.request?.prompt) return artifact.request.prompt;
  const event = (artifact.events || []).find((candidate) => candidate.type === "item.completed" && candidate.params?.item?.type === "userMessage");
  const content = event?.params?.item?.content || [];
  return content.find((item) => item.type === "text")?.text || "";
}

function formatMessage(text) {
  return renderInline(String(text ?? "")).replace(/\n/g, "<br>");
}

function renderMarkdown(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  const fencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let html = "";
  let lastIndex = 0;
  let match;
  while ((match = fencePattern.exec(source))) {
    html += renderMarkdownBlocks(source.slice(lastIndex, match.index));
    const lang = match[1]?.trim();
    html += `<pre><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}>${escapeHtml(match[2].replace(/\n$/, ""))}</code></pre>`;
    lastIndex = fencePattern.lastIndex;
  }
  html += renderMarkdownBlocks(source.slice(lastIndex));
  return html || "<p></p>";
}

function renderMarkdownBlocks(block) {
  const lines = String(block || "").split("\n");
  let html = "";
  let paragraph = [];
  let listType = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html += `<p>${renderInline(paragraph.join(" ").trim())}</p>`;
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    html += `</${listType}>`;
    listType = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    if (isTableStart(lines, index)) {
      flushParagraph();
      closeList();
      const table = collectTable(lines, index);
      html += table.html;
      index = table.nextIndex - 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      closeList();
      html += "<hr>";
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      closeList();
      const quotes = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quotes.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      index -= 1;
      html += `<blockquote>${renderMarkdownBlocks(quotes.join("\n"))}</blockquote>`;
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        html += `<${nextType}>`;
        listType = nextType;
      }
      html += `<li>${renderInline((unordered || ordered)[1])}</li>`;
      continue;
    }

    closeList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return html;
}

function renderInline(text) {
  const source = String(text ?? "");
  const codePattern = /`([^`\n]+)`/g;
  let html = "";
  let lastIndex = 0;
  let match;
  while ((match = codePattern.exec(source))) {
    html += renderLinkedText(source.slice(lastIndex, match.index));
    html += renderInlineCode(match[1]);
    lastIndex = codePattern.lastIndex;
  }
  html += renderLinkedText(source.slice(lastIndex));
  return html;
}

function renderInlineCode(text) {
  const source = String(text ?? "");
  const trimmed = source.trim();
  if (isSafeHttpUrl(trimmed)) {
    return `<a class="inline-url-code" href="${escapeHtml(new URL(trimmed).href)}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(source)}</code></a>`;
  }
  return `<code>${escapeHtml(source)}</code>`;
}

function renderLinkedText(text) {
  const source = String(text ?? "");
  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let html = "";
  let lastIndex = 0;
  let match;
  while ((match = markdownLinkPattern.exec(source))) {
    html += linkifyUrls(source.slice(lastIndex, match.index));
    html += safeAnchor(match[2], match[1]);
    lastIndex = markdownLinkPattern.lastIndex;
  }
  html += linkifyUrls(source.slice(lastIndex));
  return html;
}

function linkifyUrls(text) {
  const urlPattern = /https?:\/\/[^\s<>"'`]+/g;
  let html = "";
  let lastIndex = 0;
  let match;
  while ((match = urlPattern.exec(text))) {
    const raw = match[0];
    const clean = raw.replace(/[.,;:!?，。！？；：、\])}）】》]+$/u, "");
    const trailing = raw.slice(clean.length);
    html += renderPlainText(text.slice(lastIndex, match.index));
    html += safeAnchor(clean, clean);
    html += renderPlainText(trailing);
    lastIndex = match.index + raw.length;
  }
  html += renderPlainText(text.slice(lastIndex));
  return html;
}

function safeAnchor(url, label) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return renderPlainText(label);
    }
    return `<a href="${escapeHtml(parsed.href)}" target="_blank" rel="noopener noreferrer">${renderPlainText(label)}</a>`;
  } catch {
    return renderPlainText(label);
  }
}

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function renderPlainText(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\b_([^_\n]+)_\b/g, "<em>$1</em>");
}

function isTableStart(lines, index) {
  return /\|/.test(lines[index] || "") && isTableSeparator(lines[index + 1] || "");
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line || "");
}

function collectTable(lines, startIndex) {
  const headers = splitTableRow(lines[startIndex]);
  let index = startIndex + 2;
  const rows = [];
  while (index < lines.length && /\|/.test(lines[index] || "") && lines[index].trim()) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  const head = headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
  const body = rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${renderInline(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("");
  return {
    html: `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
    nextIndex: index,
  };
}

function splitTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function resourcesFromText(text, task = null) {
  const source = String(text || "");
  const pattern = /(^|[\s("'`“”‘’《【：:])((?:\/[A-Za-z0-9._~+@%=-][^\s"'<>)]*|(?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@%+-][^\s"'<>)]*|[A-Za-z0-9_.@%+-]+)\.(?:md|markdown|txt|json|jsonl|csv|tsv|log|html|pdf|png|jpe?g|webp))(?:[:#]\d+)?/gi;
  const resources = [];
  const seen = new Set();
  for (const resource of resourcesFromCompletedArtifacts(task?.completedArtifacts || [])) {
    const key = resource.url || resource.path;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    resources.push(resource);
  }
  let match;
  while ((match = pattern.exec(source))) {
    const filePath = match[2];
    if (!filePath || filePath.includes("://") || seen.has(filePath)) continue;
    seen.add(filePath);
    resources.push({
      type: "file",
      path: filePath,
      name: basename(filePath),
      extension: fileExtension(filePath),
    });
  }
  for (const resource of larkDocumentResourcesFromText(source)) {
    if (seen.has(resource.url)) continue;
    seen.add(resource.url);
    resources.push(resource);
  }
  return resources.slice(0, 12);
}

function resourcesFromCompletedArtifacts(artifacts) {
  return artifacts.flatMap((artifact) => {
    if (artifact?.kind === "lark_doc" && artifact.url) {
      return [{
        type: "lark-doc",
        url: artifact.url,
        name: "飞书文档",
        extension: "doc",
      }];
    }
    const filePath = artifact?.relativePath || artifact?.path;
    if (artifact?.type === "local_file" && filePath) {
      return [{
        type: "file",
        path: filePath,
        name: basename(filePath),
        extension: fileExtension(filePath),
      }];
    }
    return [];
  });
}

function larkDocumentResourcesFromText(text) {
  const resources = [];
  const seen = new Set();
  const urlPattern = /https?:\/\/[^\s<>"'`]+/g;
  let match;
  while ((match = urlPattern.exec(text))) {
    const clean = match[0].replace(/[.,;:!?，。！？；：、\])}）】》]+$/u, "");
    if (!isLarkDocumentUrl(clean) || seen.has(clean)) continue;
    seen.add(clean);
    resources.push({
      type: "lark-doc",
      url: clean,
      name: inferLarkDocumentTitle(text, clean),
      extension: "doc",
    });
  }
  return resources;
}

function isLarkDocumentUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)larkoffice\.com$/i.test(parsed.hostname)
      && /^\/(docx|docs|wiki|mindnotes|base|sheets|slides)\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

function inferLarkDocumentTitle(text, url) {
  const lines = String(text || "").split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(url));
  const candidates = [];
  if (index >= 0) {
    candidates.push(lines[index].slice(0, lines[index].indexOf(url)));
    candidates.push(lines[index - 1] || "");
    candidates.push(lines[index - 2] || "");
  }
  for (const candidate of candidates) {
    const title = cleanDeliveryTitle(candidate);
    if (title) return title;
  }
  return "飞书文档";
}

function cleanDeliveryTitle(value) {
  const cleaned = String(value || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^[\s\-*•·]+/, "")
    .replace(/[`*_#]/g, "")
    .replace(/^(?:已创建|创建了)?\s*(?:文档链接|链接|标题|飞书文档|文档)\s*[:：]\s*/i, "")
    .trim();
  if (!cleaned || cleaned.length > 80) return "";
  return cleaned;
}

function resourceCardsHtml(resources, task) {
  if (!resources.length) return "";
  const workspacePath = task.workspacePath || els.workspaceInput.value.trim();
  return `
    <section class="delivery-section">
      <div class="section-title">交付内容</div>
      <div class="resource-list">
      ${resources.map((resource) => {
        if (resource.type === "lark-doc") {
          return larkResourceCardHtml(resource);
        }
        return `
          <div class="resource-card">
            <div class="resource-icon">${escapeHtml(resourceIcon(resource))}</div>
            <div class="resource-info">
              <div class="resource-name">${escapeHtml(resource.name)}</div>
              <div class="resource-path">${escapeHtml(resourceMeta(resource, resource.path))}</div>
            </div>
            <div class="resource-actions">
              <button class="resource-btn" data-file-action="open" data-resource-path="${escapeHtml(resource.path)}" data-workspace-path="${escapeHtml(workspacePath)}">查看</button>
              <button class="resource-btn" data-file-action="reveal" data-resource-path="${escapeHtml(resource.path)}" data-workspace-path="${escapeHtml(workspacePath)}">定位</button>
            </div>
          </div>
        `;
      }).join("")}
      </div>
    </section>
  `;
}

function larkResourceCardHtml(resource) {
  return `
    <div class="resource-card lark-resource">
      <div class="resource-icon">DOC</div>
      <div class="resource-info">
        <div class="resource-name">${escapeHtml(resource.name || "飞书文档")}</div>
        <div class="resource-path">${escapeHtml(resourceMeta(resource, resource.url))}</div>
      </div>
      <div class="resource-actions">
        <a class="resource-btn resource-btn-primary" href="${escapeAttribute(resource.url)}" target="_blank" rel="noopener noreferrer">打开</a>
        <button class="resource-btn" data-copy-text="${escapeAttribute(resource.url)}">复制链接</button>
      </div>
    </div>
  `;
}

function resourceIcon(resource) {
  const extension = String(resource.extension || fileExtension(resource.path) || "").toUpperCase();
  if (extension === "MARKDOWN") return "MD";
  if (extension === "JPEG") return "JPG";
  return extension ? extension.slice(0, 4) : "FILE";
}

function resourceMeta(resource, fallback) {
  if (resource.type === "lark-doc") return "飞书文档 · 在线文档";
  const label = fileTypeLabel(resource.extension || fileExtension(resource.path));
  return `${label} · 本地文件 · ${fallback}`;
}

function fileTypeLabel(extension) {
  const ext = String(extension || "").toLowerCase();
  if (ext === "md" || ext === "markdown") return "Markdown";
  if (ext === "html") return "HTML";
  if (ext === "pdf") return "PDF";
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "图片";
  if (["json", "jsonl"].includes(ext)) return "JSON";
  if (["csv", "tsv"].includes(ext)) return "表格文本";
  if (ext === "log") return "日志";
  if (ext === "txt") return "文本";
  return ext ? ext.toUpperCase() : "文件";
}

async function handleFileAction(button) {
  const action = button.dataset.fileAction;
  const filePath = button.dataset.resourcePath;
  const workspacePath = button.dataset.workspacePath || els.workspaceInput.value.trim();
  if (!action || !filePath) return;
  try {
    await apiJson(`/v1/files/${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath, workspacePath }),
    });
    showToast(action === "reveal" ? "已在 Finder 中定位" : "已打开文件");
  } catch (error) {
    showToast(error.message);
  }
}

function redactArtifact(artifact) {
  return JSON.parse(JSON.stringify(artifact).replace(/(ARK_API_KEY=)[^\\s"]+/g, "$1[REDACTED]"));
}

async function resolveServerRequest(button) {
  const taskId = button.dataset.taskId;
  const requestId = button.dataset.requestId;
  if (!taskId || !requestId) return;
  let body;
  try {
    body = serverRequestBodyFromCard(button);
  } catch (error) {
    showToast(error.message);
    return;
  }
  button.disabled = true;
  try {
    await apiJson(`/v1/tasks/${encodeURIComponent(taskId)}/server-requests/${encodeURIComponent(requestId)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const artifact = await apiJson(`/v1/tasks/${encodeURIComponent(taskId)}/artifact`);
    state.activeArtifact = artifact;
    updateActiveConversationTask(artifact);
    if (artifact.conversationId) {
      state.activeConversation = await apiJson(`/v1/conversations/${encodeURIComponent(artifact.conversationId)}`);
    }
    renderTask();
    showToast("已回写审批结果");
  } catch (error) {
    button.disabled = false;
    showToast(error.message);
  }
}

function serverRequestBodyFromCard(button) {
  const card = button.closest("[data-request-card]");
  const method = card?.dataset.method || "";
  if (button.dataset.reject === "true") {
    return { reject: true };
  }
  if (button.dataset.rawResult === "true") {
    return { result: parseJsonTextarea(card, "[data-result-json]", {}) };
  }
  if (button.dataset.submitAnswers === "true" || method === "item/tool/requestUserInput") {
    return { answers: collectUserInputAnswers(card) };
  }
  if (method === "mcpServer/elicitation/request") {
    const action = button.dataset.action || "decline";
    const content = action === "accept"
      ? parseOptionalJsonTextarea(card, "[data-mcp-content]")
      : null;
    return { action, content, _meta: null };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      decision: button.dataset.decision || "accept",
      scope: button.dataset.scope || "turn"
    };
  }
  if (button.dataset.action) {
    return { action: button.dataset.action };
  }
  return { decision: button.dataset.decision || "accept" };
}

function collectUserInputAnswers(card) {
  const answers = {};
  card.querySelectorAll("[data-question-id]").forEach((questionEl) => {
    const id = questionEl.dataset.questionId;
    const selected = [...questionEl.querySelectorAll("[data-answer-option]:checked")]
      .map((input) => input.value)
      .filter(Boolean);
    const typed = [...questionEl.querySelectorAll("[data-answer-id]")]
      .map((input) => input.value.trim())
      .filter(Boolean);
    const values = [...selected, ...typed];
    if (id && values.length) {
      answers[id] = values;
    }
  });
  return answers;
}

function parseJsonTextarea(root, selector, fallback) {
  const value = root?.querySelector(selector)?.value.trim();
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`JSON 格式错误：${error.message}`);
  }
}

function parseOptionalJsonTextarea(root, selector) {
  const value = root?.querySelector(selector)?.value.trim();
  if (!value) return null;
  return parseJsonTextarea(root, selector, null);
}

function mergeServerRequestFromEvent(artifact, event) {
  if (!artifact) return;
  artifact.serverRequests = artifact.serverRequests || [];
  const requestId = event.params?.serverRequestId;
  if (isApprovalRequestEvent(event) && requestId) {
    const params = { ...(event.params || {}) };
    delete params.serverRequestId;
    const existing = artifact.serverRequests.find((request) => String(request.id) === String(requestId));
    const request = {
      id: String(requestId),
      method: event.rawMethod || event.type.replaceAll(".", "/"),
      params,
      status: "pending",
      createdAt: event.ts
    };
    if (existing) {
      Object.assign(existing, request);
    } else {
      artifact.serverRequests.push(request);
    }
  }
  if ((event.type === "serverRequest.response.sent" || event.type === "serverRequest.rejected") && event.params?.requestId) {
    const existing = artifact.serverRequests.find((request) => String(request.id) === String(event.params.requestId));
    if (existing) {
      existing.status = event.type === "serverRequest.rejected" ? "rejected" : "resolved";
      existing.resolvedAt = event.ts;
    }
  }
}

function updateActiveConversationTask(artifact) {
  if (!state.activeConversation || !artifact) return;
  const tasks = state.activeConversation.tasks || [];
  const index = tasks.findIndex((task) => task.id === artifact.id);
  if (index >= 0) {
    tasks[index] = artifact;
  } else {
    tasks.push(artifact);
  }
  state.activeConversation = { ...state.activeConversation, tasks };
}

function isApprovalRequestEvent(event) {
  return event.type === "item.commandExecution.requestApproval"
    || event.type === "item.fileChange.requestApproval"
    || event.type === "item.permissions.requestApproval"
    || event.type === "item.tool.requestUserInput"
    || event.type === "mcpServer.elicitation.request";
}

function newTask() {
  closeStream();
  state.activeConversation = null;
  state.activeArtifact = null;
  state.activeDiff = null;
  const savedWorkspace = localStorage.getItem(WORKSPACE_STORAGE_KEY);
  const workspacePath = isSelectableWorkspacePath(savedWorkspace)
    ? savedWorkspace
    : state.defaultWorkspace || currentWorkspace();
  if (workspacePath) {
    setWorkspace(workspacePath, { saveRecent: true, force: true });
  }
  renderSidebar();
  renderEmpty();
  els.inputBox.focus();
}

function setStatus(status) {
  els.taskStatus.textContent = statusLabel(status);
  els.taskStatus.className = `status-pill ${status || ""}`;
}

function updateButtons() {
  const canCancel = canCancelActiveTask();
  const running = isRunning(state.activeArtifact?.status);
  const queued = state.activeArtifact?.status === "queued";
  const pending = state.isSubmitting || running || queued;
  els.cancelBtn.disabled = !canCancel;
  els.sendBtn.disabled = false;
  els.sendBtn.classList.toggle("running", pending || canCancel);
  els.sendBtn.classList.toggle("busy", false);
  if (canCancel) {
    els.sendBtn.textContent = "■";
    els.sendBtn.title = queued ? "取消排队" : "停止任务";
  } else if (pending) {
    els.sendBtn.textContent = "■";
    els.sendBtn.title = "正在创建任务";
  } else {
    els.sendBtn.textContent = "↑";
    els.sendBtn.title = "发送";
  }
}

function currentProvider() {
  return state.providers.find((provider) => provider.id === els.providerSelect.value);
}

function isRunning(status) {
  return status === "starting" || status === "running";
}

function isTerminalStatus(status) {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function canCancelActiveTask() {
  const artifact = state.activeArtifact;
  return Boolean(artifact?.id && artifact.id !== "pending" && (isRunning(artifact.status) || artifact.status === "queued"));
}

function statusLabel(status) {
  if (status === "queued") return "排队中";
  if (status === "starting") return "准备中";
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "interrupted") return "已停止";
  return "空闲";
}

function runningLabel(artifact) {
  const events = artifact.events || [];
  const latest = events.at(-1)?.type || "";
  if (artifact.status === "queued") return artifact.queuePosition ? `排队中 · 第 ${artifact.queuePosition} 位` : "排队中";
  if (artifact.id === "pending" || state.isSubmitting) return "正在思考";
  if (latest.includes("commandExecution") || latest.includes("fileChange")) return "正在执行";
  if (latest.includes("requestApproval") || pendingServerRequests(artifact).length) return "等待确认";
  if (latest.startsWith("item.") || latest.startsWith("turn.")) return "正在思考";
  return "正在思考";
}

async function apiJson(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const preview = text.replace(/\s+/g, " ").slice(0, 180);
      throw new Error(`接口返回了非 JSON 内容: ${preview || "empty response"}`);
    }
  }
  if (!response.ok) {
    throw new Error(errorText(data.error) || `${response.status} ${response.statusText}`);
  }
  return data;
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 4200);
}

function taskTitle(task) {
  return String(task.prompt || task.request?.prompt || task.finalMessage || errorText(task.error) || "新任务").trim().slice(0, 28);
}

function conversationTitle(conversation) {
  return String(conversation.title || conversation.prompt || conversation.finalMessage || conversation.error || "新对话").trim().slice(0, 32);
}

function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return errorText(parsed?.fields?.error || parsed?.fields?.message || parsed?.error || parsed?.message || trimmed);
      } catch {
        return error;
      }
    }
    return error;
  }
  if (typeof error.message === "string") return error.message;
  if (error.error) return errorText(error.error);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function basename(value) {
  const parts = String(value || "").split("/").filter(Boolean);
  return parts.at(-1) || value || "workspace";
}

function parentPath(value) {
  const normalized = String(value || "").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized || "";
  return normalized.slice(0, index);
}

function isUnsafeWorkspacePath(value) {
  return String(value || "").includes(".app/Contents/Resources");
}

function relativeTime(value) {
  if (!value) return "";
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function timeOf(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
