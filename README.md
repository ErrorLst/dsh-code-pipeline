# @dsh-external/dsh-code-pipeline

DSH bundle plugin：为 `code-pipeline` agent 预设（PTC Code Mode 流水线）**动态注入**
阶段子代理工具，并允许在设置页配置各阶段子代理使用的模型。

## 解决的问题

`code-pipeline` 预设原本把 3 个 `dsh-tool-subagent` 行（`subagent_plan` /
`subagent_impl` / `subagent_review`）以及每个阶段的 `provider/model/persona/toolFilter`
静态钉死在 `agent.cordis.yml` 里。改模型 = 改 YAML = 重启会话。

本插件把「注册哪些工具」与「用哪个模型」解耦：

- **工具注册（静态）**：监听 `agent/created`，对组合了 `code-pipeline` 预设的
  ROOT 代理，在其自身作用域（`agent.ctx`）注册 3 个阶段工具。子代理（阶段代理）
  不注入——它们的 persona / 只读工具面由父代理通过 `subagents.start` 请求传入。
- **模型选择（动态）**：每个阶段工具**每次调用时**读取设置命名空间
  `code-pipeline`（`$DSH_HOME/settings.yaml` 的 `code-pipeline` 节），即时生效。
- **设置页（浏览器）**：Settings → 代码流水线，每阶段配置 `enabled` /
  `provider` / `model` / `reasoningEffort` / `maxConcurrency`，provider/模型列表来自
  `GET /dsh-code-pipeline/options`（不可用时相应字段禁用并提示，不允许手输）；
  每阶段卡片还显示「当前运行 N / 上限 M」，数据来自
  `GET /dsh-code-pipeline/status`（每 5 秒轮询）。

## 角色边界（硬约束）

- `subagent_plan` **只做规划**：不审查、不审计、不审批代码；
- `subagent_review` **只做审查**：不做规划、不做设计；
- 两个阶段的 persona 都明确写出该边界，并在收到另一类任务时要求子代理声明自己的
  角色并拒绝执行；工具的 description 也标注了「PLANNING ONLY / REVIEWING ONLY」，
  防止主代理把审查任务误派给 plan、把规划任务误派给 review。
- **阶段不可用 = 结束任务**：阶段工具调用报错（阶段被禁用/未配置、provider/凭据
  缺失、provider 未注册、子代理启动失败）时,工具错误信息携带明确的
  「STOP and report to the user」指令,预设 persona 的 invariants 也硬性规定
  主代理**不得自己接手任务**（不代做实现/规划/审查、不换路由、不找替身),
  而是告知用户原因并等待决定。

## 中途改需求：pipeline_followup（插入，不排队）

阶段子代理已经派发并开始干活后，用户改了需求 → 主代理用 `send_message` 只能
靠模型自己找到子代理 id；**`pipeline_followup` 是流水线自己的"插话"工具**：

- 参数 `child`：`latest`（本代理最近派发的阶段子代理）| 阶段键
  `plan` / `impl` / `review`（含中文别名 规划/计划/实现/评审/审查）| 完整
  `subagentId`（`session-...`，也支持唯一前缀）；
- 参数 `message`：要插入的需求变更文本（完整、自包含——子代理没有本对话上下文）；
- 行为：调用宿主原生 `subagents.sendMessage`（alpha.4 语义 = **steer/插入**）——
  运行中的子代理在**下一个模型步骤**就看到该消息（不排进队列等当前回合结束）；
  子代理已空闲/已结束时会唤醒开新回合处理；
- **投递方式可配置**（设置 → 代码流水线 →「子代理消息投递」）：默认**固定插入**
  （`sendMessage`/steer，运行中最近步骤即收到）；切到**固定排队**后走原生
  human-queue 通道（`subagents.prompt`，当前回合结束后按顺序处理）；
- 资格：与其他阶段工具一致，只对组合了 `code-pipeline` 预设的 ROOT 代理注入；
  子代理身份校验由宿主 lineage 授权（非本代理直属子代理会被拒绝并报错）。

## 评审物料**只允许写系统临时目录**（`$env:TEMP`）

主代理为了把大的变更集从 `subagent_review(diff=…)` 参数里卸下来，可能用
`Out-File` 把 diff 写到项目根目录（如 `.review_*.diff`，已多次实测发生）。
三个阶段工具的 description 现带**绝对物料卫生纪律**：工作区任何位置
（根目录 / 子目录 / `.pipeline-tmp/`）都**不允许**创建任何物料/中间文件
（`*.diff`、`.review_*`、变更集文件等）；确需落盘时**只允许**写入
`$env:TEMP\dsh-code-pipeline\`，且必须在本次调用返回前删除。

> 注意：**子代理自己的输入框**仍会排队（宿主 `subagents.prompt` 硬编码
> `mode: 'continuable'`，且输入栏对子代理会话关闭了 steering）——这是宿主行为，
> 插件侧无法改变；改需求请走主对话 → 代理调用 `pipeline_followup`。

## 安装

### 方式一：一行命令安装（推荐，GitHub 分发）

```bash
dsh plugin --profile web add github:ErrorLst/dsh-code-pipeline
```

- 该命令在 web profile 下执行 `pnpm add github:ErrorLst/dsh-code-pipeline`；安装成功后
  reconcile 会读取包内 `dsh.bundle.patch` 声明，自动把
  `@dsh-external/dsh-code-pipeline` 追加进 `dsh.profile.bundles`（**无需手动登记**）。
- 重启 `dsh web` 即挂载生效（bundle 层在启动时组合，客户端 bundle 在启动时扫描）。
- **首次启动自动安装预设**：检测到 `$DSH_HOME/.agent-presets/code-pipeline` 缺失时，
  插件自动从包内 `preset/code-pipeline/` 拷贝（幂等；已安装则跳过，**绝不覆盖**）。

### 方式二：本地开发安装

```bash
dsh plugin --profile web add link:<本仓库绝对路径>
# 或：dsh plugin --profile web add <本仓库绝对路径>
```

- 与方式一相同：`dsh plugin add` 自动完成依赖安装与 bundle 登记，无需手动编辑
  `dsh.profile.bundles`；默认 profile 名为 `web`，其他用
  `dsh plugin --profile <name> add ...`。
- 启动后预设同样自动安装；本仓库以 `link:` 挂载，改 `lib/` 后重启 dsh 生效，
  客户端改动刷新页面即可。

### 卸载

```bash
dsh plugin --profile web remove @dsh-external/dsh-code-pipeline
```

从依赖与 bundle 层移除；预设目录（`$DSH_HOME/.agent-presets/code-pipeline`）**不会**被
删除，需要时手动删除即可。

## 预设文件（preset/）

`code-pipeline` 预设的组合内容（主代理 persona 与流水线协议、Code Mode 展示、
禁用通用 `subagent`/`subagent_fork`、delegation 组等）**随本仓库在
`preset/code-pipeline/` 目录维护**（`agent.cordis.yml` + `preset.yml`）。

- **自动安装**：插件启动时若发现 `$DSH_HOME/.agent-presets/code-pipeline` 缺失，
  会从包内 `preset/code-pipeline/` 自动拷贝（首次安装无需手动步骤；已存在则跳过，
  **绝不覆盖**——升级时不会悄悄改写你的预设）。
- **手动补装**（自动安装失败/被跳过时）：

  ```powershell
  Copy-Item -Recurse -Force "$PSScriptRoot\preset\code-pipeline" "$env:DSH_HOME\.agent-presets\code-pipeline"
  ```

  （`$env:DSH_HOME` 默认 `C:\Users\<user>\.dsh`。）

- **升级同步**：插件升级后若行为对不上（工具名/规则文本变化），用仓库新版本
  **整目录覆盖** `$DSH_HOME\.agent-presets\code-pipeline\`（`Copy-Item -Recurse -Force`）；
  `diff -r` 两份目录即可先确认差异。

- 生效时机：**新会话/新子代理**生效（dsh 的 standing 挂载按组合文件的变化时间戳
  重建）；**已经在运行的会话不会**自动切换——需要换新预设请开新会话。

- 插件与预设的版本对应：插件只保证与**仓库内 preset/ 副本**一致的那一版预设协同
  工作。升级插件后若发现行为对不上（如工具名、规则文本变化），优先检查
  `$DSH_HOME\.agent-presets\code-pipeline\` 是否落后于仓库的 `preset/code-pipeline\`——
  `diff -r` 两份目录即可确认。插件启动时若发现目标预设目录缺失，会自动安装（见上）。

## 预设要求

- 预设中**不得**再包含静态的 `stage-plan` / `stage-impl` / `stage-review` 行
  （由插件注入，避免重名/双重定义）。
- 其余组成（persona、Code Mode 展示、只读过滤语义、禁用通用
  `subagent`/`subagent_fork`、禁用 `tool-workflow`、delegation 组）保持仓库
  `preset/` 副本的样子。
- 与上游内置 `ptc` 同步的宿主行**不要删**：例如 0.1.5-alpha.2 起新增的
  `- id: present`（`@deepseek-ai/dsh-tool-present`）——阶段子代理写的文件要靠
  它由主代理登记为「本轮交付物」；删掉后模型侧再无交付声明工具（persona 里的
  交付要求会指向一个不存在的工具）。
- 仓库内的 `preset/code-pipeline/` 就是唯一维护源：对预设的任何修改请先改这里，
  再同步拷贝到 `$DSH_HOME\.agent-presets\code-pipeline\`。

## 人工闸门（plan 之后）

build flow 的闸门是**对话内自然闸门**，不用 `ask_user_question` 弹卡片（卡片不支持
Markdown 渲染，长计划会挤压展示）：

1. plan 阶段返回后，主代理把**完整计划**以正常 Markdown 回复直接呈现在对话中，
   然后结束回合等待用户输入；
2. 用户下一条消息即闸门答复：**批准**（approve / 批准 / 同意 / ok / 可以 / 开始 /
   没问题 等，且无新增要求）→ 进入实现阶段；**其他任何内容**视为修订反馈 → 并入计划
   重新呈现（最多两轮修订后停止并报告）。

运行规则以 `preset/code-pipeline/agent.cordis.yml` 的 pipeline protocol 为准。

## 派发消息整体落盘（单个临时文件）

主代理调用阶段工具时，插件把**完整派发消息**——`prompt`/`task` 与该阶段所有物料字段
（`context` / `plan` / `constraints` / `implementationSummary` / `diff` / `focus`）合并后的
**全文**——整体写入**一个临时文件**（`os.tmpdir()/dsh-code-pipeline/` 下，文件名带阶段前缀和
UUID），子代理提示中仅保留
`<dispatch message (N lines, M chars)> written to temp file: <path> — read the WHOLE file with the read tool`
引用。子代理只需 `read` **一次**即可拿到全部消息：不会因长 diff 在派发/模型上下文中被截断，
也避免了逐字段多文件的读取负担。

- **默认全部落盘**（`config.spillAllFields: true`，设置页可关）；关闭后回退阈值模式：
  仅当消息超过 `config.largeFieldLines`（默认 100）行时才落盘。
- review 的 `diff` 硬校验不变：**原始值**必须含 `@@` 块头（完整补丁文本）——校验在落盘
  之前执行，统计摘要 / “见 git show”引用仍被拒绝。
- 临时文件在启动时自动清理（超过 24 小时的删除）。

## 长任务与后台派发

阶段工具**没有工具级超时**（未声明 `timeoutMs`，不会触发官方 timeout policy）；但前台等待
受当前回合/调度生命周期约束，长跑阶段可能被回合边界截断（如单回合 20 分钟限制）。

- **后台模式（默认，推荐）**：`run_in_background` 省略/为 `true`——立即返回
  `{"kind":"continuable","subagentId":"..."}` 并结束回合；阶段子代理独立会话继续运行，
  **完成后 runtime 自动向本会话发送通知**（含结果与最终回复）；
- **前台模式（仅短任务）**：`run_in_background: false`——等待阶段结果；**注意**
  `run_code` 程序有 20 分钟 wall-clock 上限，超过会截断等待并取消子代理，所以只有
  几分钟内能完成的小任务才用前台；
- **状态可见**：`list_agents`（running / idle / ready）、`send_message` 继续子代理；
  完成通知里就带子代理的 outcome 与最终回复（没有独立的 history 工具，
  所以阶段子代理必须把完整结论写进最终回复），GUI 子代理视图同步展示；
- 长任务（预计超过当前回合可承受时长）请用后台模式，收到完成通知后再继续下一步。

## 默认值

所有阶段默认统一走 `deepseek-official` / `deepseek-flash`（= DeepSeek-V41-Flash，
dsh 0.1.5-rc.1 起宿主 `agent-default-model` 的默认模型 id；旧 id
`deepseek-v4-flash` 仍在默认目录中，但已不是默认，且宿主目录可被
`settings.yaml` 的 `llm-deepseek.models` 收窄——插件默认值必须留在默认目录内）：

| 阶段 | 默认 provider | 默认 model | 默认并发上限 | 角色 |
| --- | --- | --- | --- | --- |
| plan | deepseek-official | deepseek-flash | 0（不限制） | 只读,仅规划 |
| impl | deepseek-official | deepseek-flash | 0（不限制） | 全工具面,仅实现 |
| review | deepseek-official | deepseek-flash | 0（不限制） | 只读,仅审查 |

> 已保存过阶段配置的会话不受影响：`settings.yaml` 的 `code-pipeline.stages` 里显式
> 写下的 provider/model 始终优先于这里的默认值。

> 无 fallback 孪生工具:阶段 provider/凭据/启动失败时直接报错并报告,不自动换路由。

## 思考等级(reasoningEffort)

每阶段可在设置页配置「思考等级」。**选项按所选模型的实际支持面列出**——host
端点通过 `llm.resolveModelInfo(provider, model)` 读取每个模型的
`reasoning.efforts`(deepseek 系为 off/low/high/max,GLM-5.3 为 low/high/max);
信息不可用时用兜底交集 [low, high, max]。换 provider/模型时自动重置为「继承默认」,
避免把模型不支持的等级写入配置(运行时对不支持的等级会直接拒绝调用)。

**留空 = 继承 provider 路由级默认**(如 `llm-deepseek.reasoningEffort`、
`llm-pi-ai` 路由的 `reasoning`)。实现方式:工具派发时给子代理 options 打
`stageKey` 标记;插件在官方扩展点 `agent/request` waterfall 中,对命中阶段且已
配置思考等级的子代理注入 `reasoningEffort`;留空则完全不动调用配置。

## 每阶段并发上限与并行派发

- **设置项**：Settings → 代码流水线 → 每个阶段卡片的「最大并发子代理数」。口径是
  **同一父会话内该阶段同时运行（宿主 `activity = running`）的子代理数**；`0` = 不限制（默认）。
- **准入判定（两步）**：
  1. **同步先到先得**：用插件账本（运行中 + 本次启动预留）判定，超限立即拒绝；
     通过则同步占位。判定必须完全同步——PTC 的 `Promise.all` 会让同一阶段的多个
     调用同时进入 `execute`，若等 `await` 之后再判定，两个并发调用会互相把对方
     算进名额而**双双被拒**（开发时实测到这个缺陷，已修）。
  2. **异步核对**：再用宿主 `subagents.listChildren(parent.id)` 的
     `activity === "running"` 核对真实运行数（捕获账本不知道的子代理：重启前派发
     的、被 `pipeline_followup` 唤醒的），偏保守时可以拒绝一个刚准入的调用；同时
     用结果修剪账本里已 settle 的条目（自愈）。宿主没有 `listChildren` 或查询失败
     时退回账本，并用 live Agent 的 `status === "idle"` 修剪。
  超限时工具**拒绝**本次派发，错误信息明确标注「这是瞬时策略拒绝，不是阶段不可用」——
  主代理应等完成通知后派发剩余目标，或改用 `pipeline_followup` 给运行中的子代理
  插话，**不得**按 UNAVAILABLE 规则终止任务。
- **动态修改**：工具每次调用都读设置，所以保存后**下一次派发**立即生效，无需重启。
  调高立即放开；**调低不会中断正在运行的子代理**，只是在新派发时按新值拦截，直到
  运行数降到新值以下。设置页每 5 秒轮询 `/dsh-code-pipeline/status` 显示
  「当前运行 N / 上限 M」。
- **边界**：宿主每个 `run_code` 程序仍有 `maxParallelSubCalls`（默认 10）的并行
  子调用上限，所以设 20 也不会在一个程序里真正并行超过 10 个；`ralph` 派发的子
  代理不经过阶段工具，不受此限；账本是进程内的，dsh 重启后无法从宿主数据恢复旧
  子代理的阶段身份（它们不再计入）。
- **预设侧的并行偏好**：`code-pipeline` 预设的 pipeline protocol 要求
  「独立目标优先在一个程序里并行派发多个阶段子代理以加快进度」，并说明超限拒绝
  是瞬时的、不是阶段失败。

## 重要实现事实（与官方 dsh 源码核对）

- `dsh-tool-subagent` 的 `execute` 本质是 `ctx.subagents.start('spawn', { ...,
  agentOptions, persona, toolFilter, maxDepth })` —— 模型等是**调用时参数**。
- `dsh-subagent` 创建子代理时：`composeFrom(childCtx, parent.ctx)` 继承父代理
  预设；`persona` → 子代理 `deployment:persona-prefix` 提示段（0.1.3 起该段由
  `deployment:persona` 拆成 prefix/suffix，见下条）；`toolFilter` →
  `childCtx.tools.restrict(...)`；`agentOptions.provider/model` 优先于父代理路由。
- **dsh 0.1.3 起的行配置与协议变更（本插件已适配）**：
  - `@deepseek-ai/dsh-persona` 的配置字段由 `text` 改为 `prefix`（必填）+
    `suffix`（可选）；旧 `text` 会让该行激活失败，整个预设挂载报
    `agent-preset/invalid`。预设内用 `prefix`（section 序号与旧 `text` 相同）。
  - `subagents.prompt`（pipeline_followup 的 queue 通道）的载荷新增必填
    `delivery: 'queue' | 'steer'`，`mode` 固定 `'continuable'`；插件按
    「0.1.3+ → alpha.4 → 更早」顺序探测，首个被接受的形状即采用。
  - 会话格式 v2 把助手流内联进 `assistant/message` / `assistant/attempt` 的
    `data.stream`（与本插件无直接关系，但会话读取类插件需注意）。
- 工具注册的层由注册时 ctx 的作用域决定（实测：预设 standing 挂载不向其他
  会话泄漏）；通过 `agent.ctx` 注册落入该代理自身层，代理销毁自动回收。
- `tools.restrict` 只过滤继承层（global + 祖先），不过滤代理自身层 —— 因此
  阶段工具只注入 ROOT 代理，避免子代理的自有层被其只读过滤豁免。

## 变更记录

- **0.1.13（对齐 dsh 0.1.5-rc.1：阶段默认模型跟进宿主新默认 `deepseek-flash`）**：
  - rc.1 逐包核对结论：插件依赖面**零破坏**——客户端 bundle 契约
    （`dsh.client` 扫描 / `__ModuleLoader__.load`）、`ui-slots` 的 register+inject
    语义、本插件所用的槽位（`settings.section`；`shell.overlay` 本插件未用）、
    `--dsh-*` 设计令牌（alpha.2 与 rc.1 各 42 个，逐一比对无增删）、宿主服务
    （`agentPresets` / `subagents.listChildren` / `settings` / `webServer` /
    `llm` / `agents` / `tools`）全部未变；预设行的上游集合也未变
    （0.1.5-alpha.2 补的 `present` 行仍是当前上游形态）。
  - rc.1 的源码改动集中在 `ui-sidebar-documentpreview`（新增 renderer 可选
    `scrollportRef`、`data-code-block-content` 滚动视口）、`ui-sidebar-right` 引导页
    （tab 类型新增可选 `description`）、`ui-chat` 统计胶囊（`cacheWriteTokens` 为 0 时
    省略该行）与 `CodeBlock`（新增可选 `contentRef`）——全部是本插件未注册/未使用的
    内部实现，无需跟随。
  - **唯一需要跟进的是宿主默认模型**：rc.1 在 `packages/bundle/base/cordis.patch.yml`
    把 `agent-default-model` 从 `deepseek-v4-flash` 改为 `deepseek-flash`
    （DeepSeek-V41-Flash；`llm-deepseek` 目录同步新增该条目并保留 V4 三款）。
    插件三阶段默认值同步改为 `deepseek-official` / `deepseek-flash`：
    `lib/index.js` 的 `DEFAULT_STAGES`、`lib/client.js` 的卡片兜底值与三段提示文案、
    预设头部注释、README「默认值」表。
  - 为什么这是修复而不只是跟随：宿主目录可被 `settings.yaml` 的
    `llm-deepseek.models` 收窄（例如只列 `deepseek-flash`），此时**未配置**的阶段若仍按
    旧默认 `deepseek-v4-flash` 派发，会在模型解析阶段直接失败；已显式配置过的阶段
    （`code-pipeline.stages` 里写死的 provider/model）不受影响。

- **0.1.12（适配 dsh 0.1.5-alpha.2：预设补 `present` 交付声明工具）**：
  - 逐包核对 alpha.2 对插件依赖面的改动：客户端 bundle 契约（`__ModuleLoader__` /
    `dsh.client` 扫描 / `ui-slots` 的 register + inject 语义）、所用三个槽位
    （`shell.overlay` / `settings.section` / `conversation.composer.dock`，前两者
    语义未变，第三个仍是 list 槽 order 0 为内置 stats）、所用 CSS 变量与 DOM 锚点
    （`--dsh-chat-content-width`、`--dsh-composer-side-clearance`、
    `--dsh-scrollbar-thumb{,-hover}`、`data-conversation-scroll`、`data-chat-flow`、
    `data-sidebar-collapsed`、`data-rightbar-fullscreen`）、宿主服务
    （`agentPresets` / `subagents.listChildren` / `settings` / `webServer`）均未变；
    alpha.2 删除的 `ui-primitives.DocumentFileIcon` 与 `resources.reload` 本插件未使用。
  - 顺带记录 alpha.2 的两处相关变化（不影响本插件）：中心栏槽位 `conversation` 更名为
    `main` / `main.conversation`（本插件不注册中心栏）；新增会话事件
    `deliverables/presented`、`subagent/catalog`（事件折叠按正向类型匹配，未知类型安全忽略）；
    `subagents.listChildren` 内部改走新的 `subagentCatalog` 投影（签名与返回类型不变，
    本插件的并发准入核对因此更快）。
  - 预设补上上游 `ptc` 在 alpha.2 新增的 `- id: present`（`@deepseek-ai/dsh-tool-present`）：
    产出文件登记为「本轮交付物」（ui-deliverables 卡片行，可预览或在宿主默认应用中打开）。
  - persona 新增 `### Deliverables` 段与一条 Invariant，Report 步骤同步要求交付声明：
    交付归属**调用方会话**——阶段子代理写的文件必须由主代理自己 `present`
    （子代理自行声明只会登记到子代理会话，主会话看不到）。
- **0.1.11（每阶段并发上限 + 预设并行派发偏好）**：
  - 新增设置项 `stages.<stage>.maxConcurrency`（默认 0 = 不限制）：同一父会话内该
    阶段同时运行的子代理上限。准入两步：**同步先到先得**（账本 + 预留，避免并发
    调用互相算名额而双双被拒）→ **异步核对**宿主 `subagents.listChildren` 的
    `activity === "running"` 并修剪账本（覆盖 PTC `Promise.all` 竞态、重启后或
    被 followup 唤醒的子代理）。超限拒绝并明确标注为瞬时策略拒绝（**不是**阶段
    不可用，不得终止任务）。已用假 ctx 集成测试覆盖：顺序准入 / 超限拒绝 / settle
    释放 / 并发竞态（limit=1 恰好 1 成功 1 拒绝）/ limit=0 不限制 / 外部 running
    拦截 / 状态端点。
  - 新增只读端点 `GET /dsh-code-pipeline/status`（各阶段 running / pending / limit），
    设置页每阶段卡片显示「当前运行 N / 上限 M」并每 5 秒轮询。
  - 预设 pipeline protocol 的 Parallel dispatch 段升级为「优先并行」：独立目标应在
    一个程序里并行派发多个阶段子代理以加快进度；Invariants 同步更新；三条阶段工具
    的 description 补充 CONCURRENCY 说明（超限是瞬时的 + 鼓励并行派发）。
- **0.1.10（适配 dsh 0.1.5-alpha.1 + 自身缺陷修复）**：
  - 宿主 API 全部核对未变（agentPresets / subagents / 四个事件 / 工具注册与输出 schema /
    settings.installSection / webServer / 预设行与包名），预设与内置 `ptc` 逐行比对无过期项。
  - 修 `readFileSync` 未导入：预设陈旧自检此前抛 ReferenceError 被 catch 吞掉，
    永远不会告警（现在已可用）。
  - 修模型侧指引引用不存在的 SDK 函数 `subagent.history`（PTC SDK 只有扁平的
    `tools.<工具名>`，宿主没有 history 工具）——改为「完成通知本身就是最终结果」。
  - 修 `pipeline_followup` 在回执缺 `messageId` 时返回 undefined 属性 →
    宿主输出校验报 `not lossless JSON`（消息已投递却报错）；现在缺键即省略。
  - 注入记账由「agent id 集合」改为 `WeakSet<Agent>`：宿主支持同 id 冷恢复，
    旧的 id 集合会让恢复后的会话拿不到阶段工具。
  - 设置节 schema 收窄到真正生效的 `stages` + `followupMode`（其余四项是组合配置，
    写设置页不会生效）；`largeFieldLines` 补进 Config 声明。
  - 预设 `tool-web.fetch` 与上游 `ptc` 对齐改回 `true`（只读阶段的 `web_fetch`
    由 toolFilter 拦截，主代理恢复该能力）；输出 schema 去掉重复的 `messageId` 属性；
    客户端删掉从未使用的 `connection` / `remote` inject。