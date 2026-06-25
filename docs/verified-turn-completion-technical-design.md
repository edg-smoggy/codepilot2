# CodePilot Verified Turn Completion Technical Design

Last updated: 2026-06-24

## 1. 核心结论

CodePilot 的完成态必须改成：

```text
adapter 层保证协议正确
runtime / verifier 层保证任务完成
```

并且 verifier 必须插在用户可见的 `turn.completed` / `task.completed` 之前。

更准确地说：

```text
Codex app-server 原始 turn/completed
  -> CodePilot 拦截，不直接透传给前端
  -> verifier 检查 expectedArtifacts
  -> 通过：再发用户可见 turn.completed + task.completed
  -> 不通过且可续跑：发 task.continuation.started，继续下一轮
  -> 不通过且不可续跑：发 task.failed
```

用户和前端不应该先看到 completed，再看到“其实没完成”。

## 2. 当前问题

当前链路里，Codex app-server 的通知会被 `task-manager` 直接转发：

```text
app-server notification
  -> normalizeAppServerNotification
  -> this.#emit(task, event)
  -> SSE 前端
```

这意味着：

```text
上游 turn/completed 一出现
  -> 前端可能已经看到 turn.completed
  -> 后端才做 validateTaskCompletion
```

这会造成两个问题：

1. 体验上已经“完成”了，再续跑或失败很怪。
2. 如果前端把 `turn.completed` 当成完成信号，就会绕过 verifier。

所以必须把 `turn.completed` 变成后端内部事件，先进入 verifier，再决定是否对前端发用户可见完成态。

## 3. 目标状态

### 3.1 事件状态机

```text
turn.started
  -> item.started / item.completed / plan.updated / ...
  -> raw turn/completed from app-server
  -> verifier.running
  -> verifier.passed
      -> turn.completed
      -> task.completed
  -> verifier.failed but recoverable
      -> task.continuation.started
      -> next turn.started
  -> verifier.failed unrecoverable
      -> task.failed
```

### 3.2 关键原则

- 原始 app-server `turn/completed` 不直接透给前端。
- 前端看到的 `turn.completed` 必须是 verified completed。
- 失败态也要展示已交付内容。
- adapter 不判断任务完成，只保证协议合法。
- verifier 不修协议，只判断交付物是否满足用户任务。

## 4. Adapter 层技术方案

adapter 目标：

```text
ModelHub 原始响应
  -> 干净的 Responses 事件
  -> 或明确 structured error
```

adapter 不负责判断 HTML / MD / 飞书文档有没有完成。

### 4.1 Provider Capability Matrix

在 `config/providers/modelhub-gpt55.json` 增加：

```json
{
  "capabilities": {
    "supportsSystemMessage": true,
    "supportsDeveloperMessage": false,
    "developerMessageStrategy": "merge_to_system",
    "supportsToolCalls": true,
    "supportsParallelToolCalls": false,
    "supportsStreamingToolCalls": false,
    "supportsImageInput": true
  }
}
```

用途：

- adapter 知道哪些 role 可以直传。
- 不支持 developer message 时，明确 merge 到 system，而不是静默丢弃。
- 不支持 parallel tool calls 时，可以拒绝或串行化。
- 不支持 streaming tool calls 时，禁用上游 tool streaming。

### 4.2 Request Translator

把 Codex Responses input 翻译成 ModelHub chat/crawl messages。

必须保证：

- message 顺序不变。
- system / developer 转换有明确策略。
- assistant `function_call` 转为 chat `tool_calls`。
- `function_call_output` 转为 chat `tool` message。
- `tool_call_id` 必须保留。
- tool schema 必须完整传递。

如果遇到无法表达的 input 类型：

```text
unsupported_capability
```

不要悄悄丢掉。

### 4.3 Response Translator

ModelHub 返回后只允许输出两类结果：

```text
A. 合法 Responses output item
B. structured adapter error
```

允许：

- 有 tool call：转为 Responses `function_call`。
- 有 final text：转为 Responses `message`。
- HTTP / provider 错误：转为 `response.failed`。

不允许：

- 参数不是 JSON 但假装正常 tool call。
- tool call id 缺失且无法生成稳定 id。
- provider 错误文本伪装成 assistant 正常回复。

### 4.4 Tool Call 闭环校验

adapter 需要维护协议级闭环：

```text
assistant tool_call id = call_xxx
后续 request 必须包含 function_call_output call_xxx
```

实现方式：

- 从 Responses input 中扫描历史 `function_call` 和 `function_call_output`。
- 找出未闭环 call id。
- 如果未闭环仍继续发新用户消息或 final request，标记 `protocol_violation`。

注意：

- 这是协议校验，不是任务完成校验。
- 如果协议未闭环，adapter 应返回 structured error，不能让上层误以为 turn 正常。

### 4.5 错误归类

ModelHub 错误要归类，不要直接外泄成普通文本。

建议错误码：

| 错误码 | 场景 |
|-|-|
| `provider_timeout` | 请求或流式超时 |
| `provider_resource_exhausted` | 资源池不足、限流、quota |
| `provider_5xx` | 供应侧 5xx |
| `provider_auth_error` | AK / 鉴权失败 |
| `malformed_tool_call` | tool call 参数无法解析 |
| `protocol_violation` | tool call / tool result 不闭环 |
| `unsupported_capability` | provider 不支持某输入能力 |

这些错误进入 runtime 后，应该成为 `failed` 或可控 retry，而不是 normal assistant message。

### 4.6 Prompt 恢复

之前临时加的强 prompt 只用于实验。正式方案里恢复到原本轻量 tool-use directive：

```text
- If the user asks to create, edit, write, generate, save, or inspect files, use tools.
- Do not answer only with a plan.
- Continue until the artifact exists or operation completed.
- Final answer only after tool results confirm done or clearly report failure.
```

prompt 只是辅助，不承担完成判定。

## 5. Runtime / Verifier 层技术方案

runtime 目标：

```text
expectedArtifacts 对上 -> completed
expectedArtifacts 对不上 -> continuation / failed
```

### 5.1 插入点

当前代码大致是：

```text
client.waitForNotification(turn/completed)
  -> validateTaskCompletion
  -> task.completed / task.failed
```

但同时 `onNotification` 已经把 `turn/completed` 转发给前端了。

需要改成：

```text
onNotification(message):
  normalized = normalizeAppServerNotification(message)
  if normalized.type === "turn.completed":
      task.rawTurnCompleted = normalized
      不 emit
  else:
      emit normally

client.waitForNotification(raw turn/completed)
  -> run verifier
  -> if passed:
        emit verified turn.completed
        emit task.completed
     if recoverable:
        emit verifier.failed
        emit task.continuation.started
        start next turn
     if unrecoverable:
        emit verifier.failed
        emit task.failed
```

这样 verifier 就插在用户可见 `turn.completed` 之前。

### 5.2 Expected Artifacts 轻量提取

第一版不做复杂 schema，只识别硬交付物。

| 用户表达 | expected artifact |
|-|-|
| html、网页、小游戏、页面 | `.html` |
| md、markdown、说明文档 | `.md` |
| 飞书文档、lark doc、docx | verified lark doc URL |
| 修改、修复、开发、实现 | file change / git diff |
| 纯问答 | text answer |

模糊表达第一版保守处理：

- “写几个 md”：至少 1 个 `.md`。
- “html 或 md 都行”：至少 1 个本地交付物。
- “顺便可以”：暂不作为 required。

### 5.3 Workspace Baseline

任务开始时记录 workspace baseline：

```json
{
  "files": [
    {
      "path": "README.md",
      "size": 120,
      "mtimeMs": 123456789,
      "hash": "optional"
    }
  ]
}
```

任务结束时再次扫描：

```text
newOrChangedFiles = after - before
```

用于判断：

- 新增 / 修改 `.html`
- 新增 / 修改 `.md`
- 非 git workspace 也能检查文件变化

### 5.4 Artifact 检查

#### HTML

通过条件：

- workspace 内有新增或修改 `.html` / `.htm`
- 文件大小 > 20 bytes
- 不在 `.app/Contents/Resources` 内

V1 不判断游戏质量。

#### Markdown

通过条件：

- workspace 内有新增或修改 `.md`
- 文件大小 > 20 bytes
- 不只算任务脚本预置的 README.md，必须是任务期间新增或修改

#### 飞书文档

通过条件：

- task events 或 transcript 中存在成功工具调用。
- 工具输出包含 `https://...larkoffice.com/docx/...`。

最终文本里的 URL 只能作为展示，不足以 completed。

#### 代码修改

通过条件：

- git diff 有变化；或
- workspace scan 有新增 / 修改文件。

### 5.5 Verifier 输出

```json
{
  "status": "passed | recoverable_failed | unrecoverable_failed",
  "reason": "缺少 Markdown 文件",
  "expectedArtifacts": [
    { "kind": "html", "required": true }
  ],
  "completedArtifacts": [
    {
      "kind": "html",
      "type": "local_file",
      "path": "/Users/name/Documents/CodePilot Workspace/game.html"
    }
  ],
  "missingArtifacts": [
    {
      "kind": "markdown",
      "type": "local_file",
      "reason": "未找到任务期间新增或修改的 .md 文件"
    }
  ],
  "unrecoverableErrors": []
}
```

### 5.6 Recoverable vs Unrecoverable

#### recoverable_failed

适合自动续跑：

- 模型只输出计划。
- 缺少部分交付物。
- 没有明显权限、认证、资源池错误。

处理：

```text
emit verifier.failed
emit task.continuation.started
start next turn
```

续跑 prompt 必须带：

```text
已完成项：
- game.html

缺失项：
- markdown
- lark_doc

请只补齐缺失项，不要重做或覆盖已完成项。
```

#### unrecoverable_failed

不续跑，直接 failed：

- ModelHub resource exhausted
- AK 未配置
- 飞书认证失败
- workspace 不可写
- app-server fatal
- 已续跑到上限仍没有交付物

处理：

```text
emit verifier.failed
emit task.failed
```

failed 也展示 `completedArtifacts`。

## 6. 事件设计

### 6.1 内部事件

```text
turn.raw_completed
```

只写入后端日志或 artifact，可不发前端。

### 6.2 用户可见事件

```text
turn.verification.started
turn.verification.passed
turn.verification.failed
task.continuation.started
turn.completed
task.completed
task.failed
```

其中：

- `turn.completed` 只在 verifier passed 后发。
- `task.completed` 只在 verifier passed 后发。
- `task.failed` 可以带 `completedArtifacts` 和 `missingArtifacts`。

## 7. 前端展示

### completed

展示：

```text
最终结果
交付内容
调试信息
```

### continuing

展示：

```text
运行提示：检测到任务未完成，继续推进。
缺失：Markdown 文件、飞书文档
```

### failed

展示：

```text
任务没有完成

已交付：
- game.html

缺失：
- 飞书文档：飞书认证失败

调试信息
```

## 8. 代码改动清单

### 8.1 Adapter

文件：

```text
src/runtime/modelhub-crawl-adapter.mjs
config/providers/modelhub-gpt55.json
```

改动：

- 恢复 tool-use prompt 原样。
- 增加 provider capabilities。
- 增加 request protocol summary。
- 增加 tool call / tool result 闭环检查。
- 增加 error classifier。
- `sendResponsesFailure` 支持 structured code。
- `provider_resource_exhausted` 等错误不要转成普通 message。

### 8.2 Verifier

新增：

```text
src/agent-server/lightweight-completion-verifier.mjs
```

职责：

- 提取 expected artifacts。
- 记录 / 比较 workspace baseline。
- 从 events / transcript 提取 verified artifacts。
- 输出 verifier result。

### 8.3 Task Manager

文件：

```text
src/agent-server/task-manager.mjs
```

改动：

- task 创建时保存 `expectedArtifacts`。
- task start 时保存 workspace baseline。
- 拦截 app-server 原始 `turn.completed`，不直接 emit 给前端。
- raw turn completed 后运行 verifier。
- verifier passed 后 emit verified `turn.completed`。
- verifier failed recoverable 时自动续跑。
- verifier failed unrecoverable 时 task.failed。
- artifact JSON 增加：

```json
{
  "expectedArtifacts": [],
  "completedArtifacts": [],
  "missingArtifacts": [],
  "completionVerification": {}
}
```

### 8.4 Frontend

文件：

```text
web/app.js
web/styles.css
```

改动：

- 不把 raw turn completed 视为完成。
- 展示 verification 状态。
- failed 时展示已交付内容。
- completed 时优先展示交付内容。

## 9. 验收标准

核心硬指标：

```text
无交付物却 completed = 0
```

测试 case：

| Case | 期望 |
|-|-|
| 你好 | completed，纯文本回答 |
| 写一个 md 文件 | 没有 `.md` 不能 completed |
| 写一个 html 小游戏 | 没有 `.html` 不能 completed |
| 写 html + md | 缺一个不能 completed |
| 写 html + md + 飞书文档 | 缺一个不能 completed，失败时展示已交付 |
| 飞书认证失败 | failed，不无限续跑 |
| ModelHub 资源池不足 | failed / retry 后 failed，不 completed |
| 模型只说“我会创建” | 不发 turn.completed，自动续跑或 failed |

## 10. 边界说明

V1 verifier 保证：

- 交付物存在。
- 路径安全。
- 类型匹配。
- 飞书 doc URL 来自成功工具输出。
- 用户可见 completed 必须在 verifier passed 后。

V1 verifier 不保证：

- HTML 游戏一定好玩。
- Markdown 文案一定高质量。
- 飞书文档内容一定完美。
- 模型未来不会失败。

它先解决一个最要命的问题：

```text
失败不能伪装成完成。
```
