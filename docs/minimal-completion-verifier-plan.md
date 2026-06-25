# CodePilot Minimal Completion Verifier Plan

Last updated: 2026-06-24

## 1. 为什么要改成最小方案

上一版方案偏长期架构：Task Contract、Artifact Index、Capability Matrix、Tool Repair、完整 Regression Suite 都做。这是正确方向，但对当前问题来说太重。

现在最急的问题只有一个：

> 模型有时只输出中间过程，但系统把它当成任务完成。

所以第一版不做复杂 contract engine，只在现有 Codex tool loop 后面加一个轻量完成检查。

目标不是让模型 100% 成功，而是先做到：

- 真完成才显示 completed。
- 没完成就继续一次或明确失败。
- 失败时展示原因和已产出的文件。
- 不把“我会创建 / 我将继续”当成最终结果。

## 2. 最小改动原则

只改三件事：

```text
1. 轻量识别用户要不要交付物
2. 任务结束时检查交付物是否真的存在
3. 未完成时最多续跑一次，否则明确失败
```

不做：

- 不做复杂 `anyOf` / `group` / `minCount` schema。
- 不做 LLM verifier。
- 不做完整 provider capability matrix。
- 不做大规模重构。
- 不追求内容质量判断。

## 3. 最小链路

现有链路保持不变：

```text
Frontend
  -> task-manager
  -> Codex app-server
  -> ModelHub adapter
  -> ModelHub GPT-5.5
  -> tool loop
```

只在 turn completed 后加一步：

```text
turn completed
  -> lightweight verifier
  -> completed / continue_once / failed
```

## 4. 轻量识别规则

从用户 prompt 里只识别最常见的硬交付物。

| 用户表达 | 检查项 |
|-|-|
| html、网页、小游戏、页面 | workspace 内是否新增 `.html` |
| md、markdown、说明文档 | workspace 内是否新增 `.md` |
| 飞书文档、lark doc、docx | 是否有工具成功返回的 `larkoffice.com/docx/...` URL |
| 修改、修复、开发、实现 | 是否有 git diff 或文件变更 |
| 你好、解释、咨询、问答 | 不做 artifact 检查，沿用现有完成逻辑 |

模糊表达先保守处理：

- “写几个 md”：第一版只要求至少 1 个 `.md`。
- “html 或 md 都行”：第一版先不强行识别 OR，按文本里更明确的一个处理；如果两个都很明确，可以要求至少一个本地交付物存在。
- “顺便可以写个 md”：第一版可以先不识别“可选”，避免过度复杂。

这不是最终版，只是为了先解决假完成。

## 5. 检查方式

### 5.1 本地文件

在任务开始时记录 workspace baseline：

```text
filesBefore = workspace files snapshot
```

任务结束时扫描：

```text
filesAfter = workspace files snapshot
newOrChangedFiles = filesAfter - filesBefore
```

检查：

- `.html` 是否新增或修改。
- `.md` 是否新增或修改。
- 文件必须在用户 workspace 内。
- 文件不能在 `.app/Contents/Resources` 里。
- 文件大小大于一个很小阈值，例如 20 bytes。

### 5.2 飞书文档

飞书文档不要只看最终文本里的 URL。

第一版只采信：

- `lark-cli docs +create` 或等价工具成功执行。
- 工具输出里出现 `https://...larkoffice.com/docx/...`。

如果最终文本里出现一个飞书 URL，但没有工具成功输出：

```text
不算完成，只作为 unverified link 记录。
```

### 5.3 代码修改

检查：

- git diff 有变化；或
- workspace 有新增/修改文件。

非 git workspace 不因为 `git diff` 失败就判失败，只看文件变化。

## 6. Verifier 状态机

verifier 不应该只有 completed / not completed 两种。

第一版用三个结果：

```text
completed
continue_once
failed
```

### completed

所有明确要求的交付物都找到了。

### continue_once

缺交付物，但没有明显客观失败，而且看起来还有继续空间。

例子：

- 模型只说“我会创建一个 HTML”但没调用工具。
- 只创建了 HTML，没创建 MD。
- 没有明显认证、权限、网络错误。

处理：

```text
不展示中间话术为最终结果。
自动补一轮：
检测到任务未完成，请只补齐缺失项，不要重做已完成项。
```

### failed

缺交付物，并且继续也大概率没用，或者已经续跑过仍失败。

客观失败包括：

- `MODELHUB_AK is not set`
- 网络超时多次
- 飞书认证失败
- `lark-cli` 不存在
- 没有访问权限
- workspace 不可写
- 工具命令明确失败且没有后续成功恢复

处理：

```text
任务失败，但展示：
- 已交付内容
- 缺失内容
- 失败原因
- 调试信息
```

## 7. 客观原因导致失败时怎么办

不会一直不完成。

规则是：

```text
缺交付物 + 可恢复 = 最多自动续跑一次
缺交付物 + 明确客观失败 = 直接 failed
缺交付物 + 续跑后仍无进展 = failed
```

比如用户要飞书文档，但飞书认证失败：

```text
状态：failed
原因：飞书认证失败，无法创建文档
已交付：如果 HTML / MD 已经生成，则照常展示
缺失：飞书文档
```

这不是“卡住不完成”，而是明确告诉用户：任务没完成，原因是客观阻塞。

## 8. 最小实现位置

建议只新增一个小模块：

```text
src/agent-server/lightweight-completion-verifier.mjs
```

改动现有：

```text
src/agent-server/task-manager.mjs
```

主要接入点：

1. task 创建时记录 workspace baseline。
2. turn completed 后调用 verifier。
3. verifier 返回 `completed`，走原完成逻辑。
4. verifier 返回 `continue_once`，自动续跑一次。
5. verifier 返回 `failed`，标记 failed，并写入缺失项和已交付项。

前端只做小改：

```text
web/app.js
web/styles.css
```

展示：

- completed：最终结果 + 交付内容。
- failed：失败原因 + 已交付内容 + 缺失内容。
- continuing：运行提示“检测到任务未完成，继续推进”。

## 9. 最小验收

第一版只验收这几个 case：

| Case | 期望 |
|-|-|
| 你好 | 正常回答，不要求文件 |
| 写个 md 文件 | 没有 `.md` 不能 completed |
| 写个 html 小游戏 | 没有 `.html` 不能 completed |
| 写 html + md | 缺任一个不能 completed |
| 写 html + md + 飞书文档 | 缺任一个不能 completed，但 failed 时展示已产出的文件 |
| 飞书认证失败 | failed，不无限续跑 |
| 模型只说“我会创建” | 自动续跑一次，不展示为最终结果 |
| 续跑后仍无文件 | failed，显示缺失文件 |

硬指标：

```text
无交付物却 completed = 0 次
```

软指标：

```text
复杂任务成功率后续再优化
```

## 10. 和长期方案的关系

最小方案解决的是：

```text
不要假完成
```

长期方案再解决：

```text
更复杂的数量语义
OR / optional artifact
provider capability matrix
tool call 闭环严格校验
更完整的 retry / repair
内容质量 verifier
```

所以推荐顺序是：

```text
先做最小 verifier
再根据测试失败类型补长期能力
```
