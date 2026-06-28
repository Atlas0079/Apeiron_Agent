# Apeiron Agent 初版设计 v0

## 1. 定位

Apeiron Agent 是一个项目维护型 agent。

它要解决的核心问题是项目连续性：

- coding agent 每次开始新对话时，都缺少足够的项目上下文。
- 旧对话里有有用发现，但也混有过期上下文和任务噪音。
- 仓库已经变化后，直接复用旧对话是不安全的。
- 大型项目无法完整塞进模型上下文。

Apeiron 应该维护一份持续演化的项目记忆，并在正式编码前，把这份记忆作为 agent 的起始工作托盘。agent 从摘要开始，自主决定还需要读取哪些真实代码。

第一版优先优化：

- 随时间理解一个仓库；
- 基于当前代码和项目记忆提供一个可审查的起始上下文托盘；
- 每次任务完成后自动更新项目记忆；
- 保持实现足够小，方便推理和迭代。


## 2. 产品形态

Agent 有三个主要流程：

```text
warmup  -> 建立或扩大项目记忆，建立 inventory 覆盖和 summaryRef
work    -> 基于项目记忆和当前仓库状态完成编码任务
refresh -> 增量同步，把当前代码变化写回相关项目记忆
```

正常使用时，`work` 在任务完成后自动运行 `refresh`。

Warmup 不只有一种形态：

```text
full warmup
  主动覆盖整个仓库，目标是让所有未忽略文件都进入 documented / grouped / ignored。

scoped warmup
  针对某个任务、模块或路径集合深读，同时建立整个项目的粗粒度描述。
  未进入本次 scope 的文件可以显式标记为 unread。

opportunistic warmup
  在 work 过程中，agent 因任务需要自然读取到 unread 文件。
  refresh 阶段可以把这些已经读过的文件顺手补进项目记忆。
```

面向用户的心智模型：

```text
Agent 先预热一次，然后随着工作推进持续维护项目地图。
新任务从项目地图开始，而不是从臃肿的旧聊天开始。
项目地图可以先局部可用，再随着真实维护工作逐步长大。
```

## 3. 核心原则

不要加载整个项目。

取而代之：

1. 构建一份紧凑的项目地图。
2. 将项目记忆存储在文件中。
3. 每个任务开始前，生成一份小型上下文托盘。
4. agent 只有在需要时才读取真实源码文件，并把本轮读到的内容加入工作托盘。
5. 代码变化后，由 refresh agent 根据真实 diff、工具轨迹和验收标准更新记忆。

项目记忆允许不完整。未知区域不需要强行总结，等后续 warmup 或任务过程中发现即可。

## 4. 初始记忆文件

第一版的记忆应保持人类可读、容易检查。

建议目录：

```text
.apeiron/
  ignore.md
  .gitignore
  memory/
    PROJECT.md
    MODULES.md
    inventory.json
    CONVENTIONS.md
    TESTING.md
    MEMORY.md
    modules/
      <module-id>.md
    files/
      <source-path>.md
  sessions/
  context-packs/
```

`.apeiron/memory/` 应进入 git。项目记忆描述的是当前仓库的结构、约定和维护经验，必须和代码处于同一个版本历史中。代码回退时，项目记忆也应该随之回退。

session、context pack 和附件是运行过程痕迹，默认应被 git ignore。

建议 `.apeiron/.gitignore`：

```gitignore
sessions/
context-packs/
attachments/
```

`.apeiron/ignore.md` 是 agent 的忽略规则配置。它会影响 warmup、工具列表展示和默认噪音控制，因此默认也应进入 git，让团队和仓库版本共享同一套 agent 忽略规则。

### PROJECT.md

用途：简短的仓库总览。

应包含：

- 项目目的；
- 主要语言和框架；
- 重要入口；
- 如果已知，如何本地运行；
- 高层级仓库结构。

### MODULES.md

用途：模块索引。

每个模块条目应包含：

- 路径；
- 职责；
- 对应的 `modules/<module-id>.md`；
- 重要 runtime 文件；
- 如果已知，相关测试；
- 与其他模块的重要耦合关系。

不要写置信度分数。只有当内容能被 warmup 或 work 阶段读过的文件支撑时，才把它写成直接事实。

### inventory.json

用途：文件和目录清单的机器可解析主数据源。

Inventory 记录每个被识别的目录和文件的分类、用途、文档状态、覆盖原因和源码指纹。它不是完整源码解释，而是项目文件地图。

第一版用 JSON 作为主数据源，避免 Markdown 表格在频繁增量更新时产生解析和格式漂移问题。未来可以生成只读的 `INVENTORY.md` 作为人类展示层，但 v0 不依赖它。

Warmup 或 coverage scan 完成后，仓库中的每个文件都必须能在 `inventory.json` 中找到状态。每个文件必须处于以下状态之一：

```text
documented   文件已读取，并有独立总结文档
grouped      文件已读取，归属于一个多文件总结
ignored      文件被忽略，并有明确原因
unread       文件已发现，但尚未语义读取
stale        文件已变化，对应总结可能落后于源码
missing-ref  文件应有 summaryRef，但 summaryRef 缺失或无法解析
```

核心不变量：

```text
每个当前文件树中的文件都必须有 inventory 条目，除非 coverage scan 尚未完成。
documented 和 grouped 文件必须至少读取过一次。
documented 和 grouped 文件必须有 summaryRef。
每个 ignored 文件都必须有 ignore reason。
unread 是合法状态，用于 scoped warmup 或延迟读取，不代表系统故障。
```

建议分类：

```text
runtime      实际运行逻辑
test         测试
config       配置
docs         文档
generated    生成产物
asset        静态资源
log          日志
vendor       第三方代码
unknown      暂未判断
```

每个条目应包含：

- path；
- kind；
- status；
- summaryRef；
- 一句话用途；
- 是否有详细文件文档；
- 如果被忽略，说明忽略原因。
- 如果未读取，说明未读取原因；
- 文件 hash 或其他 stale 检测指纹；
- 最后读取时间；
- 最后 refresh 时间。

建议格式：

```json
{
  "version": 1,
  "workspaceRoot": ".",
  "coverage": {
    "mode": "scoped",
    "scope": ["packages/coding-agent/src/core"],
    "createdAt": "2026-06-27T00:00:00.000Z",
    "lastFullWarmupAt": null
  },
  "files": {
    "src/server.ts": {
      "kind": "runtime",
      "status": "documented",
      "summaryRef": ".apeiron/memory/files/src/server.ts.md",
      "purpose": "HTTP server entry",
      "reason": null,
      "hash": "sha256:...",
      "lastReadAt": "2026-06-27T00:00:00.000Z",
      "lastRefreshAt": "2026-06-27T00:00:00.000Z"
    },
    "src/routes/user.ts": {
      "kind": "runtime",
      "status": "grouped",
      "summaryRef": ".apeiron/memory/modules/http-routing.md#routes",
      "purpose": "User route handlers",
      "reason": null,
      "hash": "sha256:...",
      "lastReadAt": "2026-06-27T00:00:00.000Z",
      "lastRefreshAt": null
    },
    "src/experimental.ts": {
      "kind": "runtime",
      "status": "unread",
      "summaryRef": null,
      "purpose": "Runtime file discovered outside the scoped warmup",
      "reason": "outside-scoped-warmup",
      "hash": "sha256:...",
      "lastReadAt": null,
      "lastRefreshAt": null
    },
    "logs/dev.log": {
      "kind": "log",
      "status": "ignored",
      "summaryRef": null,
      "purpose": "Runtime log",
      "reason": "日志文件，不属于项目源码",
      "hash": "sha256:...",
      "lastReadAt": null,
      "lastRefreshAt": null
    }
  }
}
```

`summaryRef` 可以指向独立文件文档，也可以指向多文件总结中的一个 heading。只要 refresh 能根据文件路径找到对应总结即可。

常见 `reason`：

```text
outside-scoped-warmup  用户选择了局部 warmup，文件不在本次深读范围内
read-deferred          文件已发现，但本轮没有必要读取
new-file-detected      coverage scan 发现 inventory 中不存在的新文件
deleted-file-detected  inventory 中存在但当前文件树中不存在
content-changed        文件 hash 变化，总结可能过期
blocked                读取、解析或总结时被错误阻塞
```

明显没有长期维护价值的文件，例如日志、构建产物、缓存、第三方依赖，应在 `inventory.json` 或 `.apeiron/ignore.md` 中标记原因。

### modules/*.md

用途：模块级说明书。

每个模块文档应描述：

- 模块职责；
- 入口文件；
- 主要 runtime 文件；
- 相关测试；
- 对外接口或命令；
- 与其他模块的依赖关系；
- 维护注意事项。

### files/**/*.md

用途：文件级说明书。

不是每个文件都需要详细文件文档。v0 要求：

- `runtime` 文件应尽量有对应的详细文件文档；
- `test` 文件可以在相关 runtime 文件或 module 文档中引用；
- `config` 文件只在影响运行、构建、测试或发布时写详细文档；
- `generated`、`log`、`vendor` 默认不写详细文档，只在 inventory 或 ignore 中说明。
- 如果多个文件共享一个总结，所有相关文件都必须在 `inventory.json` 中指向同一个 `summaryRef`。

文件文档应描述：

- 对应源码路径；
- 文件职责；
- 关键导出、类、函数或命令；
- 重要调用关系；
- 相关测试；
- 修改该文件时应注意的约定或风险。

### CONVENTIONS.md

用途：项目规则和编码约定。

示例：

- 命名模式；
- 分层边界；
- 新文件应该放在哪里；
- API 和数据模型约定；
- 应避免的命令或行为。

### TESTING.md

用途：验证地图。

应包含：

- 常用测试命令；
- lint/typecheck 命令；
- 测试目录结构；
- 已知的源码文件和测试文件关系；
- 如果发现，记录较慢或不安全的测试。

### MEMORY.md

用途：持久的项目维护笔记。

`MEMORY.md` 只允许记录长期维护事实。它不是任务流水账，也不是 session 总结。

应包含：

- 架构决策；
- 任务过程中发现的坑；
- 值得记住的失败方案；
- 令人意外但有意为之的行为；
- 对未来工作有价值、并且会影响后续维护判断的任务总结。

不应包含：

- 临时调试过程；
- 单次任务的普通执行记录；
- 一次性命令输出；
- 对未来没有维护价值的实现细节；
- 没有被代码、测试或明确用户决策支撑的猜测。

这是项目记忆，不是用户画像记忆。

## 5. Workspace 与覆盖扫描

Apeiron 在 VS Code 中运行时，工作区根目录应与当前 VS Code workspace 保持一致。

启动时，VS Code 插件应从当前 workspace root 查找：

```text
<workspace>/.apeiron/
<workspace>/.apeiron/memory/inventory.json
```

如果 `.apeiron/` 不存在，说明当前仓库尚未初始化，应提示或自动进入 `warmup`。

`inventory.json` 是项目覆盖状态的基准索引。Apeiron 应以当前 workspace 文件列表为准，对比 `inventory.json`，生成 coverage status。

启动扫描流程：

```text
1. 获取 VS Code 当前 workspace root。
2. 查找 .apeiron/。
3. 查找 .apeiron/memory/inventory.json。
4. 扫描当前 workspace 文件列表。
5. 应用 .apeiron/ignore.md。
6. 对比 inventory.json。
7. 对当前文件树中没有 inventory 条目的文件生成候选变更。
8. 检查每个 documented / grouped 文件是否有 summaryRef。
9. 检查 summaryRef 指向的文档是否存在。
10. 根据 hash 或其他指纹检查 stale 文件。
11. 生成 coverage status。
```

coverage status：

```text
ready
  inventory 基本可用，没有未知新增文件、损坏引用或必须立刻处理的 stale 文件。
  如果用户选择了 scoped warmup，ready 可以包含 unread 文件。

needs-warmup
  .apeiron 或 inventory 缺失，或项目从未建立过基本地图。

needs-refresh
  inventory 基本可用，但发现少量新增、删除、修改或 stale 文件。

blocked
  inventory 无法解析，summaryRef 指向不存在，或忽略规则损坏。
```

触发规则：

- `.apeiron/` 不存在：进入 `needs-warmup`；
- `inventory.json` 不存在：进入 `needs-warmup`；
- 项目没有 PROJECT / MODULES 等基础记忆：进入 `needs-warmup`；
- 少量文件新增、删除或缺少 summaryRef：进入 `needs-refresh`；
- 文件内容变化但对应总结可能过期：进入 `needs-refresh`；
- inventory 或 ignore 文件格式无法解析：进入 `blocked`。

`unread` 与新增文件的区别：

```text
inventory 中已有 status=unread
  表示系统知道这个文件存在，只是因为 scoped warmup、延迟读取或用户选择而尚未语义读取。

当前文件树中存在，但 inventory 中没有条目
  表示 coverage scan 发现了外部进程或后续任务新增的文件，应进入 needs-refresh。

inventory 中存在，但当前文件树中不存在
  表示文件被删除或移动，应进入 needs-refresh。

inventory 中 hash 与当前文件 hash 不一致
  表示文件内容变化，应标记 stale 或进入 needs-refresh。
```

Warmup 和 refresh 的区别：

```text
warmup = 建立或扩大项目地图
- full warmup 用于第一次初始化或用户明确要求全仓库覆盖；
- scoped warmup 用于特定任务、模块或路径集合；
- opportunistic warmup 用于 work 过程中顺手补齐已经读过的 unread 文件；
- 目标是让已覆盖文件有准确 status 和 summaryRef；
- 目标是建立 PROJECT / MODULES / inventory.json / files / modules 等记忆。

refresh = 增量同步
- 用于 inventory 基本可用时；
- 输入是新增、删除、修改或 stale 文件；
- 目标是更新对应 summaryRef 指向的总结文档；
- 目标是同步 inventory、模块文档和全局记忆。
```

### Memory maintenance agent

Warmup 和 refresh 都应被实现为 `memory maintenance agent run`，而不是系统驱动的逐文件总结批处理。

不期望的实现形态：

```text
系统枚举一批文件
系统为每个文件启动一次 LLM 调用
LLM 只负责生成该文件的简单摘要
系统把摘要机械写回 inventory 和 summaryRef
```

这种形态容易让代码里堆积大量路径分类、状态兼容和 if-else 分支，也会让项目记忆停留在孤立文件摘要，缺少模块关系、约定变化和维护判断。

期望的实现形态：

```text
系统给出目标、当前状态、完成条件和可用工具
agent 自己查看 coverage / inventory / diff / 文件树
agent 自己决定下一步要读什么、搜什么、检查哪些 summary
agent 根据读到的真实代码更新 memory 和 inventory
agent 反复检查剩余缺口
直到完成条件满足，或明确 blocked 并说明原因
```

这里的关键边界是：系统不做流程控制。

系统不应把 warmup 或 refresh 拆成固定步骤后要求 agent 按顺序执行，也不应替 agent 决定“下一步必须读哪个文件”“哪个模块必须更新”“这几个文件应该归成一组”。这些判断属于 memory maintenance agent。

系统只负责四件事：

```text
state      提供当前 repo / memory / coverage / diff / turn 的真实状态
tools      提供可审计、受边界约束的读取、搜索、写 memory 和更新 inventory 工具
contract   告诉 agent 本次 run 的目标、不变量和完成条件
audit      在 agent 尝试 finish 时检查不变量是否满足，不满足则拒绝 finish 并返回缺口
```

因此，Apeiron core 的复杂度应主要出现在工具边界、状态采集、target 归属和 finish audit 中，而不是出现在系统编排的业务流程中。

Apeiron core 应提供稳定工具和硬边界：

- `get_coverage_status()`
- `list_files(pattern?)`
- `read_file(path)`
- `search_text(query, scope?)`
- `get_git_status()`
- `get_git_diff(path?)`
- `find_summary_for_file(path)`
- `read_memory_file(path)`
- `write_memory_file(path, content)`
- `update_inventory_entry(path, patch)`
- `mark_file_ignored(path, reason)`
- `finish(result)`

LLM agent 负责维护判断：

- 哪些文件需要深读；
- 哪些文件可以 grouped，而不是每个文件单独写 summary；
- 哪些 unread 文件可以保持 unread；
- 哪些 memory 文档需要更新；
- 是否需要补读相关测试、配置或调用方；
- 当前是否满足 full / scoped warmup 或 refresh 完成条件；
- 如果不能完成，哪些文件或文档 blocked，原因是什么。

系统负责验证不变量：

- 不允许写出没有 reason 的 ignore 规则；
- `MEMORY.md` 只允许长期维护事实；
- `documented` / `grouped` 必须有 summaryRef；
- full warmup 不能在仍有未覆盖文件时标记完成；
- refresh 的 must-refresh target 必须被检查或显式 blocked；
- agent 不能把临时任务日志写进长期记忆。

这些验证只决定是否允许 finish，不决定 agent 在 run 中的探索顺序。

## 6. Warmup 流程

Warmup 是一个由 LLM 主导的 agentic 探索过程。

第一版假设 LLM 有足够强的项目理解能力，因此不设置最大读取文件数或最大读取 token。Apeiron 只设置一个较大的最大调用轮数，作为防止无限循环的兜底。

Warmup 支持三种模式：

```text
full
  用户要求全仓库建档。
  完成条件要求所有未忽略文件都进入 documented / grouped / ignored。

scoped
  用户指定任务、模块或路径提示；agent 根据目标和代码证据解释本轮实际探索边界。
  完成条件要求 scope 内关键文件进入 documented / grouped / ignored。
  scope 外文件必须进入 inventory，但可以是 unread。

opportunistic
  work 中已经读取到某些 unread 文件。
  refresh 阶段可以为这些已读文件补充 summaryRef、模块文档或文件文档。
```

Scoped warmup 不是“只看几个文件”。即使用户选择局部 warmup，Apeiron 也应建立项目级粗略描述：

- 扫描完整文件树；
- 读取顶层 README、docs 候选、manifest 和关键配置；
- 识别主要源码根目录、测试根目录和包结构；
- 起草或更新 `PROJECT.md`；
- 起草或更新粗粒度 `MODULES.md`；
- 将未进入本次 scope 的文件写入 `inventory.json`，状态为 `unread`，reason 为 `outside-scoped-warmup` 或 `read-deferred`。

Warmup 阶段的边界：

```text
LLM 决定：
- 哪些文件值得读；
- 哪些目录可以忽略；
- 何时从探索切换到批量写文档；
- 记忆内容应如何组织。

Apeiron 控制：
- 可用工具；
- 最大 agent loop 调用轮数；
- 忽略规则的存储格式；
- 只能写入 .apeiron/memory；
- 最终 memory 文件格式；
- warmup 完成条件；
- 每个文件的读取和总结覆盖状态。
- full / scoped / opportunistic 的完成条件。
```

Apeiron 不控制 warmup 的探索顺序。它可以在 prompt 中说明常见策略，但不应在系统代码里把 warmup 实现成固定阶段流水线。agent 可以根据实际仓库形态决定先读 README、入口、测试、配置、调用方还是已有 memory。

输入：

- 仓库根目录；
- 文件列表；
- README 和明显的文档；
- package manifest 和配置文件；
- 测试目录列表；
- `.apeiron/ignore.md`；
- 可选的已有 `.apeiron/memory`。
- warmup mode；
- scoped warmup 的 scope 描述。

输出：

- `.apeiron/memory/*.md`；
- `.apeiron/memory/modules/*.md`；
- `.apeiron/memory/files/**/*.md`；
- `.apeiron/memory/inventory.json`；
- warmup 总结；
- 可选的未探索区域列表。

agent 可采用的 warmup 探索策略：

```text
1. 列出文件。
2. 读取 .apeiron/ignore.md。
3. 读取顶层文档和 manifest。
4. 识别可能的入口、源码根目录和测试根目录。
5. 对文件和目录做初步分类，形成 inventory draft。
6. 由 LLM 自主选择下一批要读或搜索的文件。
7. 优先读取入口、runtime 文件、模块边界文件、测试和配置。
8. 收集足够多的文件关系后，再批量写项目记忆。
9. 为 runtime 文件生成或更新对应的 files/**/*.md。
10. 为主要模块生成或更新 modules/*.md。
11. 如果发现应长期忽略的路径，更新 ignore 规则并写明原因。
12. 起草 PROJECT/MODULES/CONVENTIONS/TESTING/MEMORY。
13. 写入或更新 inventory.json。
14. 检查 inventory 覆盖状态。
15. 如果 full warmup 仍有未读取、未忽略或缺少 summaryRef 的文件，继续探索或补文档。
16. 如果 scoped warmup 的 scope 外文件仍是 unread，确认它们有明确 reason。
17. 保存记忆文件。
```

以上是给 agent 的策略提示，不是系统流程控制。系统不应因为 agent 没按这个顺序行动就拒绝结果；系统只根据完成条件和不变量做验收。

Warmup 不要求 agent 每读一个文件就立刻写入文档。它可以先收集多个文件之间的关系，再统一写入项目记忆。这样能避免文件说明只停留在孤立、浅层的摘要。

Full warmup 的完成条件：

```text
对 repo snapshot 中的每个文件：
- 要么文件已被读取，并且在 inventory.json 中有 status=documented 或 status=grouped；
- 要么文件被忽略，并且在 inventory.json 或 .apeiron/ignore.md 中有明确 reason。

对每个未忽略文件：
- 必须至少读取过一次；
- 必须有 summaryRef；
- summaryRef 指向的文档必须存在；
- summaryRef 指向的文档必须能说明该文件的作用，或说明该文件属于哪个多文件总结。
```

如果达到最大调用轮数但仍未满足完成条件，warmup 不能标记为完成。它应进入 `blocked` 状态，并列出仍未覆盖的文件。

Scoped warmup 的完成条件：

```text
对 repo snapshot 中的每个文件：
- 必须在 inventory.json 中有条目；
- scope 内文件应进入 documented / grouped / ignored；
- scope 外文件可以是 unread，但必须有 reason；
- 项目必须有可用的 PROJECT.md 和粗粒度 MODULES.md。

对 scope 内 documented / grouped 文件：
- 必须至少读取过一次；
- 必须有 summaryRef；
- summaryRef 指向的文档必须存在。
```

Scoped warmup 完成后，coverage status 可以是 `ready`，同时 inventory 中仍存在 `unread` 文件。这里的 `ready` 表示“项目地图足以开始当前工作”，不是“仓库已完整语义覆盖”。

Warmup 应给每个文件和目录一个 inventory 条目，但不需要给每个文件都写独立详细说明。详细文件文档优先覆盖 `runtime` 文件；其他文件可以指向模块总结或多文件总结。

### Warmup 工具与上下文

Apeiron 在 warmup 开始前提供一份 repo snapshot：

```text
- workspace root
- git branch / git status
- 文件树摘要
- README / docs 候选文件
- manifest / config 候选文件
- 源码目录候选
- 测试目录候选
- 已有 .apeiron/memory
- 已有 .apeiron/ignore.md
```

Warmup 可用工具：

```text
list_files(pattern?)
read_file(path)
search_text(query, glob?)
get_git_status()
find_summary_for_file(path)
update_inventory_entry(path, status, summaryRef?, reason?)
mark_file_ignored(path, reason)
write_memory_file(path, content)
write_ignore_file(content)
```

`find_summary_for_file(path)` 用于从 `inventory.json` 查询某个文件对应的总结。

返回示例：

```text
{
  path: "src/routes/user.ts",
  status: "grouped",
  kind: "runtime",
  summaryRef: ".apeiron/memory/modules/http-routing.md#routes",
  ignoredReason: null
}
```

`mark_file_ignored(path, reason)` 必须写入原因。没有原因的忽略请求应被拒绝。

v0 的 warmup 默认不提供会执行项目代码的工具。它可以读取配置、脚本和测试文件，但不主动运行构建、测试或任意 shell 命令。

### 忽略规则

Apeiron 应提供一个类似 `.gitignore` 的忽略配置，但每条规则必须带原因。

建议文件：

```text
.apeiron/ignore.md
```

建议格式：

```markdown
# Apeiron Ignore

## Rules

- pattern: node_modules/**
  reason: 第三方依赖目录，不属于当前项目源码。

- pattern: dist/**
  reason: 构建产物，可由源码重新生成。

- pattern: **/*.lock
  reason: 依赖锁定文件通常只在依赖问题或构建问题中需要检查。
```

忽略规则的用途：

- warmup 时帮助 LLM 判断哪些路径不值得优先阅读；
- work 初始 context pack 和工具列表展示时降低噪音；
- refresh 时避免把构建产物、依赖目录或临时文件写入项目记忆。

忽略规则不是强制安全边界。LLM 可以在有明确理由时读取被忽略路径，但应说明为什么这次需要越过忽略规则。

Apeiron 应允许 LLM 在 warmup 中修改 `.apeiron/ignore.md`，但每条新增或修改的规则都必须包含原因。没有原因的忽略规则不应写入。

## 7. Work 流程

Work 流程从上下文托盘开始。

输入：

- 用户任务；
- 当前 `.apeiron/memory`；
- 当前 git status 和 diff；
- 文件列表；
- 可选的历史 session checkpoint。

编码前输出：

- 当前任务的 context pack。

context pack 是 agent 的工作托盘，不是系统替 agent 做的上下文检索计划。

它的职责是：

```text
- 携带项目记忆摘要，让 agent 从项目地图开始；
- 携带仓库状态和用户显式 pin 的材料；
- 记录本轮 agent 主动读取的源码、搜索结果、命令结果和 diff；
- 让用户能审查和临时排除接下来会进入模型上下文的条目。
```

它不负责：

```text
- 根据任务自动猜测所有相关源码；
- 替 agent 决定应该阅读哪些实现文件；
- 用规则系统在 agent 前面做 retrieval planning；
- 把未读取的源码伪装成已理解的上下文。
```

初始 context pack 应尽量薄，通常包含：

```text
任务：
- 用户请求

仓库状态：
- branch
- dirty files
- recent diff summary

基础项目记忆：
- PROJECT.md
- MODULES.md
- CONVENTIONS.md
- TESTING.md
- MEMORY.md

用户显式加入的材料：
- priority paths
- attachments
- checkpoint/session 中用户选择保留的上下文

本轮工作托盘：
- agent 已读取的文件
- agent 已执行的搜索结果
- agent 已运行的命令结果
- agent 产生的 diff 或工具事件摘要
```

agent 应从基础记忆和任务开始，自主调用 read/search/bash 等工具阅读真实代码。工具结果可以被追加为新的 context item，并在后续模型调用中继续携带。

context pack 中的每个条目都应保留来源信息，方便用户和系统追踪内容从哪里来。

建议结构：

```text
ContextItem
  id
  type: memory | file | diff | attachment | session | tool-result
  title
  summary
  source
  included
  excludedReason?
```

`source` 示例：

- `.apeiron/memory/MODULES.md`;
- `src/server.ts`;
- `git diff`;
- `用户上传的日志文件`;
- `上一轮 session 总结`。

用户可以在 GUI 中临时排除某些 context item。被排除的条目不应进入接下来的模型上下文，但不会删除原始记忆、文件或工具记录。

这种排除是 session 级别的临时选择。它不同于 `.apeiron/ignore.md`：

- `.apeiron/ignore.md` 用于长期降低项目噪音；
- context item 排除用于当前或接下来几轮对话的临时上下文裁剪。

生成初始 context pack 后，agent 进入正常编码模式：

1. 自主检查需要的文件；
2. 编辑文件；
3. 运行检查；
4. 迭代直到任务完成或阻塞；
5. 总结变更；
6. 自动运行 refresh。

### Work 中的 opportunistic warmup

Work 过程中，agent 可能因为任务需要读取到 inventory 中仍为 `unread` 的文件。这些文件已经被真实读取过，不应等到下一次 full warmup 才进入项目记忆。

Apeiron 应在每次 agent run 中记录：

```text
readFilesThisRun
modifiedFilesThisRun
searchedPathsThisRun
executedChecksThisRun
```

refresh 阶段应检查 `readFilesThisRun`：

```text
如果某个文件在 inventory 中 status=unread：
  如果本轮读取和相关上下文足以说明它的职责：
    为它补充 summaryRef
    将状态改为 documented 或 grouped
    必要时更新 module 文档
  如果本轮只是浅层读取，不足以可靠总结：
    保持 unread
    将 reason 改为 read-but-not-enough-context
```

这类补档称为 opportunistic warmup。它只能基于本轮已经读取过的真实文件，不应猜测未读取文件的职责。

如果 agent 认为为了完成当前任务，应额外读取一批 `unread` 文件来补全同一模块、直接依赖、相关测试或关键配置，这属于 warmup expansion，而不是普通 refresh。Warmup expansion 需要用户允许或配置允许。

建议设置：

```text
autoDocumentReadFiles = true
autoExpandWarmup = ask | never | always
maxWarmupExpansionFilesPerRun = 20
```

默认建议：

```text
autoDocumentReadFiles = true
autoExpandWarmup = ask
```

允许自动扩大 warmup 的典型理由：

- 同模块内的直接依赖；
- 被修改文件对应的测试；
- 影响构建、运行或代码生成的配置；
- 当前 summaryRef 缺失，必须读取邻近文件才能建立可靠总结。

当 `autoExpandWarmup=ask` 时，GUI 应清楚展示本次想额外读取哪些文件和原因。例如：

```text
当前任务需要理解 packages/foo 的 12 个未读文件。
原因：它们是被修改文件的直接依赖和相关测试。
是否允许本轮顺手完成这个模块的 warmup？
```

## 8. Agent Loop 与运行中输入

Apeiron v0 基本复现 Pi 的 agent loop。

核心循环：

```text
用户任务或队列消息
  -> 调用模型生成 assistant message
  -> 如果 assistant message 包含 tool call
      -> 执行 tool call
      -> 将 tool result 写回上下文
      -> 继续下一轮模型调用
  -> 如果 assistant message 不包含 tool call
      -> 检查 follow-up 队列
      -> 如果没有 follow-up，结束本次 agent run
```

也就是说，agent 的连续行动不是模型一次性完成的，而是宿主程序持续执行：

```text
model -> tools -> model -> tools -> model -> final answer
```

默认停止条件：

- 当前 assistant message 没有 tool call；
- 当前没有待注入的 steering message；
- 当前没有待执行的 follow-up message；
- 没有触发 abort、error 或外部 stop policy。

### 运行中的用户输入

当 agent 正处于工作状态时，用户的新输入必须显式选择一种模式：

- `steering`：修正当前任务方向；
- `follow-up`：等当前任务结束后继续执行。

`steering` 的语义：

```text
当前 assistant turn 和当前批次 tool call 执行完
  -> 注入 steering message
  -> 继续下一轮模型调用
```

它适合表达：

- “等等，不要改这个模块”；
- “刚才的方向不对，优先检查另一个文件”；
- “保留现有 API，不要改调用方”。

`follow-up` 的语义：

```text
agent 本来准备结束
  -> 检查 follow-up 队列
  -> 注入 follow-up message
  -> 继续下一轮模型调用
```

它适合表达：

- “做完后顺便更新 README”；
- “完成后再跑一次完整测试”；
- “这个任务结束后再解释一下改动”。

`steering` 不是立即中断。它不会取消当前已经开始执行的工具调用。如果用户需要立刻停止，应使用单独的 stop/abort 控制。

队列策略第一版保持简单：

- `steering` 和 `follow-up` 各自维护独立队列；
- 默认按输入顺序一条一条交付；
- UI 应展示两个队列中的待处理消息；
- 用户可以在消息被交付前取消或取回编辑。

## 9. Refresh 流程

Refresh 在任务后同步项目记忆。它不是简单追加任务总结，而是把本回合修改后的真实代码状态重新写回相关文档。

输入：

- 用户任务；
- 最终 assistant 总结；
- git diff；
- 修改过的文件；
- 本轮读取过的文件；
- 运行过的测试/检查及结果；
- 当前记忆文件。

输出：

- 对 `.apeiron/memory/*.md` 的 patch；
- 对 `.apeiron/memory/modules/*.md` 的 patch；
- 对 `.apeiron/memory/files/**/*.md` 的 patch；
- 可选的 session 总结；
- 可选的上下文包归档。

Refresh 本身也是一个 agentic memory maintenance run。系统只负责收集入口 target、提供当前状态、提供工具、限制写入边界和检查完成条件；不应由系统把 target 逐个拆开后为每个文件机械调用一次 LLM 总结。

Refresh agent 可采用的检查策略：

```text
1. 读取本回合 refresh targets、coverage status、git diff 和 inventory。
2. 检查每个 must-refresh target 是否有 inventory entry 和 summaryRef；缺失时决定创建、补齐或 blocked。
3. 主动读取 modified / created / deleted 文件的当前源码、相关 diff、现有 summaryRef 文档。
4. 根据需要搜索调用方、测试、配置、模块入口或相邻文件，而不是只看被修改文件本身。
5. 检查本轮 readFiles 中仍为 unread 的文件，决定是否执行 opportunistic warmup。
6. 判断哪些记忆文档实际受影响：files、modules、PROJECT、MODULES、CONVENTIONS、TESTING、MEMORY、ignore。
7. 写入必要的 memory / inventory 更新。
8. 重新检查 refresh targets 和 coverage status。
9. 如果仍有 must-refresh target 未检查或缺少 summaryRef，继续循环或标记 blocked。
10. finish 时报告 checked / updated / skipped / blocked，以及每个 target 对应检查过的文档。
```

以上是给 agent 的策略提示，不是系统流程控制。agent 可以按模块、按 diff、按 summaryRef、按测试影响或按自己认为最清楚的顺序处理。系统只在 finish 时检查 must-refresh target 是否被检查或 blocked，以及 memory / inventory 不变量是否成立。

“重申”指的是让文档描述修改后的当前状态，而不是只追加“本次做了什么”。例如：

- runtime 文件职责变化，应更新对应 `files/**/*.md`；
- 文件新增、删除或分类变化，应更新 `inventory.json`；
- 模块边界或调用关系变化，应更新 `MODULES.md` 和对应 `modules/*.md`；
- 测试入口或命令变化，应更新 `TESTING.md`；
- 新增维护约定，应更新 `CONVENTIONS.md`；
- 本次任务发现长期坑点，应更新 `MEMORY.md`。

### Refresh target 跟踪

Work 阶段应显式记录本轮文件触达情况，作为 refresh 的入口，而不是完全依赖 LLM 事后猜测哪些文档相关。

建议记录：

```text
readFilesThisRun
modifiedFilesThisRun
createdFilesThisRun
deletedFilesThisRun
searchedPathsThisRun
executedChecksThisRun
```

系统还应建立 turn change boundary，用来区分“本轮 work 引入的变化”和“工作区开工前已经存在的脏改”。

本轮 refresh targets 来自：

```text
agent 显式触碰的文件
  read_file / write_file / delete_file 等工具记录。

本轮新增或状态变化的 git dirty 文件
  例如 formatter、codegen、snapshot、lockfile 等由命令间接造成的变化。

开工前已经 dirty 且本轮 agent 显式触碰过的文件
  这类文件进入本轮 target，但 read-only 触碰不应被系统强行升级为 modified。
```

默认不进入本轮 refresh：

```text
开工前已经 dirty 且本轮 agent 没有触碰过的文件。
```

这类文件可以在 UI 或 session 事件中展示为 preexisting dirty / ignored by turn boundary，但不应强迫本轮 refresh agent 处理。否则 Apeiron 会把用户手动半成品、上一轮残留或无关实验误写入当前任务记忆。

turn change boundary 只判断 target 是否属于本轮；不判断这个 target 应如何更新记忆。具体是否更新 summaryRef、模块文档、PROJECT、TESTING 或 MEMORY，仍由 refresh agent 根据代码和验收标准自主决定。

Refresh target 分级：

```text
modifiedFilesThisRun
  必须 refresh。需要读取当前源码、git diff、inventory entry 和 summaryRef 文档，重新确认总结是否仍描述当前事实。

createdFilesThisRun
  必须 refresh。需要创建 inventory entry，并决定 documented / grouped / ignored。

deletedFilesThisRun
  必须 refresh。需要更新 inventory、模块文档和可能引用该文件的 summaryRef。

readFilesThisRun 且 inventory status=unread
  执行 opportunistic warmup。若本轮读取足以可靠说明职责，应补 summaryRef 并改为 documented 或 grouped。

readFilesThisRun 且 inventory status=documented/grouped 且源码 hash 未变化
  默认不更新 memory。只有当 agent 明确发现旧记忆错误、过期或缺少关键维护事实时，才加入 refresh target。
```

每个 modified / created / deleted 文件都必须被 agent 在 refresh 阶段手动重审一遍。这里的“手动重审”指 agent 必须读取该文件当前状态、相关 diff、inventory entry 和 summaryRef 文档，再决定如何更新记忆；不能只根据 work 阶段的最终总结批量追加文字。

Refresh 应遍历本回合所有必须处理的 target，并把它们对应到所有相关文档。即使某个文档最后无需修改，也应在 refresh 结果摘要中说明它被检查过。

Refresh agent 可以选择先处理一个模块或一组相关文件，再统一更新模块文档和 inventory；不要求每读一个文件就立刻写一个单文件 summary。对于高度相关的小文件，agent 可以创建 grouped summary，并让多个 inventory entry 指向同一个 `summaryRef`。

如果修改文件在 `inventory.json` 中没有记录，refresh 必须先为它创建 inventory 条目，再决定它应是 `documented`、`grouped`、`unread` 还是 `ignored`。

如果修改文件没有 `summaryRef`，refresh 必须补齐 summaryRef，或在 refresh 摘要中把该文件标记为 blocked。

如果本轮读取过的文件在 `inventory.json` 中是 `unread`，refresh 应尽量为它补齐 summaryRef。只有当本轮读取不足以形成可靠总结时，才保持 `unread`。

如果当前文件树中出现 `inventory.json` 没有记录的文件，refresh 应将它视为外部变更或后续任务新增文件，创建 inventory 条目并标记 reason 为 `new-file-detected`，再根据实际读取情况决定最终状态。

Refresh 只应在变化对未来维护有价值时写入记忆。

以下情况应更新记忆：

- 模块职责变化；
- 新增模块或入口；
- 发现或改变了约定；
- 发现测试命令或源码-测试文件关系；
- 发现持久的坑；
- 旧笔记已经错误；
- 做出了未来任务应遵守的决策。

以下情况不应更新记忆：

- 临时调试细节；
- 对未来没有价值的实现琐事；
- 一次性命令输出；
- 没有被变更文件支撑的猜测；
- 任务闲聊。

允许自动模式。任务完成后，agent 应直接写入记忆 patch。

`.apeiron/memory` 和 `.apeiron/ignore.md` 默认进入 git。Refresh 产生的记忆更新应和代码变更出现在同一个工作区 diff 中。这样当用户回退代码时，项目记忆也会随代码版本一起回退。

GUI 应把 memory change 和 code change 区分展示，但不应默认把 memory change 放到 git 外部或隐藏起来。是否提交这部分 diff 由用户决定。

## 10. Session 模型

Apeiron v0 不需要完整树状对话。

期望行为更简单：

- 保存线性 session；
- 允许用户选择一个历史 checkpoint；
- 从这个 checkpoint 创建新 session；
- 允许用户在继续前编辑或替换 checkpoint prompt。

旧 session 不需要变成永久分支树。

建议模型：

```text
Session
  id
  parentSessionId?
  forkedFromCheckpointId?
  createdAt
  cwd
  messages[]
  contextPackPath?
  memoryRevisionBefore?
  memoryRevisionAfter?

Checkpoint
  id
  sessionId
  messageIndex
  label?
  summary?
  createdAt
```

这样能给用户保留分支最有用的部分，同时不继承完整树导航的复杂度。

## 11. 与 Pi 的关系

项目可以复用 Pi 的部分组件，但 Apeiron 的产品核心是项目记忆、上下文准备、warmup/work/refresh flow 和 VS Code 体验。

复用原则：

```text
能节省底层工程量、且不改变 Apeiron 产品模型的部分，优先复用或薄封装 Pi。
会决定 Apeiron 记忆模型、刷新语义、context pack 生命周期和用户体验的部分，由 Apeiron 自己维护。
```

v0 采用的复用边界：

- 使用 `@earendil-works/pi-ai` 做 provider 支持；
- 优先复用或薄封装 Pi 的 auth/model registry；
- 优先复用或薄封装 Pi 的 read/bash/edit/write/grep/find/ls 工具定义和工具工厂；
- agent loop 采用 Pi 的事件驱动 loop 语义，可以直接复用 `pi-agent-core`，也可以在 Apeiron 内轻量 fork 后维护；
- steering/follow-up 队列语义与 Pi 保持一致；
- session 存储可以借鉴 Pi 的 JSONL 设计。

Apeiron 自己维护：

- memory model；
- inventory 和 coverage scan；
- warmup / work / refresh flow；
- context pack 生命周期和工作托盘记录；
- refresh target tracking；
- VS Code 命令和 GUI；
- 与 `.apeiron/` 目录相关的文件格式和生命周期。

v0 不需要：

- Pi TUI；
- Pi interactive mode；
- Pi theme system；
- Pi 完整 session tree UI；
- OpenClaw 风格 gateway。

建议起点：

```text
provider/auth/model registry 直接复用或薄封装 Pi。
tools 直接复用或薄封装 Pi，并在 Apeiron 外层增加 refresh tracking wrapper。
agent loop 先复用 Pi 的事件语义，避免从零处理 streaming、tool call、abort、steering 和 follow-up。
Apeiron 自己拥有 memory model、warmup/work/refresh flow、context pack 工作托盘和用户命令。
```

如果后续发现 Pi 的 agent loop 与 Apeiron 的 memory/context 生命周期冲突，可以再 fork 或替换 loop。v0 不应为了“从零实现 loop”牺牲 warmup/refresh 这条主线的落地速度。

## 12. VS Code GUI

第一版 GUI 以 VS Code 插件形式实现。界面不追求完整 IDE，也不做复杂控制台，核心就是一个聊天页面。

### 聊天页面

聊天页面应支持：

- 展示用户消息、assistant 消息、工具执行摘要和错误信息；
- 展示 agent 执行过程中的命令、工具结果和文件修改摘要；
- 用户输入新消息；
- 当 agent 正在工作时，让用户选择本次输入是 `steering` 还是 `follow-up`；
- 编辑历史用户消息；
- 从被编辑的消息重新发送，并从该消息创建新的线性 session；
- 上传附件；
- 展示当前任务的上下文包入口；
- 打开当前上下文检查器；
- 打开项目覆盖视图；
- 在任务完成后展示 refresh 结果摘要。

消息编辑与重发送的语义：

```text
用户选择一条历史用户消息
  -> 编辑消息内容
  -> 重新发送
  -> 基于该消息之前的上下文创建新 session
  -> 原 session 保留为历史记录，但不维护完整分支树
```

运行中输入的交互语义：

```text
agent idle
  -> 普通发送，开始一个新任务或继续当前 session

agent working
  -> 用户输入消息
  -> UI 要求选择 steering 或 follow-up
  -> 消息进入对应队列
  -> 顶部状态栏和消息区展示待处理队列
```

为了避免误解，UI 不应把 `steering` 表现成“立即打断”。真正的中断应由独立的 stop/abort 按钮承担。

### 执行事件流

Apeiron 的聊天页面应参考 Codex 的交互方式：agent 的行动过程在对话流中可审计，但默认保持折叠，避免把聊天页面变成日志墙。

Codex 的相关表现可以抽象为：

- 命令执行、工具调用和文件修改是独立的过程事件；
- 用户能查看命令、输出、diff 和最终修改文件；
- 详细终端输出和 diff 不应默认全部展开；
- 用户需要时可以打开 diff panel、terminal 或展开某个事件。

Apeiron v0 的执行事件类型：

```text
command        执行 shell 命令
tool-call      调用 read/search/edit/write 等工具
tool-result    工具调用结果
file-change    文件创建、修改、删除
diff-summary   本轮 diff 摘要
test-result    测试、lint、typecheck 结果
memory-change  refresh 修改了哪些记忆文档
error          错误或阻塞原因
```

每个执行事件在消息流中默认折叠，只展示一行摘要：

```text
运行命令：pnpm test  失败  12.4s
读取文件：src/server.ts
修改文件：src/server.ts  +18 -6
更新记忆：files/src/server.ts.md
```

展开后展示详情：

- 命令事件展示 command、cwd、exit code、duration、stdout/stderr 摘要和完整输出入口；
- 工具事件展示 tool name、参数摘要、结果摘要；
- 文件修改事件展示文件路径、变更类型、增删行数和 diff；
- 测试事件展示命令、状态、失败摘要和完整输出入口；
- 记忆变更事件展示被更新的 memory 文档和原因；
- 错误事件展示错误信息、发生阶段和可恢复建议。

默认折叠策略：

- 成功的命令、read/search 工具调用、普通文件修改默认折叠；
- 失败命令、错误、需要用户确认的操作默认展开；
- diff 默认显示摘要，用户点击后展开；
- 长输出默认截断，保留“查看完整输出”的入口；
- 当前正在运行的事件应显示 live 状态。

文件修改展示应同时支持两种入口：

- 消息流中的折叠事件，适合按时间线审计 agent 做了什么；
- 独立 diff 面板，适合集中审查本轮或当前工作区的所有修改。

diff 面板至少支持：

- 查看当前工作区所有变更；
- 查看 last turn changes；
- 按文件查看 diff；
- 从 diff 跳转到 VS Code 原文件；
- 区分代码文件变更和 `.apeiron/memory` 记忆变更。

### 上下文检查器

聊天页面应提供一个按钮，用于查看当前上下文的实际内容摘要和来源。

上下文检查器展示的是“接下来会进入模型上下文的内容”，而不是完整项目记忆。

每个上下文项应展示：

- 简短标题；
- 内容摘要；
- 来源；
- 类型：memory、file、diff、attachment、session、tool-result；
- 是否会被包含在接下来的对话中。

用户可以勾选或取消勾选上下文项：

- 选中：该项会进入接下来的模型上下文；
- 取消选中：该项在接下来的对话中被临时忽略；
- 被取消的项应保留在检查器中，方便用户重新启用。

上下文检查器不直接编辑 `.apeiron/memory`。它只影响用户看不见的上下文选择。

排除作用域：

```text
用户在上下文检查器中取消某项
  -> 不影响当前已经开始的对话或 agent run
  -> 从用户关闭上下文检查器后的下一次模型调用开始生效
  -> 之后每一次对话都默认排除该项
  -> 直到用户重新打开上下文检查器并启用它
```

因此，上下文检查器的主要用途不是实时修改当前已经发出去的一轮，而是让用户看清隐藏上下文，并控制后续对话默认携带哪些内容。

如果 agent 后续工具调用读取了新的文件或产生新的工具结果，Apeiron 应把它们作为新的 context item 加入检查器，并记录来源。

### 项目覆盖视图

项目覆盖视图用于让用户理解 agent 对仓库的整体理解覆盖情况。它展示的是项目级记忆覆盖，不是当前模型调用的上下文。

项目覆盖视图应展示文件树，并在每个文件旁边显示状态：

```text
documented   已读取，并有独立总结
grouped      已读取，归属于多文件总结
ignored      已忽略，并有原因
stale        总结可能落后于源码
unread       尚未读取
missing-ref  缺少 summaryRef
```

点击文件时应展示：

- 文件路径；
- kind；
- status；
- summaryRef；
- ignoredReason；
- 对应总结摘要；
- 是否正在被当前上下文加载；
- 最后读取时间；
- 最后 refresh 时间。

项目覆盖视图和上下文检查器的区别：

```text
项目覆盖视图：
- 关心整个仓库是否被读取、总结、忽略；
- 主要来自 inventory.json 和 summaryRef；
- 用于发现 warmup 覆盖缺口和 stale memory。

上下文检查器：
- 关心下一次模型调用实际携带哪些内容；
- 主要来自当前 context pack；
- 用于控制隐藏上下文是否进入后续对话。
```

### 附件上传

第一版只支持两类附件：

- 图片文件；
- 文本文件。

图片用于视觉理解或问题描述，例如截图、UI 错误、设计稿。

文本文件用于补充上下文，例如日志、配置片段、错误输出、临时说明。

附件处理原则：

- 附件属于某条用户消息；
- 附件应保存到 session 记录或 `.apeiron` 内的附件目录；
- 文本附件可以进入上下文包；
- 图片附件在调用支持视觉的模型时传给模型；
- 不支持任意二进制文件上传。

建议目录：

```text
.apeiron/
  attachments/
    <session-id>/
      <message-id>/
```

### 状态栏

聊天界面顶部预留状态栏，用于显示 agent 当前正在做什么。

状态栏应展示：

- 当前阶段：idle、warmup、context、work、refresh、blocked、done；
- 当前动作：例如“读取文件列表”、“生成上下文包”、“运行测试”、“更新记忆”；
- 当前正在运行的命令或工具；
- 当前模型；
- 当前 session 名称或 ID；
- 待处理的 steering/follow-up 消息数量；
- 当前上下文项数量，以及被用户排除的数量；
- 是否存在未提交的记忆更新；
- 如果任务阻塞，展示阻塞原因。

状态栏不是日志窗口。详细过程应进入消息流或 Output Channel。

### VS Code 插件边界

VS Code 插件负责：

- 提供聊天页面；
- 管理文件上传；
- 获取 workspace root；
- 打开和展示记忆文件；
- 展示 diff 或 refresh 结果；
- 调用 Apeiron core 执行 warmup/work/refresh。

Apeiron core 负责：

- agent loop；
- provider 调用；
- 工具执行；
- session 存储；
- 项目记忆；
- context pack；
- refresh。

这样后续如果要做独立 GUI，可以复用 core，而不是重写 agent 逻辑。

## 13. 初始架构

建议模块：

```text
packages/
  core/
    src/
      agent/
        loop.ts
        events.ts
        prompts.ts
        queues.ts

      memory/
        store.ts
        warmup.ts
        refresh.ts
        context-pack.ts
        ignore.ts
        inventory.ts
        docs-map.ts
        coverage.ts

      repo/
        file-list.ts
        git.ts
        read.ts
        search.ts

      tools/
        read.ts
        edit.ts
        bash.ts
        grep.ts

      llm/
        provider.ts
        model-registry.ts

      session/
        store.ts
        checkpoint.ts
        attachments.ts
        context-selection.ts
        execution-events.ts

  vscode-extension/
    src/
      extension.ts
      chat/
        chatPanel.ts
        webview.ts
        messages.ts
        attachments.ts
        status.ts
        contextInspector.ts
        coverageView.ts
        executionTimeline.ts
        diffPanel.ts
      commands/
        warmup.ts
        work.ts
        refresh.ts
        openMemory.ts
```

实现开始后可以继续调整。

## 14. MVP 范围

为了避免第一版同时承担 core、agent、memory 和完整 GUI 的复杂度，v0 分为两个落地阶段。

### Core MVP

Core MVP 的目标是先跑通 Apeiron 的核心闭环：

```text
coverage scan -> warmup -> context pack -> work -> refresh -> memory diff
```

Core MVP 应支持：

- 建立 `packages/core`；
- 初始化 `.apeiron/` 目录；
- 解析 `.apeiron/ignore.md`；
- 扫描文件树并生成文件 hash；
- 读写 `inventory.json`；
- 基于 `inventory.json` 生成 coverage status；
- 支持 full warmup 和 scoped warmup；
- warmup / refresh 必须以 agent loop 形式运行，由 agent 自主读取、搜索、检查状态并写入 memory，而不是系统逐文件批量调用 LLM 总结；
- scoped warmup 允许 scope 外文件为 `unread`；
- 生成 `PROJECT.md`、`MODULES.md`、`TESTING.md`、`CONVENTIONS.md`、`MEMORY.md`；
- 为 runtime 文件生成文件级文档，或归入模块级 summary；
- work 前生成初始 context pack 工作托盘；
- work 阶段通过工具 wrapper 记录 read / modified / created / deleted 文件；
- work 后在有 git diff 或 unread read files 时自动 refresh；
- refresh 按 refresh targets 重审源码、diff、inventory 和 summaryRef；
- refresh 更新 inventory hash、status、summaryRef 和相关 memory 文档；
- `MEMORY.md` 只记录长期维护事实；
- session 先采用基础线性 JSONL 或等价格式保存；
- provider/auth/model registry 优先复用或薄封装 Pi；
- tools 优先复用或薄封装 Pi，并增加 refresh tracking wrapper；
- agent loop 优先复用 Pi 的事件语义。

Core MVP 的 VS Code 部分只要求：

- 能从当前 workspace root 启动 warmup/work/refresh；
- 能展示 agent 当前阶段和基础事件日志；
- 能展示本轮 refresh 摘要和 memory diff 入口。

### Product MVP

第一个可用版本应支持：

- `warmup`；
- `work "<task>"`；
- work 后自动 `refresh`；
- 启动时基于当前 VS Code workspace 自动查找 `.apeiron/`；
- 启动时基于 `inventory.json` 执行 coverage scan；
- VS Code 聊天页面；
- 顶部 agent 状态栏；
- 默认折叠的执行事件流；
- 本轮 diff 面板；
- 当前 context pack / 上下文检查器；
- 项目覆盖视图；
- 运行中输入支持 `steering` 和 `follow-up` 两种队列；
- 用户消息编辑和重发送；
- 图片和文本文件上传；
- 记忆文档以 markdown 存储，inventory 以 JSON 存储；
- 支持 full warmup 和 scoped warmup；
- scoped warmup 生成项目级粗略描述，并允许 scope 外文件为 unread；
- work/refresh 支持 opportunistic warmup，顺手补齐本轮已读的 unread 文件；
- warmup 生成 inventory.json、模块文档、runtime 文件文档或多文件总结；
- refresh 按修改文件同步所有相关记忆文档；
- `.apeiron/memory` 和 `.apeiron/ignore.md` 默认进入 git；
- `.apeiron/sessions`、`.apeiron/context-packs`、`.apeiron/attachments` 默认 git ignore；
- 基础线性 session 存储；
- checkpoint 选择，或至少 checkpoint 创建；
- 基于 git diff 的记忆更新；
- 最小工具集：read、edit、bash、grep/list files。

第一版不包含：

- 完整 AST/LSP 索引；
- 多 agent 编排；
- 远程执行；
- 浏览器 UI；
- TUI；
- 多渠道消息；
- 复杂权限系统；
- 向量数据库；
- 完整 session tree。

## 15. 未来扩展

后续可能方向：

- AST 或 tree-sitter 索引；
- LSP 驱动的 symbol map；
- 基于文件 hash 的 stale memory 检测；
- 上下文包归档和搜索；
- 记忆 revision diff；
- 按模块拆分记忆文件；
- 测试影响预测；
- 作为 Pi extension 集成；
- 作为 Codex/Claude Code 的 context-prep 工具集成。

## 16. 待讨论问题

- 记忆应该放在 `.apeiron/` 下，还是项目根目录文档中？
- refresh 是否总是在 work 后运行，还是只在文件变更后运行？
- session 应存储完整工具结果，还是压缩后的总结？
- provider/auth 应该复制、直接 import，还是包一层？
- 聊天页面用单 Webview 实现，还是拆成 VS Code Chat Participant 与自定义 Webview？
- 附件应复制到 `.apeiron/attachments`，还是只保存原始文件引用？
