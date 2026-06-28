# Apeiron

Apeiron 是一个面向代码仓库的项目记忆与上下文准备 agent。它的目标是在每次任务开始前，为 agent 提供一份紧凑、可审查、随代码演进的项目地图，提升跨任务维护中的上下文连续性。

当前实现是一个 TypeScript monorepo：

- `@apeiron/core`：负责 memory、inventory、覆盖扫描、context pack、LLM work/warmup/refresh runner、session 记录、git 集成和工具边界。
- `@apeiron/vscode-extension`：负责 VS Code 扩展，包括聊天 Webview、命令面板命令、provider 设置、上下文检查、memory map、session、附件、refresh 摘要和 diff 入口。

更完整的产品与架构背景见 `docs/apeiron-agent-design-v0.md`。

## 核心思路

Apeiron 会在目标仓库中维护一个 `.apeiron/` 目录：

```text
.apeiron/
  ignore.md
  .gitignore
  memory/
    PROJECT.md
    MODULES.md
    CONVENTIONS.md
    TESTING.md
    MEMORY.md
    inventory.json
    modules/
    files/
  sessions/
  context-packs/
  attachments/
```

`memory/` 是持久项目地图，既给人阅读，也给 agent 复用，设计上应随代码一起进入版本控制。`inventory.json` 是机器可解析的主索引，记录每个文件的 kind、status、summaryRef、hash 和 refresh 时间。

`sessions/`、`context-packs/` 和 `attachments/` 是运行痕迹。初始化生成的 `.apeiron/.gitignore` 默认会排除它们。

## 核心概念

`warmup` 用于建立或扩展项目记忆。full warmup 目标是覆盖所有未忽略文件；scoped warmup 围绕某个目标或区域展开，允许 scope 外文件保持 `unread`，但必须有原因。

`context pack` 是一次模型调用会携带的小型上下文托盘，内容可以来自 memory、文件、diff、附件和工具结果。它面向当前任务组织上下文，并保留每个上下文项的来源、状态和开关。

`work` 是编码 agent 的执行阶段。work 工具可以读取、搜索、编辑源码文件、删除文件和运行命令；`.apeiron` memory 的更新由后续 refresh 阶段处理。

`refresh` 在 work 之后更新项目记忆。它会根据工具轨迹和 git 状态得到 refresh targets，然后由 memory agent 重新查看当前源码、diff、inventory 条目和已有 summary，再更新 `.apeiron/memory`。

`blocked turn` 表示上一轮 work 仍有 refresh 未完成。Apeiron 会拒绝开始新的 work turn，直到该 refresh 完成或被明确处理，避免代码和项目记忆悄悄漂移。

## 环境要求

- Node.js `>=20.0.0`
- npm workspaces
- `PATH` 中可用的 Git
- 用于扩展开发的 VS Code `^1.102.0`
- 用于 LLM warmup/work/refresh 的 OpenAI-compatible LLM endpoint

## 安装

```bash
npm install
```

## 构建与测试

```bash
npm run build
npm run check
npm test
```

`npm test` 会先执行 TypeScript 检查，再运行 `packages/core/test/*.test.mjs` 中的 Node 测试。

这些测试导入编译后的 `dist` 文件，覆盖 coverage scan、inventory 行为、context pack、refresh target、turn boundary、memory tools、memory diff、warmup inventory 和 provider retry 等核心策略。测试范围集中在本地策略和工具边界，不涉及真实 LLM provider 调用。

## LLM 配置

Core 会从环境变量读取 provider 设置：

```bash
APEIRON_MODEL_API=openai-completions
APEIRON_OPENAI_BASE_URL=https://your-provider.example/v1
APEIRON_OPENAI_API_KEY=...
APEIRON_MODEL=your-model
APEIRON_REASONING=medium
APEIRON_LLM_RETRY_ATTEMPTS=3
APEIRON_LLM_RETRY_DELAY_MS=1000
APEIRON_LLM_RETRY_BACKOFF=2
```

当前主 provider 路径只接通了 `openai-completions`。VS Code Webview 的 Settings tab 也可以配置 base URL、model、provider label、reasoning、retry 和 API key。API key 存在 VS Code SecretStorage 中，不会写入仓库。

## CLI

根目录脚本会调用编译后的 core CLI：

```bash
npm run apeiron -- <command>
```

常用命令：

```bash
npm run apeiron -- init
npm run apeiron -- scan
npm run apeiron -- context "Understand the extension chat flow"
npm run apeiron -- warmup-llm . --mode scoped --goal "Understand the core memory flow"
npm run apeiron -- work-run "Make a small targeted change"
npm run apeiron -- git-status
npm run apeiron -- git-refresh-targets
npm run apeiron -- memory-diff
```

命令分组说明：

- `init`：创建 `.apeiron/`、基础 memory 文件、ignore 规则和初始 inventory。
- `scan`：将当前 workspace 与 `inventory.json` 做覆盖状态对比。
- `context`：为一个任务生成 context pack。
- `warmup-llm`：让 memory agent 建立项目记忆。
- `work-run`：运行 work agent，默认会在结束后自动 refresh memory。
- `refresh-plan`、`refresh`、`refresh-llm`：为显式 targets 规划或执行 memory refresh。
- `git-status`、`git-refresh-targets`、`git-diff`：查看 git 变化状态。
- `memory-diff`：汇总 `.apeiron/memory` 的变更。

## VS Code 扩展

先构建或检查 workspace，然后从 VS Code 启动 Extension Development Host：

```bash
npm run check
```

使用已有调试配置：

```text
Run Apeiron Extension
```

该配置会以 `packages/vscode-extension` 作为 extension root 启动 Extension Development Host。

扩展贡献了这些命令：

- `Apeiron: Open Chat`
- `Apeiron: Init`
- `Apeiron: Scan`
- `Apeiron: Create Context Pack`
- `Apeiron: Create Refresh Plan`
- `Apeiron: Refresh`
- `Apeiron: Warmup LLM`
- `Apeiron: Refresh LLM`
- `Apeiron: Work Run LLM`
- `Apeiron: Git Status`
- `Apeiron: Git Refresh Targets`

`Apeiron: Open Chat` 会打开主 Webview。当前 Webview 包含：

- 聊天任务输入和运行中的 agent commentary
- full/scoped warmup 控制
- stop/abort 控制
- steering 和 follow-up 队列
- context item 检查和开关
- 来自 `inventory.json` 的 memory map
- refresh 摘要和 memory diff 入口
- code 与 memory 变更链接
- session 和 checkpoint 浏览
- 文本/图片附件
- provider 设置和 provider 测试动作

当前还没有 contributed VS Code settings 或 Activity Bar views；现有 UI 是一个 Webview panel 加 `Apeiron` Output Channel。

## 项目结构

```text
packages/
  core/
    src/
      agent/       work loop、finalization、turn change boundary
      llm/         OpenAI-compatible provider 选项和 Pi AI wrapper
      memory/      inventory、coverage、warmup、refresh、context pack、memory tools
      repo/        文件列表、搜索、git status/diff、path/hash helpers
      session/     JSONL sessions、checkpoints、turn index
      tools/       work run 使用的 tracked repo tools
    test/          core 策略的 Node 测试套件

  vscode-extension/
    src/
      extension.ts 命令注册
      chat/        Webview controller、HTML、state、settings、UI helpers
      output.ts    Output Channel wrapper
      targets.ts   refresh target picker
      workspace.ts workspace root 解析
```

## Memory 规则

重要不变量：

- `documented` 和 `grouped` inventory entry 必须有有效的 `summaryRef`。
- ignored 文件必须有具体原因。
- `MEMORY.md` 只记录长期维护事实，避免写入临时任务过程。
- work 工具不能编辑 `.apeiron/`；memory 更新由 refresh 负责。
- memory 工具可以写 `.apeiron/memory` 并更新 inventory。
- scoped warmup 可以留下 unread 文件，但 unread 文件需要原因。
- refresh 只应在当前代码事实需要时更新项目记忆。

## 当前限制

- LLM-powered 流程需要 OpenAI-compatible provider。
- provider Settings tab 展示了一些面向未来的格式，但当前只真正接通 OpenAI-compatible settings。
- 测试覆盖 core 行为和策略，不覆盖完整端到端 LLM run。
- 设计文档描述的是更完整的产品方向；本 README 描述当前仓库结构和已实现入口。
