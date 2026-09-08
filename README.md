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
  `provider` / `model`，provider/模型列表来自
  `GET /dsh-code-pipeline/options`（不可用时相应字段禁用并提示，不允许手输）。

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
- **状态可见**：`list_agents`（running / idle / ready）、`send_message` 继续子代理、
  `subagent.history` 取完整记录，GUI 子代理视图同步展示；
- 长任务（预计超过当前回合可承受时长）请用后台模式，收到完成通知后再继续下一步。

## 默认值

所有阶段默认统一走 `deepseek-official` / `deepseek-v4-flash`：

| 阶段 | 默认 provider | 默认 model | 角色 |
| --- | --- | --- | --- |
| plan | deepseek-official | deepseek-v4-flash | 只读,仅规划 |
| impl | deepseek-official | deepseek-v4-flash | 全工具面,仅实现 |
| review | deepseek-official | deepseek-v4-flash | 只读,仅审查 |

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