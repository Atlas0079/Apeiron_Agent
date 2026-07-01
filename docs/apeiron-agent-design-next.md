# Apeiron 后续设计记录

这份文档记录 v0 之后的设计更新。`docs/apeiron-agent-design-v0.md` 已经覆盖了第一阶段的产品模型和核心闭环；后续讨论中形成的新协议、边界和取舍，先集中写在这里，等实现稳定后再拆分到更正式的规格文档。

## 1. 对话 transcript 与 context pack 的边界

Apeiron 需要同时维护两类上下文：

```text
conversation transcript
  用户真实发送的消息
  assistant 面向用户说出的自然语言消息
  action/tool result 消息
  steering / follow-up 消息

context pack
  不直接出现在对话流中的隐藏工作托盘
  项目 memory
  pin 的文件内容
  diff
  attachment 内容
  coverage / inventory 状态
  session 或工具结果派生出的背景项
```

关键边界：

- assistant 的自然语言输出属于 conversation transcript。
- 这些自然语言输出应像正常聊天一样进入下一轮 LLM 输入。
- context pack 只管理不直接出现在对话内的背景上下文。
- context pack item 应可检查、可启用/禁用、可追踪来源。
- tool/action result 可以进入 transcript，但 UI 可以默认折叠展示。

因此，模型输入应由几部分组成：

```text
model input =
  system prompt
  + conversation transcript
  + enabled context pack items
  + latest action/tool results
```

其中 `conversation transcript` 负责对话连续性，`context pack` 负责隐藏上下文的可见性和选择控制。

## 2. Assistant step 与 action batch

后续 agent loop 可以保留 JSON action protocol，但不必限制为每轮只输出一个 action。

每次模型输出一个 assistant step：

```ts
interface AssistantStep {
  message: string;
  actions: ApeironAction[];
  done?: boolean;
}
```

语义：

- `message` 是 assistant 面向用户的自然语言消息，写入 transcript。
- `actions` 是本 step 要执行的一批协议动作。
- `done: true` 表示本次 run 自然结束。
- `done: true` 时原则上不再携带 actions。
- `actions` 可以为空，用于纯说明或最终回复。

示例：

```json
{
  "message": "我先检查项目结构和核心入口，确认 README 应该覆盖哪些内容。",
  "actions": [
    { "id": "a1", "type": "list_files" },
    { "id": "a2", "type": "read_file", "path": "package.json" }
  ]
}
```

最终 step：

```json
{
  "message": "README 已更新，主要包括项目定位、使用方式和 memory 规则。",
  "actions": [],
  "done": true
}
```

## 3. Action result message

action 执行完成后，系统生成 action result message，作为 transcript 的一部分反馈给模型：

```ts
interface ActionResultMessage {
  role: "action_result";
  stepId: string;
  results: ApeironActionResult[];
  visible: "collapsed" | "hidden" | "expanded";
}
```

语义：

- action result 是对话内的证据，下一轮 LLM 应能读取。
- UI 默认可以折叠 action result，只展示摘要。
- 长输出应截断或摘要化，并保留完整结果入口。
- action result 可以派生 context pack item，但二者不是同一个概念。

示例：

```json
{
  "role": "action_result",
  "stepId": "step-1",
  "visible": "collapsed",
  "results": [
    {
      "id": "a1",
      "type": "list_files",
      "ok": true,
      "summary": "Found 42 files"
    },
    {
      "id": "a2",
      "type": "read_file",
      "ok": true,
      "summary": "Read package.json",
      "content": "{ ... truncated ... }"
    }
  ]
}
```

## 4. 用户体验目标

用户看到的体验应接近一个连续运行中的 assistant 消息：

```text
assistant message
  自然语言说明
  action batch 摘要
  action result 摘要
  后续自然语言说明
  action batch 摘要
  ...
  最终回复
```

内部可以拆成多个 assistant step 和 action result message；UI 可以把它们合并成同一个正在运行的 assistant turn。

用户在 run 未结束时仍可插入：

- `steering`：在当前 action batch 完成后、下一次模型调用前注入 transcript。
- `follow-up`：在当前 run 准备自然结束时注入，作为后续请求继续执行。

这能保留 Codex 类体验：assistant 还在工作，用户尚未正式接回输入权，但可以中途修正方向或排队后续任务。

## 5. 对 loop 的要求

后续 loop 应至少支持：

- 一次 assistant step 输出多个 actions。
- action 必须有稳定 `id`。
- action batch 默认顺序执行。
- 读类 action 后续可以声明为可并行执行。
- 写类 action、删除 action、命令 action 默认顺序执行。
- 每个 action 都经过 prepare / execute / finalize 三段。
- assistant `message` 写入 transcript，而不是 context pack。
- action result 写入 transcript，UI 可折叠。
- context pack 只管理隐藏上下文项。
- steering 在 action batch 完成后注入。
- follow-up 在 run 准备结束时注入。

## 6. 设计取舍

Apeiron 可以继续使用 JSON action protocol。专业性不取决于是否使用 provider-native tool call，而取决于协议是否清楚、可验证、可恢复、可审计。

JSON action protocol 对 Apeiron 有几个优势：

- 易于把 memory maintenance 的每一步持久化和审计。
- 易于在 audit 拒绝 finish 后继续使用同一协议推进。
- 易于跨 provider 保持稳定行为。
- 易于把 action、action result、context pack 和 memory refresh target 对齐。

后续重点应放在协议层和 loop 边界：

- `AssistantStep`
- `ApeironAction`
- `ActionResultMessage`
- `ContextPackItem`
- `RunEvent`

这些类型稳定后，再决定是否接入 Pi 的 agent loop 思想或实现一个 Apeiron 自己的 lightweight loop。

## 7. Loop 落地计划

后续实现不直接替换现有 warmup / refresh / work runner。先新增协议层和通用 JSON loop，等测试稳定后再逐步迁移。

目标：

- 保留 JSON action protocol。
- 支持 assistant 一次输出自然语言消息和多个 actions。
- assistant 自然语言消息进入 conversation transcript。
- action result 进入 transcript，UI 可以折叠展示。
- context pack 继续只管理隐藏上下文。
- warmup / refresh / work 共享同一个 loop 基础设施。
- loop 本身不理解 inventory、memory、refresh target 等 Apeiron 产品语义。

非目标：

- 第一阶段不迁移到 provider-native tool calling。
- 第一阶段不复用或复制 Pi 的 loop 实现。
- 第一阶段不重写 VS Code Webview。
- 第一阶段不改变 `.apeiron/memory` 文件格式。

### 7.1 新增模块

建议新增目录：

```text
packages/core/src/agent-loop/
  protocol.ts
  json-loop.ts
  events.ts
  transcript.ts
```

职责：

- `protocol.ts` 定义 `AssistantStep`、`ApeironAction`、`ApeironActionResult`、`ActionResultMessage` 等协议类型。
- `events.ts` 定义 loop 事件类型，如 `run_start`、`assistant_message`、`action_start`、`action_end`、`run_end`。
- `transcript.ts` 定义 transcript message 结构和 append/format helpers。
- `json-loop.ts` 实现通用 JSON action loop。

根导出 `packages/core/src/index.ts` 后续应 re-export 这些类型和 loop。

### 7.2 协议草案

```ts
export interface AssistantStep<TFinish = unknown> {
  message: string;
  actions: ApeironAction[];
  done?: boolean;
  result?: TFinish;
}

export interface ApeironAction {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface ApeironActionResult {
  id: string;
  type: string;
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
}

export interface ActionResultMessage {
  role: "action_result";
  stepId: string;
  results: ApeironActionResult[];
  visible: "collapsed" | "hidden" | "expanded";
}
```

约束：

- `message` 必须是用户可见文本，并写入 transcript。
- `actions` 默认为顺序执行。
- `done: true` 时原则上 `actions` 为空。
- `done: true` 可携带 `result`，用于 warmup / refresh / work 的最终结构化结果。
- 所有 action 必须有稳定 `id`。
- action id 在同一个 run 内应唯一。

### 7.3 Loop 输入输出

通用 loop 输入大致为：

```ts
export interface JsonAgentLoopInput<TFinish = unknown> {
  systemPrompt: string;
  initialTranscript: TranscriptMessage[];
  maxSteps: number;
  completeStep(input: JsonAgentModelInput): Promise<AssistantStep<TFinish>>;
  executeAction(action: ApeironAction, context: ExecuteActionContext): Promise<ApeironActionResult>;
  buildModelInput(input: BuildModelInputContext): Promise<JsonAgentModelInput>;
  auditFinish?: (input: AuditFinishInput<TFinish>) => Promise<AuditFinishResult>;
  drainSteering?: () => Promise<TranscriptMessage[]>;
  drainFollowUp?: () => Promise<TranscriptMessage[]>;
  onEvent?: (event: JsonAgentLoopEvent) => void;
  abortSignal?: AbortSignal;
}
```

输出：

```ts
export interface JsonAgentLoopResult<TFinish = unknown> {
  done: boolean;
  result?: TFinish;
  transcript: TranscriptMessage[];
  events: JsonAgentLoopEvent[];
  steps: number;
  stopReason: "done" | "max-steps" | "aborted";
}
```

### 7.4 Loop 行为

主流程：

```text
run_start

while step < maxSteps:
  build model input from system prompt + transcript + enabled context pack items
  ask model for AssistantStep JSON
  append assistant message to transcript
  emit assistant_message

  if step.done:
    run auditFinish if provided
    if audit rejects:
      append audit rejection as action_result / system feedback
      continue
    run_end
    return

  prepare and execute action batch
  append action_result message to transcript
  emit action_start / action_end

  drain steering
  append steering messages to transcript

if maxSteps reached:
  request or synthesize final step
```

后续 follow-up 行为：

- 当 loop 准备自然结束时检查 `drainFollowUp`。
- 如果存在 follow-up，则作为 transcript message 注入并继续执行。
- 第一阶段可以先只实现 steering，follow-up 留到第二阶段。

### 7.5 Audit 语义

`done + result` 替代当前 memory agent 中的 `finish` action。

当模型输出：

```json
{
  "message": "我已经完成 refresh target 检查。",
  "actions": [],
  "done": true,
  "result": {
    "checked": [],
    "updatedMemoryFiles": [],
    "blocked": []
  }
}
```

loop 调用 `auditFinish`。

如果 audit 允许：

- 结束 run。
- 返回结构化 `result`。

如果 audit 拒绝：

- 不结束 run。
- 把 audit 结果作为 transcript feedback 追加给模型。
- 下一步模型继续输出新的 `AssistantStep`。

这保留了 v0 中 “finish 被 audit 拒绝后继续工作” 的语义。

### 7.6 迁移顺序

第一阶段：只新增 loop，不迁移业务 runner。

1. 新增协议类型。
2. 新增 `runJsonAgentLoop`。
3. 新增单元测试，使用 fake LLM 和 fake tools。
4. 从 `index.ts` 导出协议和 loop。

第二阶段：迁移 memory agent。

1. 将 `runMemoryAgent` 改为调用 `runJsonAgentLoop`。
2. 保留现有 `MemoryAgentTools`。
3. 将现有 single action 协议升级为 assistant step 协议。
4. 将 `finish` action 改为 `done + result`。
5. 保持 `runLlmWarmup` 和 `runLlmRefresh` 的对外返回类型不变。

第三阶段：迁移 work agent。

1. 将 `runLlmWork` 改为调用 `runJsonAgentLoop`。
2. 保留 `TrackedRepoTools`。
3. action batch 支持多个 read/search。
4. 写入、删除、命令先保持顺序执行。
5. 保持 `finalizeWorkRun` 的对外语义不变。

第四阶段：VS Code UI 适配。

1. 将多个 assistant step 合并展示为一个 running assistant message。
2. action result 默认折叠。
3. context pack tab 只展示隐藏上下文项。
4. conversation transcript 中展示 assistant 自然语言和 action 摘要。

### 7.7 测试策略

新增 `packages/core/test/json-agent-loop.test.mjs`。

优先覆盖：

- assistant `message` 会进入 transcript。
- 单 step 多 actions 会按顺序执行。
- action result message 会进入 transcript。
- `done: true` 会结束 run。
- `done + result` 会返回结构化结果。
- audit 允许时结束。
- audit 拒绝时，audit feedback 进入 transcript，模型继续下一 step。
- steering 在 action batch 完成后进入 transcript。
- action 执行失败会生成 `ok: false` result，而不是直接中断 loop。
- abort signal 会停止 loop。
- maxSteps 会产生明确 `stopReason`。

这些测试不调用真实 LLM。

### 7.8 风险与注意事项

- 不要让 loop 直接读写 `.apeiron`，这些应属于具体 tool。
- 不要让 loop 直接理解 warmup / refresh / work。
- 不要把 context pack item 混入 conversation transcript。
- 不要把 assistant message 当作 UI-only commentary。
- 不要在第一阶段引入并行写操作。
- 不要改变现有 runner 对外 API，迁移阶段应保持兼容。
