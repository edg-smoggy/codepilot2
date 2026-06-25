# CodePilot ModelHub Tool Loop Reliability Plan

Last updated: 2026-06-24

## 1. 背景

CodePilot 当前复用了 OpenAI Codex 的本地 runtime / app-server / tool loop，并通过 provider adapter 把模型请求转到内部模型服务。现在主要问题集中在 ModelHub GPT-5.5 路线：

- 用户要求产出实际交付物，例如 HTML 游戏、Markdown 文件、飞书文档。
- 模型有时只输出“我会创建”“我将继续”“目录是空的，我会直接创建”等中间过程文字。
- runtime / task manager 可能把这类中间文字当成最终结果。
- 最终用户看到“任务完成”，但实际没有 HTML、MD 或飞书文档。

这个问题本质不是前端问题，也不是简单的 prompt 问题，而是：

```text
Codex Responses tool loop
  -> ModelHub crawl/chat adapter
  -> 模型返回中间文本或不完整工具调用
  -> 当前完成判定缺少强 verifier
  -> 任务被误判完成
```

要解决它，必须把“模型说完成”改成“系统验证完成”。

## 2. 目标

下一版要达到的目标：

1. 对需要交付物的任务，只有真实交付物存在且可验证时，任务才显示完成。
2. 如果模型停在中间话术，系统自动续跑，不把中间话术展示成最终结果。
3. 如果续跑后仍没有交付物，任务应明确失败，并告诉用户缺少什么。
4. ModelHub adapter 对 tool call / tool result / message role 的协议转换更稳。
5. 用固定测试集持续回归，避免后续 UI 或 adapter 改动再次引入假完成。

非目标：

- 不在第一版引入额外 LLM verifier 作为主判断。可以作为后续增强，但不能把可靠性建立在另一个模型判断上。
- 不做针对单个 prompt 的硬编码特化，例如只识别“html 小游戏”。
- 不要求一次解决所有模型能力问题；目标是让系统不会把失败伪装成成功。

## 3. 当前已知事实

### 3.1 当前链路

```text
Frontend
  -> src/agent-server/server.mjs
  -> src/agent-server/task-manager.mjs
  -> src/runtime/app-server-client.mjs
  -> upstream/openai-codex app-server
  -> Codex core tool loop
  -> src/runtime/modelhub-crawl-adapter.mjs
  -> ModelHub GPT-5.5
```

### 3.2 当前相关代码

| 模块 | 路径 | 职责 |
|-|-|-|
| 任务生命周期 | `src/agent-server/task-manager.mjs` | 创建任务、监听事件、判断完成、自动续跑 |
| ModelHub adapter | `src/runtime/modelhub-crawl-adapter.mjs` | 把 Responses 请求转换为 ModelHub crawl/chat 请求 |
| provider 配置 | `config/providers/modelhub-gpt55.json` | ModelHub 模型和环境变量配置 |
| 前端展示 | `web/app.js`, `web/styles.css` | 展示状态、过程、交付物卡片 |

### 3.3 当前已有但不够的保护

`task-manager.mjs` 已经有：

- `validateTaskCompletion`
- `hasCompletionEvidenceForTurn`
- `buildContinuationInput`
- 自动续跑次数限制

但它仍然不够，因为现在主要看“有没有一些交付相关证据”，没有在任务开始时定义“本任务必须交付什么”。

正确方向应该是：

```text
用户请求
  -> 提取 expectedArtifacts
  -> runtime 执行
  -> verifier 按 expectedArtifacts 检查真实结果
  -> 通过才 completed
  -> 不通过则 auto-continue 或 failed
```

## 4. 根因判断

### 4.1 完成判定过弱

当前逻辑容易接近：

```text
turn completed
+ 没有 pending tool request
+ 没有明显未完成 plan
= 任务完成
```

这对纯问答可以接受，但对文件、网页、飞书文档、代码修改类任务不可靠。

正确逻辑应该是：

```text
expected artifacts verified
= 任务完成
```

### 4.2 ModelHub adapter 损失了 Responses 语义

Codex 原生更依赖 Responses 协议里的结构化 tool call / tool result / item event。ModelHub 当前是 crawl/chat 风格，adapter 要做协议转换，风险包括：

- system / developer / user role 被扁平化后效果变弱。
- tool call id、顺序、tool result 对应关系可能不稳定。
- 模型返回自然语言中间态，但没有继续发 tool call。
- adapter 可能把“有文本输出”直接转回 message，而不是标记为 incomplete 行为。

### 4.3 工具失败后缺少强恢复

如果工具失败，例如：

- 写文件命令失败
- `lark-cli` 报错
- `git diff` 不是 git 仓库
- ModelHub timeout
- app-server 子进程异常

系统应当判断：

```text
工具失败 + 没有后续成功交付 = 不完成
```

而不是让模型的一句解释成为最终结果。

### 4.4 缺少交付物索引

前端目前主要从事件和最终文本里展示交付内容，但后端没有稳定维护一份“本任务交付物列表”。这会导致：

- UI 不知道哪些东西是最终产物，哪些只是过程。
- verifier 不知道该检查什么。
- 历史记录里很难判断任务是否真的完成。

## 5. 总体方案

增加一条明确的任务可靠性链路：

```text
Task Contract
  -> Runtime Execution
  -> Event Normalization
  -> Artifact Index
  -> Completion Verifier
  -> Auto Continuation / Failed / Completed
```

结合前面调研到的同类 adapter / OpenAI-compatible gateway / function calling 实践，ModelHub adapter 不能只理解成“把 HTTP 请求转一下”。它应该被设计成六个模块：

```text
ModelHub adapter
  = 协议翻译
  + 能力声明
  + tool call 闭环校验
  + stream / timeout / retry
  + tool error repair
  + artifact verifier
```

这六块和 CodePilot 当前问题的对应关系如下：

| 模块 | 要解决的问题 | 本方案落点 |
|-|-|-|
| 协议翻译 | 把 Codex Responses 风格请求转换为 ModelHub crawl/chat 请求，避免 role、tool call、tool result 语义丢失 | `modelhub-crawl-adapter.mjs` 的 request / response 转换与 protocol validator |
| 能力声明 | 明确 provider 是否支持 system/developer message、tool call、parallel tool call、streaming tool、image input 等能力 | provider config 增加 capability matrix，adapter 按能力降级或拒绝 |
| tool call 闭环校验 | assistant 发出的每个 tool call 必须有对应 tool result，id、顺序、role 必须闭环 | adapter 侧记录 call id，task-manager 侧把未闭环视为 incomplete |
| stream / timeout / retry | ModelHub 超时、断流、5xx 不能静默变成正常 final text | adapter 增加超时分类、可控重试和明确失败事件 |
| tool error repair | 工具失败后不能直接结束；应让模型修复参数、换方案或明确失败 | task-manager 把工具失败作为强 incomplete 信号，并用 continuation 推进修复 |
| artifact verifier | 模型说“写好了”不算完成，必须检查真实文件、链接、diff | `expectedArtifacts` + `artifactIndex` + `completionVerifier` |

调研结论里最重要的一点是：OpenAI-compatible adapter 要处理的不只是 API 形状，还包括模型能力差异和 tool loop 状态机。否则就会出现现在这种情况：模型返回了一段自然语言，协议上看是一个合法 assistant message，但产品语义上其实只是中间过程。

### 5.1 Task Contract

任务创建时，从用户输入里提取一个 `expectedArtifacts`。

示例：

```json
{
  "expectedArtifacts": [
    {
      "type": "local_file",
      "kind": "html",
      "required": true,
      "minCount": 1,
      "maxCount": 1,
      "group": "primary",
      "extensions": [".html"],
      "description": "可玩的 HTML 小游戏"
    },
    {
      "type": "local_file",
      "kind": "markdown",
      "required": true,
      "minCount": 1,
      "maxCount": 1,
      "group": "primary",
      "extensions": [".md"],
      "description": "游戏介绍 Markdown 文件"
    },
    {
      "type": "external_link",
      "kind": "lark_doc",
      "required": true,
      "minCount": 1,
      "maxCount": 1,
      "group": "primary",
      "urlPattern": "https://*.larkoffice.com/docx/*",
      "description": "飞书文档介绍"
    }
  ]
}
```

Contract 必须显式表达数量和组合关系，否则 verifier 会在模糊表达上误判。

第一版 schema 增加这些字段：

| 字段 | 含义 | 示例 |
|-|-|-|
| `minCount` | 至少需要几个 | “写几个 md” 如果无法判断具体数量，先设为 `1` 并把数量歧义写入 warning |
| `maxCount` | 最多或恰好几个；未知时为 `null` | “写 3 个 md” 可设 `minCount: 3, maxCount: 3` |
| `group` | 用于 AND / OR 分组 | 默认同一 `group` 内所有 required artifact 都必须满足 |
| `anyOf` | 表达“二选一 / 多选一” | “html 或 md 都行” 表达为 anyOf group |
| `required` | 是否必须满足 | “顺便可以写个 md” 可为 `false` |

组合规则：

- 默认是 AND：所有 `required: true` 的 artifact 都要满足。
- “A 或 B 都行”必须进入 `anyOf`，verifier 只要求任一分支满足。
- “写几个”这类数量不明表达，V1 不猜精确数量，按 `minCount: 1` 处理，并记录 `contractWarning`。
- “写 N 个”这类明确数量，按 `minCount: N, maxCount: N` 验证。

第一版先用确定性规则提取：

| 用户表达 | 期望交付物 |
|-|-|
| html、网页、页面、小游戏、可视化静态网页 | `.html` 文件 |
| md、markdown、说明文档、本地文档 | `.md` 文件 |
| 飞书文档、lark doc、docx 链接 | `larkoffice.com/docx/...` 链接 |
| 表格、csv | `.csv` 或飞书表格，按用户 wording 判断 |
| 修改代码、修 bug、开发功能 | git diff 或 changed files |
| 只问概念、解释、咨询 | text answer，无 artifact 要求 |

这不是 NLP 大模型分类，而是可控规则。后续可以加 LLM 辅助，但 deterministic contract 必须存在。

### 5.2 Artifact Index

后端维护 `task.artifacts`，来源包括：

- command execution 里明显创建的本地文件
- `turn.diff.updated`
- `fileChange`
- `lark-cli docs +create` 输出的 URL
- 最终文本中的 URL 和文件路径
- workspace 扫描得到的新文件

示例：

```json
{
  "artifacts": [
    {
      "type": "local_file",
      "path": "/Users/name/Documents/CodePilot Workspace/game.html",
      "extension": ".html",
      "exists": true,
      "sizeBytes": 18420,
      "source": "workspace_scan"
    },
    {
      "type": "external_link",
      "kind": "lark_doc",
      "url": "https://bytedance.larkoffice.com/docx/xxx",
      "source": "tool_output"
    }
  ]
}
```

Artifact Index 是后端真实状态，不依赖模型自称。

### 5.3 Completion Verifier

新增 `verifyTaskCompletion(task)`，它只做确定性检查。

每个 expected artifact 都有对应检查：

#### local_file

检查：

- 文件存在。
- 文件在 workspace 内，不在 app bundle/runtime 目录里。
- 扩展名匹配。
- 文件大小大于最小阈值。
- 对 HTML，可选检查包含 `<html`、`<script`、`<body` 或可运行基本结构。
- 对 Markdown，可选检查非空、标题/段落数量合理。

#### lark_doc

检查：

- 必须有 `lark-cli docs +create` 或等价飞书工具的成功输出。
- 必须从工具成功输出中提取到 `https://...larkoffice.com/docx/...` URL。
- 最终文本里出现的 URL 只能作为展示辅助，不能单独作为 completed 证据。
- 如果只有文本 URL，标记为 `unverified_link`，但 verifier 仍判定该 required artifact missing。

这条必须严格。否则模型可以编造一个看起来像 `larkoffice.com/docx/...` 的链接，pattern 匹配会误放行。

#### code_change

检查：

- git diff 有变更；或者
- workspace scan 有新文件/修改文件；或者
- Codex `turn.diff.updated` 有实际变更。

#### text_answer

纯问答不强制文件证据，但仍要检查：

- finalMessage 非空。
- 没有 pending tool request。
- 没有未完成 plan。

### 5.4 Auto Continuation

如果 verifier 不通过，且还有续跑预算：

1. 不把上一轮中间文本展示为最终结果。
2. 在过程区追加内部提示：

```text
运行提示：检测到任务未完成，继续推进。
```

3. 给模型发送内部 continuation：

```text
[CodePilot internal continuation]
检测到上一轮没有完成原始用户任务，请继续执行。
已完成交付物：
- local_file/html: game.html

缺失交付物：
- local_file/markdown: 未找到 .md 文件
- external_link/lark_doc: 未找到飞书文档链接

不要解释计划。请继续调用工具创建缺失交付物。
不要重做、覆盖或重复创建已完成交付物，除非必须修复明显错误。
只有在缺失项全部完成后，才输出最终结果。
```

4. 再次运行 verifier。
5. 超过续跑次数仍失败，则任务失败，并展示缺失项。

### 5.5 Adapter Protocol Validator

在 `modelhub-crawl-adapter.mjs` 增加协议校验和日志：

#### 请求侧

- 记录 tools 数量、input item 类型分布、是否含 function_call_output。
- 保证 assistant tool call 后必须有对应 tool output。
- role 转换前后保留 call id。
- 对 unsupported role 做明确转换策略，例如 developer 合并到 system，但要记录。

#### 响应侧

- 如果当前请求带 tools，但模型返回纯文本：
  - 如果没有 prior tool context，标记 `no_tool_call_final`。
  - 如果已有 prior tool context，标记 `final_text_after_tool_context`。
- 将这些 adapter behavior 事件传给 task manager，作为 completion verifier 的输入。
- 对明显中间态文本不直接报错，但不能单独触发 completed。

第一版不做强拦截，因为“纯文本”对纯问答是合法的。拦截应发生在 verifier 阶段。

### 5.6 Frontend 状态展示

前端不再只看最终文本，而是展示后端状态：

- `running`: 显示正在执行。
- `continuing`: 显示“检测到任务未完成，继续推进”。
- `failed`: 显示缺失交付物和可展开调试信息。
- `completed`: 优先展示最终结果和交付内容卡片。

成功任务默认：

```text
最终结果
交付内容
调试信息
```

失败任务默认：

```text
任务没有完成
已交付内容
缺失交付物
调试信息
```

失败态也必须展示已经真实产出的交付物。比如 HTML 和 Markdown 已经生成、飞书文档失败时，状态仍是 failed，但用户应该能看到并打开已经完成的两个本地文件。

## 6. 具体改造清单

### P0: 增加复现和日志

目标：先把问题稳定复现、可观察。

改动：

- 保留并整理 10 次重复测试脚本。
- 每次测试输出：
  - prompt
  - provider/model
  - workspace
  - status
  - finalMessage
  - expectedArtifacts
  - detectedArtifacts
  - missingArtifacts
  - adapter behavior events
  - tool failures

验收：

- 同一个 prompt 可以一键跑 10 次。
- 每次失败都能看出是缺文件、缺飞书链接、工具失败、模型中途停止还是 ModelHub timeout。

### P1: Task Contract

目标：任务开始时知道要交付什么。

改动：

- 新增 `src/agent-server/artifact-contract.mjs`。
- 在 `createTaskRecord` 时生成 `task.expectedArtifacts`。
- 支持 `minCount`、`maxCount`、`group`、`anyOf`、`contractWarning`。
- 写入 artifact JSON。
- 前端调试信息可显示 expected artifacts。

验收：

输入：

```text
写个html小游戏吧，再把游戏介绍写个飞书文档和md文件，都要
```

应生成：

- required html local file
- required markdown local file
- required lark doc link

### P2: Artifact Index

目标：系统能收集真实交付物。

改动：

- 新增 `src/agent-server/artifact-index.mjs`。
- 从事件、命令、最终文本、workspace scan 收集 artifacts。
- 本地文件必须验证存在。
- 飞书文档 URL 必须来自成功 tool output；最终文本 URL 只能标记为 unverified。

P2 有一个最小子集必须和 P3 同期完成：

- workspace 文件扫描
- git diff / changed files 检测
- lark-cli 成功输出 URL 提取

否则 P3 verifier 没有真实输入，只能回到“看模型文本”的老问题。

验收：

- 创建 `.html` 后 artifact JSON 里出现 local_file/html。
- 创建 `.md` 后 artifact JSON 里出现 local_file/markdown。
- 飞书工具成功创建文档后 artifact JSON 里出现 verified external_link/lark_doc。
- 最终文本里单独出现的飞书 URL 只能出现为 unverified，不足以 completed。

### P3: Completion Verifier

目标：任务完成状态由 verifier 决定。

改动：

- 新增 `src/agent-server/completion-verifier.mjs`。
- `validateTaskCompletion` 改为调用 verifier。
- verifier 输出：

```json
{
  "ok": false,
  "completedArtifacts": [
    {
      "type": "local_file",
      "kind": "html",
      "path": "/Users/name/Documents/CodePilot Workspace/game.html"
    }
  ],
  "missing": [
    {
      "type": "local_file",
      "kind": "html",
      "reason": "未找到 .html 文件"
    }
  ],
  "warnings": [],
  "evidence": []
}
```

验收：

- 没有 `.html` 时，任务不能 completed。
- 没有 `.md` 时，任务不能 completed。
- 没有经过工具成功输出验证的飞书 doc URL 时，任务不能 completed。
- 任务 failed 时仍返回已经完成的 `completedArtifacts`。
- 纯问答仍可以正常 completed。

### P4: Auto Continuation

目标：检测到未完成时自动继续，而不是把中间过程给用户。

改动：

- `buildContinuationInput` 接入 `missingArtifacts`。
- continuation prompt 同时带上 `completedArtifacts`，明确“已完成项不要重做”。
- 自动续跑事件更清晰：

```text
task.continuation.started
task.continuation.missing_artifacts
```

- 达到续跑上限后标记 failed。

验收：

- 模型只说“我会创建”时，系统继续跑。
- 续跑后有交付物则 completed。
- 续跑只针对缺失项，不重复创建或覆盖已完成交付物。
- 续跑后仍没有交付物则 failed，并显示缺失项。

### P5: ModelHub Adapter Robustness

目标：减少 tool loop 适配问题。

改动：

- 增加 request / response protocol debug summary。
- 校验 assistant tool call 与 tool output 对应关系。
- 对 tool call id 丢失或顺序异常写明确 adapter warning。
- 记录纯文本返回时的上下文：
  - no tools
  - tools available but no tool call
  - after tool context final text
- 可配置超时和重试策略：
  - ModelHub 5xx / timeout 可重试一次。
  - 非幂等工具不重复执行，只重试模型请求。

验收：

- 调试信息能看出 adapter 是不是把 tool loop 转坏了。
- tool call/result 缺失不会静默进入 completed。

### P6: Regression Test Suite

目标：用真实任务压测可用性，而不是只测 UI。

固定测试集：

| 用例 | 期望 |
|-|-|
| 你好 | 纯文本回答 |
| 写一个 md 文件介绍乔丹 | 生成 `.md` |
| 写一个 HTML 小游戏 | 生成 `.html` |
| 写 HTML 小游戏 + md 介绍 | 生成 `.html` + `.md` |
| 写 HTML 小游戏 + md + 飞书文档 | 三个交付物都存在 |
| 创建飞书文档介绍 CodePilot | 有 docx URL |
| 读取 workspace 文件并总结 | 有工具读取证据 + 文本 |
| 修改一个已有 bug | 有 diff 或文件变更 |
| 工具失败场景 | failed，不假完成 |
| ModelHub timeout 场景 | retry 或 failed，不假完成 |

验收标准：

- 不要求所有模型任务都 100% 成功。
- 但要求 0 次“无交付物却 completed”。
- 对核心任务，10 次中至少 8 次交付完整，才进入内测安装包。

## 7. 推荐实施顺序

### 第一步：P1 + P2-min + P3

先让系统知道“要什么”“有什么”和“缺什么”。这是核心。

产出：

- `artifact-contract.mjs`
- `artifact-index.mjs` 的最小子集：workspace scan、git diff、verified lark URL extraction
- `completion-verifier.mjs`
- `task.expectedArtifacts`
- `task.artifacts`
- `task.completionCheck`

### 第二步：P2-full

把真实交付物收集做完整。

产出：

- command/fileChange/final text 多来源归一
- verified / unverified artifact source 标注
- 前端交付物卡片来源统一

### 第三步：P4

让未完成任务自动续跑。

产出：

- 更明确的 continuation prompt
- 不展示中间话术为 final
- 缺失交付物失败提示

### 第四步：P5

补 ModelHub adapter 可观测性和协议校验。

产出：

- adapter behavior event
- protocol warning
- timeout/retry 配置

### 第五步：P6

跑回归测试，决定是否能重新打包。

产出：

- 10 次重复测试报告
- 失败分类
- 可进入内测的判断

## 8. 验收口径

这次改造成功不以“模型回答更像 Codex”为标准，而以“不会假完成”为第一标准。

必须满足：

1. 需要文件时，文件不存在不能 completed。
2. 需要飞书文档时，没有 docx URL 不能 completed。
3. 需要飞书文档时，只有最终文本里出现 docx URL 不能 completed；必须来自成功工具输出。
4. 需要多交付物时，缺一个也不能 completed。
5. failed 状态也要展示已真实交付的内容，不能让用户误以为全部失败。
6. 自动续跑只处理缺失项，不重复创建或覆盖已完成交付物。
7. 模型中间话术不能作为最终结果展示。
8. 失败要显示缺什么，而不是只显示“任务失败”。
9. 历史记录打开后能看到当时的 expected artifacts、detected artifacts、missing artifacts。

V1 verifier 的边界也要写清楚：

- 它保证交付物存在、位置安全、类型匹配、基本结构合法。
- 它不保证交付物内容质量完全满足用户意图。
- 例如 HTML verifier 可以检查文件存在、扩展名、基础 HTML 结构、非空脚本，但不承诺游戏设计好玩。
- 例如 Markdown verifier 可以检查文件存在、非空、基础 Markdown 结构，但不承诺文案质量达标。

可以暂时接受：

- ModelHub 仍然偶发失败。
- 某些复杂任务需要自动续跑。
- 飞书文档链接第一版不做深度打开校验，但必须来自成功工具输出，不能只靠文本 pattern。
- 内容质量只做基础结构校验，不在 V1 里判断“好不好”。

不能接受：

- 没有文件却说写好了。
- 没有飞书链接却说创建了。
- 工具失败后仍显示已完成。
- 用户看到的是“我将创建”这种过程话术，而不是最终交付结果。

## 9. 是否需要 LLM Verifier

第一版不建议把 LLM verifier 作为核心完成判定。

原因：

- LLM verifier 仍可能误判。
- 成本和时延都会增加。
- 对文件、URL、diff 这类交付物，确定性校验更可靠。

可以后续作为补充：

- 判断“这个 Markdown 内容是否真的覆盖用户要求”
- 判断“HTML 游戏是否主题正确”
- 判断“最终说明是否清楚”

但基础完成态必须由确定性 verifier 决定。

## 10. 最终效果示例

用户输入：

```text
写个html小游戏吧，再把游戏介绍写个飞书文档和md文件，都要
```

系统先生成 contract：

```text
需要交付：
- HTML 文件
- Markdown 文件
- 飞书文档链接
```

如果第一轮模型只输出：

```text
目录是空的，我会直接创建一个完整可玩的单文件 HTML 游戏，再配套 Markdown 说明。
```

系统不展示为最终结果，而是继续：

```text
运行提示：检测到任务未完成，继续推进。
缺失交付物：HTML 文件、Markdown 文件、飞书文档链接。
```

最终成功时展示：

```text
任务已完成。

交付内容：
- game.html
- game_intro.md
- 飞书文档：https://bytedance.larkoffice.com/docx/...
```

如果续跑后仍失败，展示：

```text
任务没有完成。

缺失交付物：
- HTML 文件：未在 workspace 中找到 .html 文件
- 飞书文档：未找到 docx 链接

调试信息中可以查看模型输出、工具调用和 adapter 事件。
```

## 11. 结论

这个问题要从“模型文本驱动”升级成“交付物验证驱动”。

Prompt 可以继续优化，但它只是降低失败率；真正防止假完成的是：

```text
Task Contract + Artifact Index + Completion Verifier + Auto Continuation
```

改完后，即使 ModelHub GPT-5.5 偶发不稳定，CodePilot 也不会把失败伪装成成功。这样才有资格继续打内部安装包给同事试用。
