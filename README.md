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
  每阶段卡片还显示「当前运行 N / 上限 M / 已创建 K」与已创建子代理清单，数据来自
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
  **例外（不算阶段不可用，不得终止任务）**：插件自己的**运行并发闸门**与宿主的
  「同时存活子代理」容量上限——运行并发超限、宿主 `ACTIVATION_LIMIT_REACHED` /
  `subagent/delivery-unavailable`（dsh 0.1.6-alpha.2 起）。这些是**瞬时**拒绝，阶段本身
  健康；错误文案会明确写「NOT stage unavailability」并给出「等名额释放后在后续步骤重试/派发
  新子代理」的出路（见「每阶段并发上限与并行派发」）。

## 中途改需求：pipeline_followup（插入，不排队）

阶段子代理已经派发并开始干活后，用户改了需求 → 主代理用 `send_message` 只能
靠模型自己找到子代理 id；**`pipeline_followup` 是流水线自己的"插话"工具**：

- 参数 `child`：`latest`（本代理最近派发的阶段子代理）| 阶段键
  `plan` / `impl` / `review`（含中文别名 规划/计划/实现/评审/审查）| 完整
  `subagentId`（`session-...`，也支持唯一前缀）；
- 参数 `message`：要插入的需求变更文本（完整、自包含——子代理没有本对话上下文）；
- 参数 `files`（**必填**）：本轮要读的路径，一行一个，与三个阶段工具的 `files` 共用同一套契约
  与渲染。真清单会渲染成「先用**一个** `run_code` 程序把每个路径读完」的硬指令；单个 `-`
  显式声明「本轮没有候选清单」（子代理自己做侦察）。**省略 ⇒ 拒绝并点名 `files`**。为什么必填：
  复用路径曾经只发一段自由文本，一个被复用去干**另一个 workstream** 的实现子代理于是花了
  **7 步 / 15 次 read** 去重新发现一份主代理手里已有的清单——`files` 在派发路径上修过一次
  （0.3.5/0.3.6），这是把它补回**复用**这条路径；
- 参数 `compact`（可选，默认 `false`）：**在投递之前**压缩**该子代理自己**的历史
  （走该预设 realm 私有的 `compaction` 服务——`agentPresets.serviceFor(agent, "compaction")`，
  超时 10 分钟）。只应在「复用会把干扰带进来」时用（四条可判定判据见预设的
  「Reuse the stage subagents you already have」小节）；代价是抹掉它超出摘要的历史记忆并
  放弃前缀缓存。**压缩失败 ⇒ 什么都不投递**（错误文案明说 inbox 未变，可改用 `compact: false`
  投递）；`compactNow` 返回「没有可压区间」不算失败，投递照常。冷子代理（重启后本进程未唤醒）
  无法压缩，**唤醒也救不了**——子代理答完就回到冷态：两条宿主约束结构性互斥（压缩需要**活着的**
  agent，而活着的 agent 要么正在回合中（`compactNow` 抛 `busy`），要么刚被一次投递冷唤醒、inbox
  已经满了）。实测本安装 16 次压缩（11 次手动 `/compact` + 5 次自动）**没有一次属于阶段子代理**，
  所以复用时 `compact: true` 不可用：**同一工作流的真正续轮就接受干扰；如果是新的独立工作流，直接给它派发新子代理（0.4.0 起没有创建名额上限），并说明选了哪一个**；
- 行为：调用宿主原生 `subagents.sendMessage`（alpha.4 语义 = **steer/插入**）——
  运行中的子代理在**下一个模型步骤**就看到该消息（不排进队列等当前回合结束）；
  子代理已空闲/已结束时会唤醒开新回合处理；
- **投递方式可配置**（设置 → 代码流水线 →「子代理消息投递」）：默认**固定插入**
  （`sendMessage`/steer，运行中最近步骤即收到）；切到**固定排队**后走原生
  human-queue 通道（`subagents.prompt`，当前回合结束后按顺序处理）；
- 资格：与其他阶段工具一致，只对组合了 `code-pipeline` 预设的 ROOT 代理注入；
  子代理身份校验由宿主 lineage 授权（非本代理直属子代理会被拒绝并报错）。
- **它同时是多轮评审复用的通道**：评审第 2 轮起用 `pipeline_followup` 续用同一个评审
  子代理（见下节「多轮评审复用」）——同一个投递通道，`child` 传该评审子代理的 `subagentId`。

## 多轮评审复用（续用同一个评审子代理）

多轮评审（plan → impl ↔ review 里的 review 轮次）不再每轮新开一个评审子代理：**第一轮
之后的所有轮次通过已有的 `pipeline_followup` 续用第一轮那个评审子代理**。

这是「**同一任务只创建一次**」这条统一协议在评审阶段的具体形态：预设的
「Reuse the stage subagents you already have (SAME child, later rounds)」把
**plan / impl / review 三阶段**都写进同一条协议（同一 workstream/任务第一次用阶段工具派发，之后每一轮都用
`pipeline_followup` 发给已有的那个子代理；而一个**新的独立 workstream/任务**一律新派自己的子代理——
0.4.0 起没有创建总量上限，只有「同时运行数」上限会让新派发等一个名额）。
**没有新增任何设置项**（复用既有 `maxConcurrency`，现在它是纯运行并发上限）。

- **为什么**：子代理从空会话起步——每轮新开 `subagent_review` 都要重新吃一遍「计划 +
  完整 diff + 历史结论」，而且新会话没有前缀缓存可命中；续用同一个子代理时，这些都在它的
  会话里（前缀命中缓存），新一轮只需投递增量物料。
- **怎么做**（persona 的硬性协议，见预设「Repeat review rounds reuse the SAME reviewer」）：
  1. 第 1 轮照常 `subagent_review`（计划 + 实现摘要 + 完整 diff），并**记住它返回的
     `subagentId`** —— 那个子代理就是本任务的评审者（写进 `todo_write` 流程，防上下文压缩丢失）；
  2. 第 2 轮起改用 `pipeline_followup`：`child` 传该 `subagentId`（本会话只有一个评审子代理时
     可用 `child: "review"`），`message` 里写清「这是第几轮 + **完整的新 diff** + 每条编号问题的
     处理说明 + 回复契约（`APPROVED` / `CHANGES REQUIRED:` + 编号问题）」；**计划与历轮 diff
     不要再传**（评审子代理自己还留着，重复传正是复用要省掉的开销）；
  3. 结论仍以「完成通知」形式回到本会话，与首轮完全一致——主代理侧流程不变。
- **边界**：
  - 该评审子代理还在跑（结论未到）时**不要**续发新回合——先等完成通知（与"不要重复派发
    进行中的阶段"同一条规则）；
  - **新任务用新的 `subagent_review`**，绝不复用别的任务的评审子代理；
  - 多个独立目标并行评审时，每个目标一个评审子代理，按各自的 `subagentId` 续用；
  - `pipeline_followup` 报「没有匹配的阶段子代理」时（例如 dsh 重启后插件进程内的派发台账
    被清空），退回一次带完整物料（含计划）的 `subagent_review` 即可——这是**回退**，不是
    「阶段不可用」，不要因此终止任务；但若该阶段**已达运行上限**（见下节），这次回退也要等一个名额释放——此时先等完成通知、或在后续步骤重试；
  - 宿主侧依据：`pipeline_followup` 走 `subagents.sendMessage`，空闲/已 settle 的子代理会被
    唤醒成新一轮（宿主 `steer` 语义：idle driver starts a turn；`queue` 模式同理排一个新回合），
    且再次 settle 时父会话照常收到完成通知。
## 评审物料**只允许写系统临时目录**（`$env:TEMP`）

主代理为了把大的变更集从 `subagent_review(diff=…)` 参数里卸下来，可能用
`Out-File` 把 diff 写到项目根目录（如 `.review_*.diff`，已多次实测发生）。
三个阶段工具的 description 现带**绝对物料卫生纪律**：工作区任何位置
（根目录 / 子目录 / `.pipeline-tmp/`）都**不允许**创建任何物料/中间文件
（`*.diff`、`.review_*`、变更集文件等）；确需落盘时**只允许**写入
`$env:TEMP\dsh-code-pipeline`，且必须在本次调用返回前删除。

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
  **整目录覆盖** `$DSH_HOME\.agent-presets\code-pipeline`（`Copy-Item -Recurse -Force`）；
  `diff -r` 两份目录即可先确认差异。

- 生效时机：**新会话/新子代理**生效（dsh 的 standing 挂载按组合文件的变化时间戳
  重建）；**已经在运行的会话不会**自动切换——需要换新预设请开新会话。

- 插件与预设的版本对应：插件只保证与**仓库内 preset/ 副本**一致的那一版预设协同
  工作。升级插件后若发现行为对不上（如工具名、规则文本变化），优先检查
  `$DSH_HOME\.agent-presets\code-pipeline` 是否落后于仓库的 `preset/code-pipeline`——
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
  再同步拷贝到 `$DSH_HOME\.agent-presets\code-pipeline`。

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
受当前回合/调度生命周期约束，长跑阶段可能被回合边界截断（宿主 `run_code` 的墙钟默认 120 s、
部署上限 600 s，传 `timeoutMs` 可顶到部署上限）。

- **后台模式（默认，推荐）**：`run_in_background` 省略/为 `true`——立即返回
  `{"kind":"continuable","subagentId":"..."}` 并结束回合；阶段子代理独立会话继续运行，
  **完成后 runtime 自动向本会话发送通知**（含结果与最终回复）；
- **前台模式（仅短任务）**：`run_in_background: false`——等待阶段结果；**注意**
  `run_code` 程序的墙钟**默认 120 s、部署上限 600 s**（传 `timeoutMs` 可顶到上限），
  超过会截断等待并取消子代理，所以只有几分钟内能完成的小任务才用前台；
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

> **0.4.0 起 `maxConcurrency` 只表示「同时运行」的并发上限**（默认 `0` = 不限制，零回归）。
> 旧版本那个「同一 (父会话 × 阶段) 已创建（含已结束）总量」闸门已**移除**：新工作流一律派发
> 自己的新子代理；只有同一工作流的后续轮次才用 `pipeline_followup` 续用。

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

- **设置项**：Settings → 代码流水线 → 每个阶段卡片的「最大并发子代理数（同时运行）」。
  口径是**运行上限**：按 `(父会话 × 阶段)` 统计该阶段**同时运行**（宿主 `activity = running`）
  的子代理数。`0` = 不限制（默认）。
- **按会话独立**：上限由每个父会话**各自**判定——A 会话跑满该阶段不会占用 B 会话的名额；
  账本（运行中 + 在途创建）与宿主 `listChildren(parent.id)` 核对都以父会话为键。跨会话只做
  展示用的合计，绝不参与准入判定。
- **没有「已创建总量」上限（0.4.0 移除）**：一个**新的独立工作流**永远可以派发自己的新子代理，
  不论这个阶段之前创建过多少个。旧版本用创建总量闸门强制「复用优先」，代价是把新工作流硬塞给
  一个已经做过别的 workstream 的冷子代理（无法压缩，每步重发整段历史）：实测一轮 **63 步 /
  9.7M tokens**、每步重发约 152k，还只能靠一句「忽略之前的内容」在 prompt 里硬压——上下文删不掉。
  现在改由「新工作流派新孩子」这条协议承担：`impl` 的**同一条工作流**后续轮次（评审问题、改需求、
  墙钟续跑）继续用 `pipeline_followup` 回到同一个子代理；**新的独立工作流**直接用本阶段的阶段工具派发。
- **派发被运行上限拦下怎么办**：这是**瞬时策略拒绝，不是阶段不可用**——等一个子代理结束
  （运行名额在子代理结束时释放），然后在**后续步骤**里把剩余工作流各自派成新子代理；正在运行的
  同一工作流孩子可以用 `pipeline_followup` 插话（不创建）。**不要**为了避开等待就把新工作流塞给
  一个不相干的子代理。
- **运行闸门的准入判定（两步）**：
  1. **同步先到先得**：用插件账本（运行中 + 本次启动预留）判定，超限立即拒绝；
     通过则同步占位。判定必须完全同步——PTC 的 `Promise.all` 会让同一阶段的多个
     调用同时进入 `execute`，若等 `await` 之后再判定，两个并发调用会互相把对方
     算进名额而**双双被拒**（开发时实测到这个缺陷，已修）。
  2. **异步核对**：再用宿主 `subagents.listChildren(parent.id)` 的
     `activity === "running"` 核对真实运行数（捕获账本不知道的子代理：重启前派发的、
     被 `pipeline_followup` 唤醒的），偏保守时可以拒绝一个刚准入的调用；同时
     用结果修剪账本里已 settle 的条目（自愈）。宿主没有 `listChildren` 或查询失败
     时退回账本，并用 live Agent 的 `status === "idle"` 修剪。
  超限时工具**拒绝**本次派发，错误信息明确标注「这是瞬时策略拒绝，不是阶段不可用」——
  主代理应等名额释放后在后续步骤重派（同一工作流的后续轮次用 `pipeline_followup`），
  **不得**按 UNAVAILABLE 规则终止任务，也不要把「复用某个不相干的子代理」当成唯一出路。
- **动态修改**：工具每次调用都读设置，所以保存后**下一次派发**立即生效，无需重启。
  调高立即放开；**调低不会中断正在运行的子代理**，只是在新派发时按新值拦截，直到
  运行数降到新值以下。设置页每 5 秒轮询 `/dsh-code-pipeline/status`：其中 `running` / `pending`
  是**单会话最多**（与 `limit` 同口径，因为设置页是全局卡片、无法只显示某一个会话），
  `sessions` / `totalRunning` / `totalPending` 是**跨会话合计**（仅供诊断）——卡片因此显示
  「当前运行（单会话最多）N / 单会话上限 M；共 K 个会话在跑（合计 T）」，**不会**把跨会话的
  合计拿去比上限。`created` / `available` 是全部会话的**信息**字段，端点缺失时优雅降级。
- **运行数的阶段归属** = 宿主 `subagents.listChildren(parent.id)` 的当前可见行；归属按优先级判定：
  本进程台账 → 活子代理的 `options.stageKey` → label 的 `<stage>/` 前缀（0.2.0 起阶段工具自动给
  `description` 加该前缀，所以宿主持久面上的 label 也是阶段标记）。**重启后**，只靠持久面的
  label 前缀 / live `stageKey` 也能把在跑的子代理计入正确阶段（0.4.0 起运行闸门用同一条归属路径，
  不再只看本进程台账）。
- **边界**：宿主每个 `run_code` 程序仍有 `maxParallelSubCalls`（默认 10）的并行
  子调用上限，所以设 20 也不会在一个程序里真正并行超过 10 个；`ralph` 派发的子
  代理不经过阶段工具，不受此限；既没有 `<stage>/` label 前缀也没有 `stageKey` 的旧子代理
  无法回溯归属：它们不计入任何阶段的运行数、也不进已创建清单。
- **宿主还有一层「同时存活」容量上限（dsh 0.1.6-alpha.2 起）**：宿主为每个会话（root）
  维护一个共享的 continuable 子代理名额池，大小 = `subagent.maxActiveSubagents`（**默认 8**，
  可在 Settings → 内置插件 → 子代理 调大）。它与本插件的运行闸门**互相独立**：
  - 它数的是**同时存活**的子代理（跨阶段、跨本插件，含其它来源的子代理），
    **子代理结束即释放**；
  - 名额用尽时派发会被宿主拒绝（`ACTIVATION_LIMIT_REACHED`），错误文案由插件改写成
    「宿主容量耗尽」的**瞬时**拒绝（不是阶段不可用）：主代理应等待/复用，而不是终止任务；
  - 唤醒一个已 settle 的冷子代理（`pipeline_followup`）同样需要名额；给**仍在运行**的子代理
    插话不需要，所以名额紧张时优先 steer 运行中的孩子。
  结论：`maxConcurrency: 0`（不限制）只解除了**本插件**的限制，实际并行度仍受
  `maxActiveSubagents`（默认 8）与 `run_code` 的 `maxParallelSubCalls`（默认 10）约束。
  `/dsh-code-pipeline/status` 会返回 `hostActiveSubagentLimit` 字段（宿主未注册该命名空间时不返回）。
- **预设侧的并行立场（0.3.0 起反转）+ 「新工作流派新孩子」**：`code-pipeline` 预设的
  pipeline protocol 现在是**写入串行为默认**、并行只用于「读 / 分析 / 评审」，并行 impl 必须同时满足
  「文件不重叠 + 真正独立 + 各自可机器校验 + T2 规模」（研究：并行写手各自做隐式决策，结果会冲突，
  且智能体数量增加收益递减）；运行上限拒绝是瞬时的、不是阶段失败；**同一工作流**的后续轮次一律用
  `pipeline_followup` 回到那个子代理，而**新的独立工作流**一律新派自己的子代理——运行名额不够时
  等一个释放、在后续步骤重派，绝不把新工作流塞给不相干的 child。

## 每阶段墙钟预算（超时自动中断 + 收尾报告）

- **设置项**：Settings → 代码流水线 → 每个阶段卡片的「墙钟预算（分钟）」；`0` = 不限制（默认）。
  口径是**该阶段单次派发的最长运行时间**，不做跨派发累计。
- **为什么需要**：宿主对子代理没有回合 / 步数 / 时长上限（agent-loop 的 Config 只有
  `maxParallelToolCalls`；`dsh-tool-call-timeout-policy` 只管单次工具调用），一个跑飞的 impl
  只能由模型自己决定停下，于是长时间烧 token、工作区停在半成品。
- **超时后插件做什么**（15 秒一轮巡检账本）：
  0. **软警告（预算 80%）**：`SOFT_WARN_RATIO = 0.8` 处先给**仍在运行**的子代理插一条 steer 消息（`subagents.sendMessage`）：「预算只剩 X 分钟，开始收尾：做完手上这一处、不要开新工作、只跑必要检查，结束前给一段状态报告」。它在最近一个模型步骤就能看到，多数情况会自己收敛、不必掐；只发一次，失败只记日志、不影响硬路径。子代理不在跑（idle）时**不发**——steer 对 idle 目标是「开一个新回合」。
  1. **中断**：`subagents.interrupt(childId, { kind: "ancestor", agent: parent })` —— 只结束
     **当前回合**；Activation、未领取的 inbox、已发布的下级都保留，所以之后仍可用
     `pipeline_followup` 把剩下的活儿交回**同一个**子代理（前缀还在，命中缓存）。
  2. **索取收尾报告**：等它真正停下（有界轮询 ≤ 15 秒）后，经 host-protocol 的
     `delivery: "queue"` 通道排队投递一条自包含指令，要求只输出文本：已完成（含精确文件路径）/
     每处改动的状态（完整 · 半成品）/ 未完成项 / 风险与未验证项 / 建议（续跑 · 拆分 · 回退）。
     父代理收到的完成通知因此带一份可用现状，而不是只有 `left no closing message`。
  3. **收尾回合也有宽限**（3 分钟）：再超时就第二次中断 —— 硬停，不再收尾（防止“收尾又跑飞”）。
- **对主代理的语义**：预算到点是「被中断 + 收尾」，**不是**阶段不可用 —— 三条阶段工具的
  description 已写明：收到 `was stopped before it finished` 的完成通知后，先等收尾报告通知，
  再决定「用 `pipeline_followup` 续跑同一个子代理 / 把剩余工作拆小重新派发 / 停下来报告用户」。
- **计时口径（每次派发各自独立）**：每个阶段工具调用都创建一个**新的子代理**，各自从派发时刻独立计时、互不影响（并行的多个 workstream 也是各算各的）；预算在派发时快照，改设置只影响之后的派发。
  同一个子代理被 `pipeline_followup` **续跑**时：目标**已停下**（settled / 收尾回合结束 / 已硬停）→ 重新起算墙钟，并按**当时设置**取新预算（工具回执带 `wallClockRearmed: true`）——续跑不是绕过止损线的手段：新预算用完照样会再被掐，同一阶段两次墙钟中止按「停」处置；目标**还在跑**（steer 插话）→ **不重置**，原预算照常到期。`lost` 条目（宿主缺 `interrupt` / 父代理已销毁）不复位，下一次新派发重新计时。
- **边界**：
  - 预算在**派发时**读入账本：调低不会中断已派发的子代理，只对之后的派发生效（与并发上限同语义）。
  - 中断是**协作式**的：子代理正卡在长工具调用里时要等它观察到取消信号，实际停止可能有延迟。
  - 父会话已销毁、宿主缺 `subagents.interrupt`、或授权失败时，账本标记 `lost` 并只告警，不重试。
  - 账本是**进程内**的：若 `subagent/end` 事件丢失（账本仍认为在跑），看门狗对已结束的子代理
    最多做一次 no-op 中断 + 一次收尾唤醒，随后相位推进（wrapup → 宽限 → stopped），不会反复唤醒。
  - 收尾回合会重新计入该阶段并发数（宿主 `activity = running`），并受 3 分钟宽限约束。
  - `GET /dsh-code-pipeline/status` 每阶段新增 `budgetMinutes` / `timedOut` /
    `longestRunningMs`；设置卡片显示「墙钟预算 N 分钟；最早已运行 M 分钟；K 个已超时（中断 / 收尾中）」。
    （0.2.0 起同一端点还返回 `created` / `available`，见「每阶段并发上限与并行派发」。）

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
    `delivery: 'queue' | 'steer'`，`mode` 固定 `'continuable'`——宿主 control schema 的
    **唯一合法判别符**就是 `z.literal('continuable')`（`packages/subagent/subagent/src/control.ts:23`），
    不存在 `mode: 'queue'` 这种形状；插件只探测两项（带 `delivery` 的当前形状 → 不带
    `delivery` 的旧形状），首个被接受的形状即采用。
  - 会话格式 v2 把助手流内联进 `assistant/message` / `assistant/attempt` 的
    `data.stream`（与本插件无直接关系，但会话读取类插件需注意）。
- **dsh 0.1.6-alpha.1 的包名变更（本插件已适配）**：工作流引擎 `@deepseek-ai/dsh-workflow-worker-thread`
  → **`@deepseek-ai/dsh-workflow-ptc`**（行 id 同步改为 `workflow-ptc`），实现改为在沙箱化的 PTC
  Node 进程里执行工作流（脚本仍保留 `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()`）。
  旧包名不再解析，残留一行就会让**整份预设挂载失败**：实测报 `agent-presets: preset "code-pipeline"
  failed to mount: row "workflow-worker-thread" names a plugin that cannot be resolved`，会话 resume 直接
  失败（`gateway/internal`）。上游 `ptc` 预设把它与 `tool-ralph` 一起 disabled；本预设为 `ralph`
  保留引擎（不 disabled），`tool-workflow` 仍 disabled。
- 工具注册的层由注册时 ctx 的作用域决定（实测：预设 standing 挂载不向其他
  会话泄漏）；通过 `agent.ctx` 注册落入该代理自身层，代理销毁自动回收。
- `tools.restrict` 只过滤继承层（global + 祖先），不过滤代理自身层 —— 因此
  阶段工具只注入 ROOT 代理，避免子代理的自有层被其只读过滤豁免。
- **prompt 层的评审复用依赖的宿主语义（0.1.5-rc.1 源码核对）**：`pipeline_followup` 走
  `subagents.sendMessage(sender, childId, content, { signal })` → `deliverToChild`：子代理仍
  驻留则 steer 到最近步骤（`steer`：空闲的 driver 会开一个新回合），不驻留则 `coldResume`
  按 `subagent/descriptor`（provider/model/persona/toolFilter）重建会话，且
  `activation.announced = true` 保证再次 settle 时父会话仍收到完成通知 —— 所以「续用同一个
  评审子代理」在现有工具下即可成立，无需新增任何工具或参数。
- **`subagents.prompt(request, signal)` 的 `signal` 是生成式 Remote 的尾部 transport 参数**：
  它不进入 wire args，只作为宿主方法的**最后一个形参**注入
  （`packages/typert/protocol/src/types.ts:288-292` 的 `cancellation.parameter: 'signal'`），
  因此**进程内直接调用也必须显式传入第二个实参**。漏传时宿主在
  `signal.throwIfAborted()`（`packages/subagent/subagent/src/continuation-activation.ts:489`）上
  直接 TypeError，表现成「queue 投递失败」而不是契约错误。本插件已正确传入
  （`lib/index.js` 的 `queueFollowupMessage`：`const receipt = await subagents.prompt(payload, signal);`），
  冒烟脚本也会校验该实参形状（见下节）。

## 本地验证（冒烟脚本）

仓库不带测试框架，只有一个人可读的假 ctx 冒烟脚本（零测试依赖，直接跑）：

```bash
pnpm install          # 或 npm install：只为解析 @deepseek-ai/schemastery
node test/watchdog.smoke.mjs   # 等同于 npm test
```

`test/watchdog.smoke.mjs` 用假 ctx（假 `agents` / `subagents` / `webServer` / settings 源 +
可控 `Date.now`）加载真实的 `lib/index.js`，覆盖 200 项断言：阶段工具与 `pipeline_followup`
注册、阶段工具 description 带 WALL-CLOCK BUDGET、**plan 工具带 WORKSTREAMS 契约**（impl/review
不带）、预算 0 既不中断也不软警告、**80% 处发一次软警告（steer 到该子代理、不重复发、
不在跑时不发）**、到点中断一次（目标 id + `ancestor` 授权）、收尾指令经 `delivery: "queue"`
投递、收尾宽限用尽第二次中断（硬停）、自行 settle 的子代理不被中断、宿主缺 `interrupt` /
父代理缺失时只告警、以及 `GET /dsh-code-pipeline/status` 的 `budgetMinutes` / `timedOut` /
`longestRunningMs` 字段、以及**续跑的计时口径**（运行中插话不重置、原预算按时到期、续跑重新起算并按新预算到期、settle 后续跑也重新起算）。

0.1.19 起这个脚本还**校验宿主调用的实参形状**——假 `startContinuable(spec)` 要求
`spec.signal instanceof AbortSignal` 且 `spec.request.prompt[0].type === 'text'`；假
`prompt(payload, signal)` 与假 `sendMessage(_parent, childId, content, options)` 都要求 signal 存在
（宿主对它们调用 `signal.throwIfAborted()`），形状不符即抛出与宿主同形的 `TypeError` ——
把「漏传尾部 transport 实参」从静默失败变成脚本变红。新增断言：
**`followupMode: 'queue'` 的 `pipeline_followup` 全路径**（走 `subagents.prompt`，成功返回 +
回执 `messageId` 透出 + 载荷 `mode: 'continuable'` / `delivery: 'queue'`）、
**探测表只成功调用一次**（首项即被接受，无第 2 次尝试）、
**探测表回退的尝试序列**（两种已知形状都被 `gateway/bad-request` 拒绝时，尝试序列恰为
`[continuable + delivery, continuable]`——已删除的第三项 `mode: 'queue'` 不被尝试；
断言读的是假 `prompt` 在**判定接受之前**记下的载荷流水。计数断言只能拦住更长的探测表
（把第三项加回来就会多出一次尝试），序列断言额外钉住每次尝试的**形状**——回退项必须是不带
`delivery` 的 `continuable`（只改形状、例如给第二项加 `delivery: 'steer'`，计数仍是 2，
计数断言察觉不到，形状只能靠序列断言拦住）、
**宿主改写文案时仍能回退**（`message` 不再以 `invalid payload for subagent.prompt` 开头、
但 `details.issues` 仍在 → OR 兜底照常继续探测并成功投递）。

0.2.0 起断言数 36 → **141**（新增 105 项；0.4.0 改写 A/D 后为 **197**），分四类：
**A. 运行并发闸门（0.4.0 改写，原「创建数量硬闸门」）**——`cap=1` 时第 1 个派发成功、第 2 个（第 1 个仍在跑）
被**运行上限**拦下、第 1 个结束后第 3 个**成功**（证明没有创建总量闸门）、被拒路径下宿主创建入口
`startContinuable` 不被多余调用、运行上限文案带「新工作流派新孩子 + 同一工作流用 `pipeline_followup`」出路、
`cap=0` 连派 3 个全部成功（零回归）、`Promise.all` 并发 3 个只放行 1 个（同步预留生效）、
持久面里运行中的行按 `<stage>/` 前缀 / live `stageKey` 归属计入并发数；
**B. 压缩顺序与失败路径**——`compact: true` 时 `compactNow` 一定早于投递、恰好一次压缩 + 恰好一次投递、
压缩服务走 `agentPresets.serviceFor(child, "compaction")` 且首参是目标子代理、返回「无可压区间」
不算失败（`compacted` 不置 true、投递照常）、`busy` / `summary` 失败码一律抛错且两条投递通道
都没动、`serviceFor` 返回 `undefined` 或没有 `compactNow` 的对象同样拒绝且未投递、
冷子代理报错时说明结构原因（压缩要有活着的 agent，而活着的 agent 要么正在回合中、要么刚被一次投递冷唤醒）并指向「不带 `compact` 投递 + 接受干扰，或仍有名额时另派」，不承诺重试（且根本没调用 `compactNow`）；
**C. 别名按 `seq` 稳定**——`rearmStageBudget` 改写 `entry.at` 之后 `latest` / 阶段别名仍指向
最后派发的那个；
**D. status 字段与阶段描述**——`created` / `available` 的形状与内容、三条阶段 description 里的运行上限措辞与 `compact` 指引。

## 计划的工作流切分（Workstreams）与并行 impl

并行 impl 的前提是**互不重叠的文件所有权**——同一份文件被两个实现者同时改会互相覆盖。这条契约落在两处：

- **plan 阶段（阶段 persona + 工具 description）**：计划必须以 `## Workstreams` 表结尾（`id / goal / owned files（精确路径或 glob）/ depends on / acceptance check`），
  或者一句话 `Workstreams: single workstream`（小改动 / 单文件 / 本质上串行）。硬规则：任一文件只能出现在一个
  workstream；共享串行点（`package.json`、lockfile、`index`/barrel、迁移、生成物）收进最后一个 `integration`
  workstream（依赖其余）；一个 workstream 必须值得独占一个子代理（大致 >1 个文件或 >15 分钟），不要把一件
  连贯的改动静默拆成无法各自验证的碎片；每个 workstream 自带验收检查。
- **主代理（预设 persona）**：当计划声明 ≥2 个「文件不相交且无依赖」的 workstream、**且任务属 T2**（并行写是例外而非默认）时，可以在一个程序里并行派发
  每个独立 workstream 一个 `subagent_impl`（`Promise.all`，并行度受该阶段**运行上限**约束：
  超出时剩余工作流在后续步骤各自新派、等名额释放，**不要**塞给不相干的已有子代理）；
  有依赖或共享文件的顺序执行，`integration` 最后跑。
  评审阶段按 workstream 各自捕获**路径受限 diff**（`git diff HEAD -- <该 workstream 的 owned paths>`）交给各自的
  `subagent_review`——并行期间同一工作区的 `git diff HEAD` 会混入别人的改动。切分不清楚或看起来不对时，
  **让 plan 阶段改计划**，不要自己发明切分。
- **为什么值得**：独立目标并行会缩短 wall-clock；每个子代理的会话更短、更早收敛，大任务的总 token 通常也更省
  （代价是每个子代理各付一次 system/persona/派发消息，所以小任务不切）。

## 变更记录

- **0.4.1（并发上限按会话独立：设置页不再把跨会话运行数合计后比上限）**：
  - **问题**：准入判定一直以 `parent.id` 为键（A 会话跑满不会占 B 会话名额），但设置页读的 `/dsh-code-pipeline/status` 把**所有会话**的运行数/在途数相加后返回成 `running`/`pending`，于是卡片显示成「当前运行 3 / 上限 2」——把「每个会话独立」误显示成「所有会话合计」。
  - **做法**：status 的 `running` / `pending` 改为**单会话最多**（与 `limit` 同口径），新增 `sessions` / `totalRunning` / `totalPending` 作为跨会话合计（仅诊断）；设置卡片改为「当前运行（单会话最多）N / 单会话上限 M；共 K 个会话在跑（合计 T）」。`created` / `available` 标注为「全部会话」。
  - **验证**：冒烟 P7（两个会话各 `limit=1` 时都能派发、各自到自己的 limit 才被拒；status 的 `running < totalRunning` 且 `sessions ≥ 2`）。断言数 **197 → 200**、0 failure。
  - 版本 0.4.0 → 0.4.1。
- **0.4.0（新工作流一律新派：移除「已创建总量」闸门；plan 不再需要迁就并发预算）**：
  - **根因**：创建总量闸门把「复用优先」变成强制，于是**新工作流**只能被塞进已经做过别的 workstream 的冷子代理——无法压缩，每步重发整段历史（实测 63 步 / 9.7M tokens，每步约 152k），还得靠一句「忽略之前的内容」在 prompt 里硬压，既删不掉上下文也不可靠。0.3.9 用 `plan` 侧的 `parallelismBudget` 把切分压到预算内，但那是治标：它让 plan 少切工作流，而不是让新工作流能有自己的子代理。
  - **做法（移除创建闸门）**：三个阶段工具的 per-(父会话 × 阶段)「已创建总量」上限与 `stageCreationCapReached` / `stageCreationCapUnverifiable` / 观测高水位（`createdObservation` / `collectStageChildren` / `knownStageRows` / `mergeStageRows` / `ledgerStageChildren`）一并删除；`maxConcurrency` 现在只表示**同时运行**上限（默认 0 = 不限制）。运行闸门保留，且**持久面归属改用 `stageOfChildRow`（label 前缀 / 活 agent stageKey）**，所以重启后持久面的运行行也能计入并发数（旧实现只认本进程台账，重启即失明）。
  - **做法（新工作流派新孩子）**：三条阶段 description、`stageConcurrencyReached` 文案、预设的 reuse / parallel-dispatch 段落全部改写——同一 workstream 的后续轮次继续 `pipeline_followup`；**新的独立工作流一律新派自己的子代理**；运行上限拦下时等名额释放后在后续步骤重派，绝不塞给不相干的 child。`pipeline_followup` 的 `compact: true` 边界（冷 child 压不了）与必填 `files` 保持不变。
  - **做法（plan 不再被告知预算）**：删除 `stageParallelBudget` / `renderParallelismBudget` / `parallelismBudget` 块与 plan persona 的 `BUDGET FIRST`——plan 只需切出真正需要的工作流，并发由运行时上限制约。
  - **验证**：冒烟 A1/A2/A3（运行上限=1：第 1 个成功、第 2 个被运行闸门拒、第 1 个结束后第 3 个成功=没有创建总量闸门）、A5（`Promise.all` 只放行 1 个）、A6/P1/P2（持久面运行行按 label / stageKey 归属计入并发计数）、P3（枚举失败退回账本、不卡死不放行）、M1/M2（plan/impl 派发都不带 `parallelismBudget`）。断言数 **217 → 197**、0 failure。
  - 版本 0.3.9 → 0.4.0。**预设改动需要手动同步**（自动安装不覆盖已有预设）。
- **0.3.9（让 plan 一开始就知道实现者的创建预算，切出可执行的串行计划）**：
  - **根因**：0.3.8 记录的 63 步那一轮，成因是 plan 切了 **5 个工作流**（A–E）而 impl 创建上限是 **2**——后 3 个只能被塞进已经做过别的 workstream 的冷 child（无法压缩），正是「跨工作流复用」最贵的形态。上个版本只在**撞上限之后**补救（写明代价 + 优先级），这个版本把预算**提前告诉规划者**。
  - **做法**：`subagent_plan` 的派发消息新增 **`parallelismBudget`** 块（`stageParallelBudget` 计算，与创建上限准入同源——本进程台账 ∪ 最近一次成功观测的高水位，不做 I/O）：写明该 impl 上限 / 已创建 / 剩余可创建，并**要求** `## Workstreams` 表最多只有「剩余」个工作流；超出时必须**合并**并排出显式**串行顺序**（谁先跑、谁等谁、后者继承什么），剩余 = 1 时要求排成单一串行序列，剩余 = 0 时要求说明只能追加到已有实现者。上限为 0（不限制）时改为提示宿主的存活上限（默认 8）。该块**只给 plan**（impl/review 派发不含）。plan persona 的 `BUDGET FIRST` 与预设的 Workstreams 段落同步。
  - **验证**：冒烟 M1（上限 2 → 派发带 `parallelismBudget` 且要求 ≤ 2 个工作流）、M2（上限 1 → 要求单一串行序列）、M3（上限 0 → 说明无插件侧上限并提示宿主上限）、M4（预算块只给 plan）。断言数 **213 → 217**、0 failure。
  - 版本 0.3.8 → 0.3.9。**预设改动需要手动同步**（自动安装不覆盖已有预设）。
- **0.3.8（复用路径丢掉了 `files` 契约；创建上限把「跨工作流复用」变成最贵的一轮；impl 批量纪律）**：
  - **实测证据**（`zy_platform_frontend`：impl A `a62f32bb`、impl B `ec281c36`、review `d38977c7`、主会话 `session-5556e686`）：主会话第 5 轮想**并行派发 impl B + impl C**，`subagent_impl` 被创建上限拒绝（limit 2，已创建 A/B）→ 按协议复用 A 去干 **Workstream C**（另一个工作流、另一批文件），于是 A 的第 2 轮 **63 步 / 9.7M tokens**（比第一轮 41 步还长），每步重发约 **152k** 累积上下文；review 侧同因：`stage concurrency limit (limit 1)` 与 `stage CREATION limit (limit 1)` 让第二个 reviewer 从未被创建。另外两处形状问题：① 复用路径只发一段自由文本、**没有 `files`**，A 的第 2 轮开头 **7 步 / 15 次 read** 全在重新发现 core-settings 的文件；② impl **41–60% 的步只发一个工具调用**（plan 17% / review 0–20%），DSH 自带的 `repeat-tool-reminder` 在其中触发了 `read × 3` / `read × 5`。
  - **做法（复用路径接回 `files`）**：`pipeline_followup` 新增**必填** `files`，与三个阶段工具共用 `renderFilesBlock`——真清单渲染成「先用一个 `run_code` 程序读完」，`-` 显式声明没有清单；省略 → 拒绝并点名 `files`。
  - **做法（把跨工作流代价写进拒绝文案）**：创建/并发上限错误新增 `CROSS-WORKSTREAM REUSE HAS A PRICE` 段——冷 child 无法压缩、每步重发多少、实测 63 步 ≈ 10M 额外 tokens，并给出优先级：(a) 优先 steer 仍在 RUNNING 的 child（不占新名额）→ (b) 永远带 `files` → (c) 计划的工作流数超过上限就「合并成一个 child 串行跑」而不是硬塞 → (d) 接受代价。预设的复用策略同步改写：`compact` 不再被列为一条出路，并新增「跨工作流复用有代价」段落。
  - **做法（impl persona 的批量纪律）**：impl persona 新增 `BATCH THE LOOP`——探针/查配置/读报错是**一个程序**而不是一步；注释与 JSDoc 微调必须与所属编辑**同一个程序**；需要精确原文时**同程序内先读后改**；输入没变的命令不要重跑。
  - **验证**：冒烟 H9×3（followup 的 `files` 渲染 / impl persona 带 `BATCH THE LOOP` / 缺 `files` 被拒）、A2b（创建上限文案含跨工作流代价）。断言数 **209 → 213**、0 failure。
  - 版本 0.3.7 → 0.3.8。**预设改动需要手动同步**（自动安装不覆盖已有预设）。
- **0.3.7（plan 一开始的成片报错与「提醒洪水」：失败的 read 被记成「读过」+ 一次程序刷 23 条提醒）**：
  - **实测证据**（`zy_platform_frontend`，plan 子代理 `9f55ce95`，13 步 / 129 次嵌套调用）：第 2 步用一个 `run_code` 程序读 25 个文件，**25 次全部失败** `ToolCallError: limit must be less than or equal to 2000`（它按 persona 的「read whole files」传了 `limit: 2500`）；第 3 步用 `limit: 2000` 重读 23 个，而读卫生守卫把这 23 次**重试**判成了「跨步骤重读」，于是一步之内注入 **23 条 `[read-hygiene]` user 消息**（约 9KB；全会话累计 27 条 / 11KB，全部是假警报）。第 10–11 步另有 6 次 `binding arguments must be lossless JSON`：子代理把 `include: undefined` 传给了 `tools.grep`，PTC 绑定的 lossless-JSON 校验在派发前就否决了整个参数对象。
  - **做法（插件侧，两个 bug）**：① `tools/post-execute` 的 `result.isError === true` 时**既不记历史也不提醒**——超限 / 文件不存在 / 被策略拒绝的调用什么都没进上下文，把它们记成「已经读过」必然让下一次重试变成假警报；② 同一个 `run_code` 程序里触发的提醒**攒到程序结束（外层调用）再合成一条**汇总，不再逐个文件挂 user 消息。
  - **做法（提示侧）**：三段 persona、`files` 清单块与预设 `### Step economy` 都写明两个坑——`tools.read` 的 `limit` 上限就是默认值 2000，整文件读法是**省略 `limit`**（传更大值会让整批调用全失败）；可选参数要**省略键**，不要传 `undefined` 值（`{ include: undefined }` 在派发前就被拒）。
  - **验证**：冒烟 I8（失败的 read 不计入历史）、I9×2（一次程序重读 23 个文件 → 只发一条汇总，最多列 8 个路径）、I10（主会话 root 级 read 仍当场发单文件提醒）、J4（`files` 渲染带上两个坑的说明）。断言数 **204 → 209**、0 failure。
  - 版本 0.3.6 → 0.3.7。**预设改动需要手动同步**（自动安装不覆盖已有预设）。
- **0.3.6（`files` 从「可选、靠协议」升级为必填派发契约）**：
  - **问题**：0.3.5 给三个阶段加了 `files` 并写了协议，但它是**可选的**——主代理不填，插件既不警告也不拒绝，子代理就退回「从零重新发现」，正是 0.3.5 记录的那个 20 步 / 48 文件模式。你对该机制的预期是「主会话每次都会给子代理发一份文件清单」，而可选字段给不了这个保证。
  - **做法**：`files` 成为**必填**。缺省（undefined / 空串）时派发直接被拒，错误信息点名 `files` 并给出两种合法写法：① 一行一个路径的候选清单；② 单个 `-`，显式声明「没有候选清单」。后一种让子代理收到一段「自己做侦察（glob/grep），但仍要在一个程序里把候选读完」的指令——它保证主代理**总是有意识地做出选择**，而不是静默省略。三个工具的 CONTRACT description 改为 `files (REQUIRED …)`，persona 改为「dispatch 总是带 `files`；为 `-` 时自己做侦察」，预设 `### Step economy` 对应条目同步写明「缺省会被拒绝」。
  - **验证**：冒烟 K1（缺 `files` → 拒绝且错误点名 files）、K2（`files: "-"` → 放行且子代理收到 NO candidate list 指令）；J1 改为断言 schema 的 `parameters.properties` 真的含 `files`。断言数 **202 → 204**、0 failure。
  - 版本 0.3.5 → 0.3.6。**预设改动需要手动同步**（自动安装不覆盖已有预设）。
- **0.3.5（把「该读哪些文件」变成派发契约的 `files` 字段：主会话已侦察、plan 仍从零重读）**：
  - **实测证据**（`zy_platform_frontend`，主会话 `session-92a50bf5` + plan 子代理 `6358a69f`）：主会话用 15 步读了 **33 个文件**再派发 plan；派发消息（8189 字符）里其实有一整节 `## 仓库现状（已替你核实，可直接采信）`，按文件+行号列出 `plugin-api/src/context.ts`、`host-services.ts`、`host-context.ts`、`config-service.ts`、`plugin-host.ts`、`host-info.ts`、`main.ts`、`App.vue`、`stores/app.ts`、`ipc-contract.ts`、`preload/index.ts`、`main/ipc.ts`、`main/window.ts`、`core-settings/*`、测试与文档……**清单是发过去了**；但 plan 仍然用了 **20 步 / 56 次 read / 48 个文件**，其中约 30 个是主会话刚读过的同一批。
  - **三个原因**：① 清单是**散文**（路径嵌在中文叙述里），子代理要先「再解析」一遍；② 派发明写「仍建议你按需打开原文件确认细节」，persona 又写「verify by reading the actual code」——两句都在推它逐个开文件；③ 没有任何指令说「先一次性读完这份清单」。0.3.4 的读卫生提醒在这一轮**确实触发了**，20 步也没有降下来：所以问题在派发契约，不在提醒强度。
  - **做法**：`subagent_plan` / `subagent_impl` / `subagent_review` 新增 `files` 入参（一行一个路径）。派发时它渲染成一个专门块并附硬指令——「这是 orchestrator 已核实的候选集；在你规划/审查/编辑之前，先用**一个** `run_code` 程序把下面每个路径读完（并行 `tools.read`，整文件）；不要再花步数重新推导文件清单」。plan/impl/review persona 与阶段工具 description 同步。
  - **主代理协议**：预设 `### Step economy` 新增一条——派发阶段时把**你已经打开或列入候选的每个路径**写进它的 `files` 字段；只写在散文 `context` 里会让子代理一步步重新发现。
  - **验证**：冒烟 J1–J3（schema 暴露 `files`、带 `files` 的派发成功、派发文本含「ONE run_code program」+ 原样路径），断言数 **199 → 202**、0 failure。
  - 版本 0.3.4 → 0.3.5。**预设改动需要手动同步**（自动安装不覆盖已有预设）。
- **0.3.4（读卫生提醒的判定重写：0.3.3 的实现在真实会话里一次都没开火）**：
  - **实测证据**：`zy_platform_frontend` 工作区的 plan 阶段子代理（session `2efd29ae-b1bc-47a7-8703-1957f1fd0381`，10:14–10:18）跑了 **33 步 / 32 个 `run_code` 程序 / 61 次嵌套 read / 46 个文件**，累计 **2,575,535 tokens**（input 133,871 + cacheRead 2,399,488 + output 42,176），而 0.3.3 的 read-hygiene 提醒一次都没出现——尽管 `settings-plugin.spec.ts` 等文件确实被重复读。
  - **为什么没开火（两处判定太窄）**：① `lastReads` 每个 agent 只存**一条**「上一次读」，而真实会话里同一文件的多次读几乎总被其它文件的读隔开（例如 `host-services.ts` 读 `1+3000`、中间隔了 5 个文件、再读 `1+2000`）——单槽位在第二次就被重置；② 要求两个窗口「重叠或首尾相接」，于是 `loader.spec.ts` 的 `100+60 → 900+60 → 1100+60` 这种**带间隔的分页**也全部逃掉。
  - **新判定**：按 **agent → 文件 → 读取历史**记（不再单槽位）；只看**不同 `rootCallId`**（同一次 `run_code` 程序内的多次读是我们要鼓励的批量化，豁免）；命中任一即提醒，且每个文件只提醒一次：**窗口重叠**（重读已有行）或**两边都是小窗口**（`limit < 2000`，一步读一块）。文件超过工具上限时的被迫分块（满窗、不重叠）仍然豁免。
  - **验证**：把这次会话真实的 61 次读按原顺序灌进新判定 → **11 次提醒**，正好覆盖 6 个「整文件重读两遍」的文件（`host-services.ts` / `ipc-contract.ts` / `ipc.ts` / `index.ts` / `index.d.ts` / `bridge.ts`）与分页读的文件（`loader.spec.ts` / `plugin-model.md` / `plugin-host.spec.ts` / `settings-plugin.spec.ts` / spill 文件）。冒烟 I1–I7 覆盖：同一程序内重复读不提醒、跨步骤且被隔开也提醒、只提醒一次、被迫分块豁免、整文件重读提醒、非 read 不触发；断言数 **197 → 199**、0 failure。
  - 顺带确认：这条 hook 在真实进程里是生效的——0.3.3 的提醒在本会话里被真实触发过一次（读 `lib/index.js` 时），所以问题出在判定，不在通道。
  - 版本 0.3.3 → 0.3.4。
- **0.3.3（读经济学：批量读 + 增量读提醒；只改提示词、预设文本与一条 plugin 提醒，无派发路径改动）**：
  - **问题**：宿主 agent loop 没有步数上限（`packages/core/agent-loop/src/agent.ts` 的 `turn()` 是没有计数器的 `while (true)`），而每多走一步都要重发整个上下文——于是「读一点、再读一点」比「一次读完」贵得多，上下文最后可能只有 ~200k 而累计 token 到 5M。此前协议只说了 "bundling ... into as few programs as practical"，那是能力提示，不是成本说明。
  - **把账写进 persona**：plan / impl / review 三个 persona 各加一段 READ ECONOMICS——合并一步省下≈整个上下文；多读 `W` 只随上下文重发一次、代价≈`W × 剩余步数`；侦察一次（glob/grep）→ 一个程序里 `Promise.all` 读完所有需要的文件/区间 → 不重复读；也不要整仓乱读。impl 额外要求「第一次编辑前，把本 workstream `owned files` 全部一次读完」。
  - **把账写进主代理协议**：预设新增 `### Step economy (read once, read wide)` 小节（同一公式 + 四条纪律，含「把阶段要读的文件放进它派发的 `context`/`plan`，别让它自己去重新发现」）。
  - **机制侧兜底**：新增 `tools/post-execute` 监听（`{ global: true }`），按 agent 记录上一次 `read` 的窗口；同一文件被切成小窗口续读（重叠/首尾相接）时挂一条 `{kind:'plugin'}` 来源的 read-hygiene 提醒。只在两个窗口都小于 read 工具上限（2000 行）时开火——文件本身超过上限时分块是被迫的；同一文件只提醒一次。只提醒不否决，观察与富化全程 try/catch（宿主里 post-execute 监听器抛错会被记成 `isError`）。
  - **验证**：决策表单测（分块续读 / 同区间重读 → 提醒；有间隔 / 差异文件 / 到上限 / 非 read / 无 agent → 不提醒；第三次不重复）＋冒烟新增 I1–I5。断言数 **192 → 197**、0 failure。写在 `run_code` 里的分块读同样会被捕获：PTC 的嵌套调用继承 `exec.agent`（`packages/core/tools/src/ptc.ts:545`）并经 `deferContext` 把 `additionalContexts` 传回外层程序结果。
  - 版本 0.3.2 → 0.3.3。**预设改动需要手动同步**（插件自动安装不覆盖已有预设文件）。
- **0.3.2（紧急修复：0.3.1 的 pipeline_submit 让 plan/review 阶段全部派发失败）**：
  - **事故**：0.3.1 给只读阶段（plan / review）的 `tools.restrict` 白名单加了插件私有工具名 `pipeline_submit`。宿主的 `tools.restrict()` **只接受全局注册的工具名**——它校验 `view(scope).restrictableNames`（`packages/core/tools/src/index.ts:1094-1098`），而这个集合只由**全局层 + 祖先作用域层**构成（`index.ts:1167-1189`），**作用域自己注册的工具不在其中**。结果 `subagent_plan` / `subagent_review` 的派发在子代理组合阶段直接抛 `tools.restrict() names unknown global tool` 而全部失败，插件把它归类为阶段不可用，主代理按协议停止整个任务。
  - **修法**：回退为**单通道**——阶段回执只走「最终回复里的一个 json 围栏」，插件在 `subagent/end` 解析并做语义校验。删除了 `pipeline_submit` 工具、它的子代理注入、以及只读白名单里的那个名字；`READ_ONLY_TOOLS` 旁边写明了「这里的名字必须全部是宿主全局工具」的原因与反例。
  - **校验没有丢**：`validateEnvelope` 仍在每次解析后执行，结果写进回执的 `validationProblems`（并在日志里 warn）。它不是阻塞式的：`pipeline_result` 把它交给编排者，由编排者决定不按该回执行动——代价是子代理要等到下一轮才知道自己被拒，换来的是「不存在一整类派发失败」。协议同步说明：拿到 `validationProblems` 时不得照单执行。
  - 额外硬化：解析只认带 `kind` 的对象——最终回复里出现无关的 json 代码示例时，报 `parsed:false`（reason = no stage envelope）而不是「提交了非法回执」。
  - **回归测试**：H3 现在直接读插件源码断言 `READ_ONLY_TOOLS` 里不含 `pipeline_submit` / `subagent_` 这类私有名（点名这次事故）；H4–H7 覆盖解析、三条语义拒绝、非 envelope 的 json、新一轮激活作废旧回执。断言数 **196 → 192**（删掉围绕已移除工具的 4 条，新增 5 条），0 failure。
  - 版本 0.3.1 → 0.3.2。装回本版后 plan / review 恢复正常。
- **0.3.1（结构化 I/O：pipeline_submit + pipeline_result + 结构化投递 + 轮次遥测）**：
  - **问题**：阶段子代理的结论全是自由文本——review 的 verdict 与 issue 列表、plan 的 Workstreams 表、impl 的变更摘要，都要主代理「读文本再抄一遍」。0.3.0 的裁决白名单因此只能靠模型逐条判断，而 reviewer 的硬约束（没有触发场景不得 blocking、docs/style 不得 blocking）也还只是 persona 里的劝告。
  - **回执结构化**：三个阶段各有 envelope（`plan` / `impl` / `review`，见 `ENVELOPE_SCHEMAS`），随每次派发在 `requiredOutput` 里下发（子代理不必猜形状）。两条通道写进同一台账：① 插件给**阶段子代理**注入窄工具 `pipeline_submit`（靠 `agent.options.stageKey` 识别，不靠台账——`dispatched` 要等 `startContinuable` 返回后才写入），在**调用点**做 schema + 语义校验，不合格当场打回、子代理当轮即可修正；② 兜底：`subagent/end` 从最终回复的最后一个 `json` 围栏解析。解析失败**不阻塞**，`pipeline_result` 如实返回 `{parsed:false, reason}`。
  - **reviewer 硬约束变成机制**：`validateEnvelope` 在提交点拒绝「blocking 却没有 failureScenario」「docs/style 标 blocking」「不在改动行上标 blocking」「verdict 与 findings 不一致」的 envelope——0.3.0 只让 reviewer 承诺，这一版让它做不到。
  - **`pipeline_result({child})`**：主代理在程序里把回执当数据用（`issues[]` 带 severity / blocking / confidence / onChangedLines），裁决白名单因此是 `.filter()` 而不是「读文本判断」。
  - **结构化投递**：`pipeline_followup` 新增可选 `issues[]` / `changeSet`，插件负责渲染成子代理可读文本；`message` 从必填改为「与 `issues` 至少其一」。主代理不再手抄 issue 列表，也就不会在抄写时丢字段或加戏。
  - **轮次与 blocking 遥测**：按父会话记录每轮 review 的 verdict 与 blocking 数，`/dsh-code-pipeline/status` 新增 `reviews: {rounds, blockingTrend, lastVerdict}`——「第几轮了、blocking 有没有在下降」正是收敛判据要看的量。`subagent/start` 会作废上一轮回执，避免复用被唤醒时 `pipeline_result` 返回陈旧 verdict。
  - **协议同步**：triage 小节改为「在代码里套白名单」（`pipeline_result` + `pipeline_followup({issues})`）；plan / impl persona 与阶段工具 description 补上各自的 envelope。
  - **测试**：新增 H 块 18 条断言（提交工具注入与 schema、五条语义拒绝路径、兜底解析与解析失败、`subagent/start` 作废、issues 渲染与并存）。断言数 **178 → 196**、0 failure；在真实 DSH 组合里启动 0 错误，status 已返回 `reviews`。
  - 本版为**阶段 2**（结构化 I/O）；阶段 3（档位闸门 `pipeline_tier` 与设置页）未做。
- **0.3.0（协议分档重写 T0/T1/T2 + 评审分级裁决 + 循环收敛；只改协议文本，无插件逻辑改动）**：
  - **问题**：① 分档表虽然存在（Trivial/Small/Documentation-only/Standard/Large），但被三条更强的 ALL-CAPS 不变式压过——`every planned change (even a trivial one) goes through the impl stage`、`Never fix review issues yourself`，加上 Small 的「用户观察不到行为变化」定义极窄，导致两文件的行为修复也走完整 plan→gate→impl→review；而且**没有 T1 档**（主会话自己规划 + impl→review），中间形态掉进缝里。② reviewer 只被要求「文件 + 问题 + 建议修法」，`Never approve with unresolved material defects` 里的 material 无法执行；编排协议又禁止主会话做任何判断，review 的 issue 原样全量交给 impl——于是只要 reviewer 每轮再提一条就必然跑满 3 轮、永远看不到 APPROVED；而「最多 3 轮」本身也没有任何机制执行（插件不记轮次）。
  - **分档改为 T0/T1/T2**：T0（≲60 行 / ≤2 文件 / 文档注释 / 机械操作 / 单点无设计决策）主会话直接做、不起子代理；T1（3–8 文件，或 ~60–500 行，单子系统且设计已由需求定死）由主会话自己写计划放进 `plan` 字段，只派 impl→review；T2 才走完整流程。新增**惰性升级**（从 T0 开始，命中触发条件才升级；升级单向且必须 `todo_write` 留痕）与**允许降级**；并明确「T0 不等于跳过验证」（改完自己跑测试/构建）。三条压制分档的不变式同步改写。
  - **并行写降级为例外**：研究（Cognition「Don't Build Multi-Agents」与其 2026 复盘、Anthropic 多智能体研究、Adversarial Review ICML 2026）一致显示并行写手各自做隐式决策、结果会冲突，且智能体数量增加收益递减。协议改为「并行只用于读 / 分析 / 评审；并行 impl 必须同时满足文件不重叠 + 真正独立 + 各自可机器校验 + T2 规模」。
  - **评审分级 + 主会话裁决**：reviewer 必须输出结构化 `review` envelope（`verdict` / `severityCounts` / `blockingCount` / `issues[]` / `outOfScope[]`），每条 issue 带 `severity / blocking / category / confidence / onChangedLines / failureScenario / evidence / suggestedFix / objectiveCheck`；8 条硬约束里最关键的是**写不出 `failureScenario` 就不得 blocking**、**`docs` / `style` 永不 blocking**、**不在改动行上永不 blocking**、**verdict 由 findings 机械决定**（取代 material defects 这种主观措辞）。主代理只做**白名单过滤**（`blocking` + `critical/high` + `confidence ≥ 0.8` + `onChangedLines`），被过滤的必须带 `rejectionReason` 留痕并在报告里列出；**过滤后为空即收尾**，不再等 APPROVED。
  - **循环收敛**：3 轮从「目标」变成「保险丝」；新增**封闭复验**（「#1..#n 是否已解决？不要开新 finding」，取代开放式「再评审一遍」）与**无进展即停**（blocking 数未严格下降 / 同一 finding 修后重开 / delta 为空 → 交用户决策）；客观信号（测试、类型检查）优先于 LLM 意见。
  - **补上 persona 缺口**：dsh 0.1.6-alpha.2 的宿主「同时存活子代理」容量上限（`subagent.maxActiveSubagents`，默认 8）此前只写在工具 description 里，这次写进协议，并明确它是**瞬时容量拒绝，不是阶段不可用**。
  - **测试**：`test/watchdog.smoke.mjs` 的 E 块把 E4/E5 换成新锚点，新增 E11–E14（分档 / 并行 / 裁决 / 反吹毛求疵 / 收敛 / 宿主容量）。断言数 **174 → 178**、0 failure；修改后的预设在真实 DSH 组合里挂载成功、0 错误。
  - 本版**只改协议文本**（`preset/code-pipeline/agent.cordis.yml`、`lib/index.js` 的 persona 与工具 description、README），**没有动任何插件逻辑**；结构化 I/O（`pipeline_submit` / `pipeline_result`）留给后续阶段。
- **0.2.5（预设简介收窄到 20 字以内）**：
  - **问题**：`preset/code-pipeline/preset.yml` 的 `description` 有 600+ 字——模式、三个工具、组合方式、Workstreams、墙钟、复用、容量上限全塞进同一句，Agent preset 选择器里糊成一大段，扫一眼读不完。
  - **做法**：压到 **18 字** —— `规划→实现→评审的三阶段子代理流水线`。细节本来就在 README（安装、并发上限、墙钟预算、`pipeline_followup`、压缩触发比例）与 Settings → 代码流水线 里；选择器只需要回答「这是什么」。
  - 只动 `preset/code-pipeline/preset.yml`。**已安装的预设不会被插件覆盖**（自动安装只在目标缺失时发生），要生效需手动同步，见「预设文件（preset/）」。
- **0.2.4（宿主「同时存活子代理」容量拒绝改判为瞬时策略拒绝）**：
  - **问题**：dsh 0.1.6-alpha.2 新增 `subagent.maxActiveSubagents`（每个 root 默认 **8** 个同时存活的 continuable 子代理，提交 `16620a3a70` / `a69cfb3636`，alpha.1 无此上限）。名额用尽时 `startContinuable` 抛 `ACTIVATION_LIMIT_REACHED`，冷启动一个已 settle 的子代理走 prompt 通道被映射成 `subagent/delivery-unavailable`。插件此前把两者一律包成 `stageUnavailable()` 并附 `UNAVAILABLE_GUIDANCE`（"STOP and report to the user … do NOT retry"），于是第 9 个同时在跑的子代理会让主代理**终止整个任务**——而实际只需等一个子代理结束、或复用已有子代理。
  - **做法**：新增 `isHostCapacityRejection()` 沿 `cause` 链识别上述两种错误码与宿主文案；阶段派发与 `pipeline_followup` 冷启动分流到 `stageHostCapacityReached()` / `followupHostCapacityReached()`，文案明确 "NOT stage unavailability" 并给出「复用 / 等名额释放后重试 / 主会话自己做」三条出路。非容量类错误仍走原 `stageUnavailable` / `delivery failed` 路径。
  - `maxConcurrency` 设置项描述与 `pipeline_followup` 工具描述不再宣称「0 = 不限制」与「复用永远可用」；`/dsh-code-pipeline/status` 新增 `hostActiveSubagentLimit` 字段（读不到时不返回）；README 新增「宿主还有一层同时存活容量上限」小节，并把四类策略拒绝列入「不算阶段不可用」例外清单。
  - **测试**：新增 **A8**（派发容量拒绝 + 非容量对照）与 **A9**（冷启动容量拒绝 + 非容量对照）共 7 项。断言数 **167 → 174**、0 failure。
- **0.2.3（补一条协议规则 + 一条断言：评审第 2 轮起「只送增量」必须先有「每轮快照」才可执行）**：
  - **问题（本插件自己的 0.2.2 评审循环暴露的）**：0.2.2 已把「评审后续轮只送自上次裁决以来发生变化的 hunk」写进协议，但那条规定**不可执行**——没有任何东西保留上一轮的文件状态，能拿到的只有 `git diff HEAD` 的累积 patch，于是三轮评审都只能收到累积 patch，体量单调增长 **41,845 → 48,795 → 56,527 个字符**，同一批 hunk 被重复送进同一个评审子代理的上下文。
  - **做法**：在预设的「Repeat review rounds reuse the SAME reviewer」小节里、导语与编号列表之间新增一段**快照协议**：每轮 impl settle 之后，把所有改动过的路径按轮次拷进平台临时根下的目录 —— `$TMPDIR/dsh-pipeline-snap/<task>/round<N>/<原始相对路径>` —— 下一轮的增量用 `diff -ruN <round1>/ <round2>/`（或 `git diff --no-index`）生成，并限定在该任务的路径范围内；**快照绝不写进工作区**。同一条规则也追加进 Build flow 第 4 步（Review）末尾：评审前捕获变更集时顺手快照，下一轮才能送增量而不是累积 patch。
  - **测试**：`test/watchdog.smoke.mjs` 的 E 块新增 **E10**（persona 同时含 `dsh-pipeline-snap` 与 `Never write the snapshots inside the workspace` 两个锚点）。断言数 **167**、0 failure（本版新增 **1** 项）。
- **0.2.2（压缩触发线变成运行时设置 `压缩触发比例` + 三处流水线策略 + 对账器 / 测试 / 文档）**：
  - **改动面**：`preset/code-pipeline/agent.cordis.yml`（压缩行的出厂默认 + 三处策略文本）、`lib/index.js`（新设置项 `compactionThresholdRatio` 与把它写进已安装组合的对账器）、`lib/client.js`（设置卡片新增「压缩触发比例」输入框）、`test/watchdog.smoke.mjs`、本 README；`preset/code-pipeline/preset.yml` 不动。
  - **问题 1（触发线按模型窗口定，等于永不触发）**：`compaction` 组里的 `compaction-basic` 行原先**没有 `config:`**，于是吃宿主默认 `thresholdRatio: 0.8`——对 100 万 token 的窗口就是 **80 万**才触发。全库审计（`~/.dsh/deepseek-quota/quota.db`，446 会话 / 28,775 请求，每个样本按它自己的峰谷价计价）先看这批历史数据的**构成**：
    ```
    类别                        会话   请求     成本(CNY)  占比   平均上下文/步  峰值中位数  峰值最大
    单次派发（turn == 1）        250   9,647     103.91    26.8%   82,732        98,472      362,792
    复用的子代理（turn >= 2）    196  19,128     283.15    73.2%  200,993       200,863      792,469
    ```
    再按触发线统计「超出该线的上下文重发成本」——`可省` 一列是**下界，不是期望值**（理由见下）：
    ```
    触发线   超过的会话   超过的请求   超出 token   可省(下界)   占总额
    200k     114 / 446    8,035        1.180 B      CNY 30.89    8.0%
    300k      52 / 446    4,309        0.585 B      CNY 15.83    4.1%
    400k      31 / 446    2,287        0.264 B      CNY  7.47    1.9%
    500k      18 / 446    1,012        0.105 B      CNY  3.14    0.8%
    600k      10 / 446      453        0.034 B      CNY  1.06    0.3%
    800k       0 / 446        0            0        CNY  0.00    0.0%   ← 该线附近被右删失（见下）
    ```
    这批账单是**混合口径**：446 个会话里 423 个是阶段子代理会话，其中 **250 个（56%）只被派发过一次、从未续用**——这一类**按构造就不可能**触到高阈值（峰值最大 362,792，**没有一个**超过 500k，对「>500k 的超出量」贡献 **0** token）。**长上下文是「复用」造出来的**：>500k 的超出量（104.8M token，CNY 3.14）**100%** 来自那 196 个被复用的会话；1,369 次 follow-up 轮次里，子代理在该轮第一次请求时**中位已持有 278,084 token**（p90 588,338，最大 790,266），908 轮（66%）起点已超 200k、228 轮（17%）已超 500k——而新派一个子代理只会把它从约 **9k** 的冷启动 prompt 重新开始。**控制会话长度**（按请求数分桶）后，同样长度下被复用的会话每步平均上下文仍是单次派发会话的 **1.24×–1.67×**。
    因此 `可省` 一列是**下界**：本插件现在强制「复用优先」，会把构成进一步推向被复用的那一类——**更长上下文、更频繁触发**；而历史分布本身又在当时生效的触发线附近被**右删失**（见下），所以越靠近旧触发线，超额量只会越被低估。这些数字按**步数不变**的毛额口径算，也没有扣除每次压缩自身的摘要请求与压缩后前缀缓存重建的代价——只给口径，不给预测。分类器另有一条限制：`turn == 1` **不证明**一个会话从未被复用——默认的 `steer` 投递把消息插进运行中子代理的最近步骤、**不新开回合**，所以这 250 个里可能有被中途 steer 的；这不影响上面控制长度后的结论。触发线为什么该存在（**重发经济学**）：cache-hit 重读 ≈ ¥0.0293/M、输出 ≈ ¥5.29/M（1 个输出 token ≈ 181 个缓存命中 token），重发成本随上下文线性增长；早先据此算出的盈亏平衡点 ≈ 26 万 token 只是「为什么要有这个旋钮」的背景，**不是任何取值的依据**。
    **测量限制（右删失）**：历史上下文分布在**当时生效的触发线**处被截断——一个本该越过它的会话会被折叠，而不是继续增长。这正是「446 个会话里 0 个超过 80 万」看起来这么干净的原因，也意味着**越靠近旧触发线，超额量与 `可省` 越被低估**。同一批证据还纠正了一个说法：旧默认 `0.8` **其实触发过**——本安装历史里自动压缩至少在 5 个回合真的跑过（某会话的 134/177/221/274 回合、另一会话的 66 回合），另有 11 次手动 `/compact`。
  - **做法 1（把触发线做成设置，而不是写死的 0.2）**：`@deepseek-ai/dsh-compaction-basic` **没有 settings 命名空间**（`static inject = ['llm','tokenMeter','sessions']`），它的 `thresholdRatio` 只能来自挂载它的组合；所以「设置页可调」的唯一落法是**本插件把设置值写进已安装的预设组合**（`$DSH_HOME/.agent-presets/<preset>/agent.cordis.yml`）：
    - 新设置 **`压缩触发比例`**（`compactionThresholdRatio`，数字，范围 **0.05–0.8**，默认 **0.5**）。写进组合的是一对**比例**：`thresholdRatio: <设置值>` 与 `retainRatio: <设置值 ÷ 5>`（保留量恒为阈值的 1/5，四舍五入到 4 位小数），**绝不写 `retainTokens`**（宿主拒绝两种保留形式并存）。
    - **为什么写比例而不是 token 数**：`thresholdRatio` 与 `retainRatio` 都是**路由后模型窗口**的比例，所以这一对值与窗口无关——插件不需要知道某个阶段被路由到哪个模型、窗口多大（那是按阶段、按模型变化的）。宿主强制「保留必须严格小于阈值」，`r/5 < r` 在整个取值区间自动成立；出厂默认 `0.5 / 0.1` 在 100 万窗口上 = 50 万触发、保留 10 万逐字。
    - **什么时候生效**：宿主的 `AgentPresets.ensureStanding()` 每次调用都重新核对组合指纹（mtime + size），文件一变就丢弃记下的 standing mount、挂到下一代——所以写入对**之后挂载**的代理生效：**新会话**与**新派发的阶段子代理**立刻拿到新值，**无需重启 dsh**；当前主会话留在它加入的那一代。
    - **这一行由设置页托管**：**settings 服务解析出用户值之后**（启动时第一次解析）与每次设置变更时，按设置值重写 `compaction-basic` 的这两个键（幂等：内容没变就不写盘）——解析之前**不做任何写入**（组合层的 `config` 并未声明这个键，用它写只会把用户存的值先改回出厂默认，并白白制造一次组合指纹变化）。**手改会在下一次启动或设置变更时被改回来**。对账器只动这一行，行外（persona 块标量、注释、其它行、行尾符）一个字节都不动；组合文件缺失、找不到该行、或该行把 `config:` 写成行内（flow）形式时只告警、不改写、更不会创建文件。
    - **默认值**：出厂 `0.5 / 0.1`（100 万窗口上 50 万触发、保留 10 万逐字）；上表里 446 个会话中只有 18 个会触发。它是运行时设置，范围 0.05–0.8，随时可调，生效时机同上。
  - **问题 2（扇出是这套协议最大的成本项）**：实测一个「写完整 API 文档」的请求派了 12 个阶段子代理（1 plan + 6 impl + 3 review + 2 fix），一个 Electron 重构派了 18 个、花掉 CNY 35.10，而阶段子代理占该工作区成本的 **90.6%**。每个多余的阶段子代理都是一份**没有前缀缓存可命中**的全新上下文，之后每一步还要付上下文重发税。
  - **做法 2（persona 新增 Right-size the pipeline 分级）**：在 `Judge complexity before acting.` 那段之后插入分级——**Trivial**（错别字 / 版本号 / 一行文档：主会话自己改，不派阶段）；**Small**（一个交付物、一个子系统、约 ≤2 个文件且用户可观察行为不变：**只派一个 `subagent_impl`**，不改可见行为就不派评审，跳过 plan 与 gate）；**Documentation-only**（对既有代码写 API 文档 / README / 迁移说明：**整份文档只派一个 `subagent_impl`**，只按真正独立的*源码区域*切分，绝不一个源码模块一个 workstream、更不一个 workstream 一个评审——评审的整份 patch 载荷是这套协议能发的最贵的一条消息，而文档错误修起来很便宜）；**Standard**（单子系统多文件行为变更：plan → gate → 一个 impl → 一次 review）；**Large**（多个独立子系统：按计划 `## Workstreams` 走完整流程）。拿不准时**往小一档**选：欠配的流水线会以「可以升级的评审」暴露出来，过配的流水线只会安静烧钱且无法撤回。
  - **问题 3（评审后续轮重发累积 patch）**：`### Repeat review rounds reuse the SAME reviewer` 原来要求第 2 轮起传「**the FULL NEW diff** captured at this moment」，与本节的「不要重复计划（也不要重复早先的 diff）」自相矛盾——实测三轮分别把 99,601 / 300,700 / 307,310 个字符送进**同一个**评审子代理，同一批 hunk 进了它的上下文三次。
  - **做法 3（后续轮只送增量 hunk）**：该条改为只送「**自该评审上一次裁决以来发生变化的 hunk**」（`git diff HEAD -- <本次修复触及的路径>`，或直接给具体 hunk）；只有整份改动被重写时才重发累积 patch，而且 `compact: true` 对**已 settle 的评审子代理**不可用（见上文冷子代理边界），所以要么再付一份拷贝的钱，要么——仅当本会话仍有创建名额——改派一个新的评审子代理。第 1 轮的 `subagent_review` 仍必须带完整 patch（插件强制校验 `@@` hunk 头），不改。
  - **问题 4（冷子代理不能压缩，但协议没写）**：压缩是冲着**活着的 agent 对象**做的，所以 `dsh` 重启后本会话的每个子代理都是冷的（实测本次会话 34 个子代理全部 `ready`）：`compact: true` 被拒（`cannot compact <id> — that child is not awake in this process`）、**什么都没投递**、目标收件箱不变。
  - **做法 4（把边界写进 persona）**：在压缩的四条可判定判据之后新增一段，明确这是**宿主 API 的已知边界——不是阶段失败、也不是 UNAVAILABLE 情形**：它**不**表示不能复用（不带 `compact` 的 `pipeline_followup` 照常冷启动续用）；**不要**让这次拒绝本身把你推去新派子代理（创建上限数的是创建数，新派也可能被拒），也绝不因此停任务——两条宿主约束**结构性互斥**：压缩需要**活着的 agent**，而活着的 agent 要么正在回合中（`compactNow` 抛 `busy`），要么刚被一次投递冷唤醒、inbox 已经满了；**唤醒也救不了**（子代理答完就回到冷态）。实测本安装 16 次压缩（11 次手动 `/compact` + 5 次自动）**没有一次属于阶段子代理**，`compact: true` 在复用流程里从未成功过。所以复用时按「`compact: true` 不可用」处理：**接受干扰，或——仅当本会话仍有创建名额——改派新子代理，并明确说出选了哪一个**。
  - **测试**：`test/watchdog.smoke.mjs` 新增 **E. 预设内容契约** 9 条断言（E1 预设可被 `yaml` 解析；E2 出厂默认 `thresholdRatio = 0.5` 且 `retainRatio = 0.1`；E3 宿主加载期不变式 `retainRatio < thresholdRatio`；E8 预设绝不出现 `retainTokens`；E4/E5/E6 三个策略锚点仍在 persona 里；E7 第 2 轮增量锚点在、旧的「the FULL NEW diff captured at this moment」已消失；E9 冷子代理边界改后的第 3 条锚点在 persona 里）、**F. 压缩触发比例对账器** 8 条断言（Case A 无 `config:` 补块（插在 `name:` 之后）、Case B 已有键就地替换、Case C `retainTokens` 被 `retainRatio` 顶掉、幂等、`retainRatio = thresholdRatio / 5` 且区间两端 0.05 / 0.8 都严格小于阈值、行外逐行不变（含 CRLF）、行尾注释仍算块风格、找不到该行时 no-op 报 not found）与 **G. 设置 → 已安装预设组合的写入链** 5 条断言（G1 设置 `0.3` → 组合被写成 `0.3`/`0.06`（唯一走 `await writeFile` 的路径）；G2 组合缺失只告警、不创建文件；G3 没有该行只告警、文件不变；G4 行内（flow）`config:` 一律 no-op、不追加第二个 `config:` 键；G5 锚点行没有行尾符时新块另起一行、写出的字节仍可解析）。断言数 **166**、0 failure（本版新增 **22** 项；0.2.3 起总计 **167**）。
  - **如何确认生效**：`grep -A3 'compaction-basic' ~/.dsh/.agent-presets/code-pipeline/agent.cordis.yml` 应显示设置页配置的那一对（默认 `thresholdRatio: 0.5` / `retainRatio: 0.1`）；改完设置后**新派发的阶段子代理**在下一次派发即用新值（新会话同理），**当前主会话**需重选一次预设或重启 dsh。
- **0.2.1（修 0.2.0 的一处计数 bug：无阶段归属的旧子代理被误算进每一个阶段桶）**：
  - **问题**：`mergeStageRows` 的过滤条件写成 `stageKey !== undefined && row.stage !== undefined && row.stage !== stageKey`——只在归属**已知**时才比较阶段，于是**归属为 undefined 的行会被算进每一个阶段**。0.2.0 之前创建的旧子代理正是这种行（label 没有 `<stage>/` 前缀、不是 live、进程内台账里更没有）。实测症状：某会话 10 个旧子代理把 **plan** 桶顶到 `limit` 之上——用户只创建过 1 个规划子代理却被拒，且这 10 个还被列成"可复用"（实际又寻址不到：`resolveFollowupTarget` 只认有归属的行）⇒ **既不能复用也不能新建，阶段卡死**。同一份虚高还会被 `noteCreatedObservation` 记成只增不减的「高水位」，从此永久污染该阶段。
  - **做法**：`mergeStageRows` 对**宿主行**改为精确匹配（`row.stage !== stageKey` 即跳过），无归属的行被排除在所有阶段桶之外；`knownStageRows` 改为走该函数注释里本就写明的 `undefined` 模式（它合并的两个来源都已按阶段过滤过、且合并输出会丢弃 `stage` 字段——若传 `stageKey`，严格匹配会把这批行整批丢掉，拒绝文案的兜底清单就空了）。
  - **边界不变**：无归属的旧子代理**仍不计入上限、也不可复用**（本次不改变该边界）；要按精确 id 复用它们需要另做寻址增强，未做。
  - **生效条件（高水位是纯进程内状态，离线替换文件无效）**：`createdObservation` 是模块级 `Map`，单调只增、**不落盘**，全文件只有读写三处、**没有任何 `delete` / `clear` 路径** ⇒ 进程内没有自愈路径；0.2.0 期间被顶高的桶只有**重载 / 重启 dsh**（重新加载本版 `lib`）才会清零。**离线替换 profile 里的文件对已加载的模块无效**，所以「装上 0.2.1」本身不构成生效条件——必须重启。
  - **测试**：新增 F1 三条断言（`cap=1` 且持久面有 3 行无归属标签时仍能新派第一个；**先结束第 1 个**、第 2 个必须撞**创建**闸门（拒绝文案带该子代理 id），证明计数是 1 而不是 1+3；无归属行仍不可寻址）。断言数 141 → **167**（其中 0.2.1 新增 3 项、0.2.2 新增 **22** 项、0.2.3 新增 **1** 项）、0 failure。变异验证：把过滤条件改回旧写法后 F1 第 ① 条必红并报出生产同款文案；停掉创建计数台账后 F1 第 ② 条必红——之所以让它先结束第 1 个，正是为了让这条断言只对「创建计数」敏感：第 1 个仍在跑时拦下第 2 次派发的是**运行**闸门（`stage concurrency limit reached`），那句文案与计数无关，对「计数是 1 而不是 1+3」零鉴别力。
- **0.2.0（复用优先从"劝说"升级为硬机制：创建数量上限 + 压缩后复用）**：
  - **问题**：阶段子代理都从空会话起步，同一任务的多轮（改需求、多轮评审、墙钟续跑）每轮新开
    一个子代理 ⇒ 会话数暴涨、每轮重复付 system/persona/派发消息的钱，而且新会话**没有前缀
    缓存可命中**。此前只靠 persona 劝说「复用已有的子代理」并不可靠（实测里调度方在专门修这个
    浪费时又犯了一遍），所以这一轮把机制落到代码路径里。
  - **做法**：
    1. **创建数量硬上限**：每 `(父会话 × 阶段)` 统计**已创建**（含已结束）的子代理总数，
       超限派发**在代码路径里被拒绝**（不是劝说）；错误文案自带**可复用清单**（`id` + label +
       活跃状态）与三条出路（复用 / 有干扰时先 `compact: true` 压缩再复用 / 等 settled 后复用），
       并明确「这是对**创建**的策略上限，不是阶段不可用」。**复用既有设置项**
       `stages.<stage>.maxConcurrency`（`0 = 不限制` 原样保留，零回归），**没有新增任何设置项**。
       计数真值 = 进程内台账 ∪ 宿主 `subagents.listChildren`，**只增不减**（等 settle 不腾名额）；
       同步预留 + `await listChildren` 后复检，防 PTC `Promise.all` 竞态。
    2. **`pipeline_followup` 新增 `compact: true`**：在**投递之前**压缩**目标子代理自己**的
       历史（顺序是宿主要求：`compactNow` 在 inbox 非空时抛 `busy`）。服务寻址走该预设
       realm 私有的 `compaction`（`agentPresets.serviceFor(agent, "compaction")`，**不能**用
       `ctx.get("compaction")`——宿主 root realm 里另有一个实例，用它压缩会打错 session 的账
       且不报错）；超时 10 分钟，与调用方 signal 用 `AbortSignal.any` 合并。**任何压缩失败都
       保证未投递**（冷子代理 / 服务不可达 / 各失败码各有对应文案）。
    3. **三阶段统一复用协议**：预设新增同级小节「Reuse the stage subagents you already have
       (SAME child, later rounds)」，把 **plan / impl / review** 都纳入「第一次派发、之后每轮
       复用同一个子代理」，并给出**压缩的四条可判定判据**；同时修掉六处反向 / 过期措辞
       （含删掉「review 返回 CHANGES REQUIRED 就重新派发 `subagent_impl`」这条会把浪费重新
       引入的旧指令）。
    4. **label 阶段前缀 + 别名稳定**：阶段子代理的显示名统一为 `<stage>/<description>`，让宿主
       持久面（`listChildren.label`）也能归属阶段；别名解析改用单调递增的 `seq`（原先用会被
       续跑改写的 `entry.at`，「最近派发」在续跑后会漂移）。
    5. **status 端点新增** `created`（已创建数）与 `available`（可复用子代理数组
       `{ id, label, activity }`）；设置卡片显示「当前运行 N / 上限 M / 已创建 K」+ 可复用清单。
  - **测试**：`test/watchdog.smoke.mjs` 从 36 项扩到 **141 项断言，0 failure(s)**（新增 105 项：
    创建闸门机制 / 压缩顺序与失败路径 / 别名稳定 / status 字段）。
  - **已知边界（如实记录）**：
    - **旧子代理无法回溯**：本轮之前创建的子代理重启后既没有 `<stage>/` label 前缀、也没有
      `stageKey`，既不计入创建数、也不进复用清单；
    - **冷子代理无法压缩**：重启后本进程未唤醒的子代理，`compact: true` 会报错，且**唤醒也救不了**
      （答完就回到冷态；实测本安装 16 次压缩全部在主会话，阶段子代理 0 次）——只能改用
      `compact: false` 投递并接受干扰，或在本会话仍有创建名额时改派新子代理；
    - **压缩有代价**：会抹掉该子代理超出摘要的历史记忆并放弃前缀缓存，所以只应在「复用会把
      干扰带进来」时使用（四条判据写在预设的新小节里）；
    - **压缩需要目标 idle**：先压缩后投递是宿主要求的顺序；
    - **两道闸门共用同一个 `maxConcurrency`，运行闸门先判**：上限很小时，第 1 个子代理仍在跑时
      的第 2 次派发通常先撞运行上限（文案只有复用提醒），等它结束后才撞创建上限（文案带清单与
      `compact` 指引）；
    - **创建数只增不减**：等一个子代理 settle 不腾出创建名额，本会话到顶后除复用外不再放行；
    - **`engines` 不变**（本轮不涉及宿主契约）。

- **0.1.19（宿主事实核对：文案口径修正 + 探测表清理 + 测试加固）**：
  - **`run_code` 墙钟口径改正**：库内注释、`run_in_background: false` 的拒绝错误串、预设 persona
    与 README 原先都写成「20 分钟」级别的上限——原文分别是 `lib/index.js` 的「run_code 有 20 分钟」/
    「run_code is capped at a 20-minute wall clock」、`README.md` 的「`run_code` 程序有 20 分钟
    wall-clock 上限」、预设的「a 20-minute wall-clock ceiling」；本轮已按实际改正为 120 s/600 s
    （见下），原先的写法与宿主源码不符——`ptc-runtime-node` 的 `Config` 是
    `timeoutMs: z.number().default(120_000)` / `maxTimeoutMs: z.number().default(600_000)`
    （`packages/ptc-runtime/ptc-runtime-node/src/index.ts:54-56`），且 `packages/bundle/base/cordis.patch.yml`
    的 `ptc-runtime` 行不带 `config`（`:369-370`），所以实际是**默认 120 s、上限 600 s**，
    传 `run_code` 的 `timeoutMs` 可顶到上限；全仓不存在该量级的常量。四处文案统一改为事实口径。
  - **删除死探测分支**：`queueFollowupMessage` 的载荷探测表第 3 项 `mode: 'queue'` 永不可达
    ——宿主 `subagent.prompt` 的 control schema 是 `mode: z.literal('continuable')`（`delivery`
    自 0.1.3-alpha.2 起必填），
    见 `packages/subagent/subagent/src/control.ts:20-25`。探测表只剩两项：带 `delivery` 的当前形状
    → 不带 `delivery` 的旧形状。
  - **放宽宿主错误文案判别**：`isBadPayload` 由整句 `message === "invalid payload for subagent.prompt"`
    改为**两个条件取 OR**：`message.startsWith("invalid payload for subagent.prompt")` **或**
    `Array.isArray(details.issues)`，命中任一即继续探测下一形状。宿主文案由 `control.ts:46` 的
    `invalid payload for ${method}` 模板生成，改文案不再让探测静默失效；兜底读的是
    `RemoteError.details.issues`（`RemoteError` 第三个构造参数即 `readonly details`，
    `packages/typert/protocol/src/remote-error.ts:22-30`）。注意必须是 OR：`RemoteError` 继承
    `Error`、`message` 恒为字符串，所以早期写过的三元形式（"message 是字符串就查前缀、
    否则才看 issues"）里 issues 那一支**永不可达**（死代码），宿主一改文案探测就放弃回退——
    这正是 OR 兜底要修掉的行为。
  - **测试加固**：假 ctx 现在校验宿主调用的实参形状（`startContinuable` 的 `spec.signal` /
    `spec.request.prompt`、`prompt` 的尾参 `signal`、`sendMessage` 的 `options.signal`），
     并新增 queue 投递路径、探测表次数与**探测表尝试序列**的断言（27 → 36 项）：
    假 `prompt` 在判定接受之前记录每次尝试的载荷，因此可以断言"两种已知形状都被拒时
    尝试序列恰为 `[continuable+delivery, continuable]`、没有任何 `mode === 'queue'`"
    （次数断言拦住更长的探测表，序列断言额外钉住回退项的形状：第二项必须是不带
    `delivery` 的 `continuable`），以及
    "宿主改写文案但保留 `details.issues` 时仍然回退成功"（OR 兜底的行为覆盖）。
  - **`engines.dsh` 提升**为 `>=0.1.6-alpha.1`：真正把下限推到 0.1.6-alpha.1 的只有
    `workflow-ptc` **行名**（该行由提交 `35af8698c2` 引入，最早包含它的 tag 是
    `dsh-v0.1.6-alpha.1`）。`subagents.prompt` 的 `delivery` 必填自 0.1.3-alpha.2 起
    （提交 `96ead6091d`），`signal` 尾参自 `dsh-v0.1.2-alpha.1` / `dsh-v0.1.2-rc.1` 起就
    要求调用方显式传入（提交 `377f3b4f1d`）——这两条都**不是**本次抬下限的原因，
    旧下限 `>=0.1.2-rc.1` 在这一点上并不不实。
  - **如实记录一次误报（避免后人重踩）**：本轮调研曾上报「`subagents.prompt` 缺 `signal` 尾参、
    queue 投递必然失败」，经复核**已撤回**。成因是读取宿主源码时把行截断后按残文推导实参个数。
    实际插件一直是 `const receipt = await subagents.prompt(payload, signal);`（两个实参齐全），
    queue 投递与墙钟收尾投递路径经完整核对**没有缺陷**。教训：**不要用被截断的源码行判定实参个数**。
- **0.1.18（适配 dsh 0.1.6-alpha.1：工作流引擎改名 workflow-ptc）**：
  - **症状**：升级后预设挂载失败 —— `row "workflow-worker-thread" names a plugin that cannot be
    resolved: @deepseek-ai/dsh-workflow-worker-thread`，resume 会话直接 `RemoteError ... (gateway/internal)`。
  - **原因**：0.1.6-alpha.1 把工作流引擎包改名并重写：`@deepseek-ai/dsh-workflow-worker-thread` →
    `@deepseek-ai/dsh-workflow-ptc`（行 id 也改成 `workflow-ptc`）。预设行名不会自动迁移，旧包名
    解析失败即整份预设拒绝挂载。
  - **修复**：预设行改为 `- id: workflow-ptc` / `'@deepseek-ai/dsh-workflow-ptc'`，仍 `provider: spawn`
    且不 disabled（本预设为 `ralph` 保留引擎）；预设头部注释记录改名与上游默认（upstream ptc 把
    它与 `tool-ralph` 一起关掉）。
  - **核对**（脚本化）：预设引用的 25 个 `@deepseek-ai/*` 包名 + 28 个配置字段全部在 0.1.6-alpha.1
    中可解析/仍存在；插件用到的宿主服务（agents / agentPresets / subagents / settings / tools /
    webServer）、事件（agent/created、agent-preset/selected、subagent/end、agent/disposed、
    agent/request、subagent/provider-added）与方法（startContinuable / listChildren / interrupt /
    sendMessage / prompt / installSection / composedPreset / isOwnedBy）逐一核对未变。
  - 本轮只改 `preset/`（lib/ 与 0.1.17 一致）。
- **0.1.17（墙钟与续跑的计时口径）**：
  - 明确并落实「**每次派发 = 独立墙钟**」：新子代理、新账本条目、派发时快照预算；并行 workstream 各算各的。
  - `pipeline_followup` 续跑**已停下**的子代理（settled / wrapup-done / stopped）→ 重新起算墙钟并按当时
    设置取新预算，回执新增 `wallClockRearmed: true`（工具 description 与 render 同步说明）；给**运行中**的
    子代理插话（steer）**不重置**——否则 steer 就成了绕过止损线的手段；`lost` 条目不复位。
  - `test/watchdog.smoke.mjs` 扩到 27 项断言：运行中插话不重置、原预算仍按时到期、续跑重新起算并按
    新预算到期、settle 后续跑（评审第 2 轮那条路）同样重新起算。
- **0.1.16（墙钟软警告 + 计划工作流切分契约：并行 impl）**：
  - **软警告（80%）**：`SOFT_WARN_RATIO = 0.8` 处先向仍在运行的子代理 steer 一条「开始收尾、
    结束前给状态报告」的消息（`subagents.sendMessage`，最近一个模型步骤可见）；只发一次，
    只在确认运行中时发（steer 对 idle 目标是开新回合），失败只记日志。硬超时路径不变。
  - **plan 阶段产出 `## Workstreams` 切分表**（persona + plan 工具 description）：`id / goal /
    owned files / depends on / acceptance check`，任一文件只能属于一个 workstream，共享串行点
    收进 `integration`，或直接 `Workstreams: single workstream`。
  - **预设 persona 的并行协议**：≥2 个文件不相交且无依赖的 workstream → 一个程序里并行派发
    `subagent_impl`；评审按 workstream 捕获**路径受限 diff**（`git diff HEAD -- <paths>`）各自评审；
    切分不清就先让 plan 改计划。
  - **新增「Wall-clock interruption」处置协议 + 两条 Invariant**：墙钟中止 **不是**阶段不可用 ——
    读收尾报告后三选一：**续**（`pipeline_followup` 同一个孩子，最省）／**拆**（剩余工作拆小重派）／
    **停**（同阶段两次超时或半成品无法自洽 → 报告用户）；绝不静默重试、绝不自己修补。
  - 预设头部注释、`preset.yml` 描述、设置卡片文案同步；`test/watchdog.smoke.mjs` 扩到 21 项断言。
- **0.1.15（每阶段墙钟预算：超时自动中断 + 自动索取收尾报告）**：
  - **问题**：宿主对子代理没有回合 / 步数 / 时长上限（agent-loop 的 Config 只有
    `maxParallelToolCalls`；`dsh-tool-call-timeout-policy` 只管单次工具调用），一个跑飞的 impl
    只能由模型自己决定停下 —— 长时间烧 token、工作区停在半成品，而父代理只收到一句
    `was stopped before it finished` / `left no closing message`。
  - **新增设置项** `stages.<stage>.budgetMinutes`（plan / impl / review 各自独立，默认 0 = 不限制）：
    该阶段**单次派发**的墙钟预算，派发时快照进账本（与并发上限同语义：只影响后续派发）。
  - **超时处理（看门狗 15 秒一轮巡检账本）**：① `subagents.interrupt(childId,
    { kind: "ancestor", agent: parent })` 中断当前回合（只结束 turn，Activation / 未领取 inbox /
    下级都保留，之后仍可 `pipeline_followup` 续跑同一个子代理）；② 等它停下后经 host-protocol
    `delivery: "queue"` 投递自包含的收尾报告指令（已完成含精确路径 / 半成品 / 未完成 / 风险 / 建议）；
    ③ 收尾回合 3 分钟宽限，再超时第二次中断硬停。状态机：running → timed-out → wrapup →
    wrapup-done，自行结束为 settled，异常路径 stopped / lost。
  - **模型可见语义**：三条阶段工具 description 增加 WALL-CLOCK BUDGET 段 ——
    `was stopped before it finished` 不是阶段不可用，等收尾报告通知后决定续跑 / 拆分 / 停止。
  - `GET /dsh-code-pipeline/status` 每阶段新增 `budgetMinutes` / `timedOut` / `longestRunningMs`；
    设置卡片新增「墙钟预算（分钟）」输入与实时状态行（预算 / 最早已运行 / 已超时数）。
  - 假 ctx 集成冒烟（本轮新增，见下）：预算到点触发中断 + queue 收尾投递、子代理自行 settle
    不误伤、收尾宽限用尽第二次中断、父代理缺失 / 宿主缺 `interrupt` 时不重试、status 端点字段。
- **0.1.14（prompt 协议：多轮评审复用同一个评审子代理，零代码改动）**：
  - **问题**：plan → impl ↔ review 循环里每轮评审都是一次新的 `subagent_review` 派发 ——
    每个新子代理都从空会话起步，重新吃一遍「计划 + 完整 diff + 历史结论」（新会话还没有前缀
    缓存可命中），又慢又费 token。
  - **做法（纯 persona/prompt）**：预设 persona 新增「Repeat review rounds reuse the SAME
    reviewer」硬性协议 —— 第 1 轮照常 `subagent_review` 并记住其 `subagentId`；第 2 轮起改用
    已有的 `pipeline_followup` 把增量消息（完整新 diff + 每条编号问题的处理说明）投回**同一个**
    评审子代理，计划与历轮 diff 不再重复传送；结论仍以完成通知回到本会话，评审的回复契约
    （`APPROVED` / `CHANGES REQUIRED:` + 编号问题）不变。build flow 第 4/5 步、Review-only
    流程与 Invariants 同步更新；预设头部注释、`preset.yml` 描述同步。
  - **不改任何代码**：`lib/index.js`、`lib/client.js`、工具参数与输出 schema、设置项、
    `GET /dsh-code-pipeline/status` 全部与 0.1.13 一致（本次改动只落在 `preset/`）。
  - 已知边界（persona 里写明）：评审子代理在跑时不续发（先等完成通知）；新任务新派发；
    并行目标各自按 `subagentId` 续用；`pipeline_followup` 找不到子代理（如 dsh 重启后台账
    清空）时退回一次带完整物料的 `subagent_review` —— 是回退，不是「阶段不可用」。
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
    阶段同时运行的子代理上限（**0.2.0 起同一数值扩展为双层上限**——同时运行 + 已创建总量，
    见「每阶段并发上限与并行派发」）。准入两步：**同步先到先得**（账本 + 预留，避免并发
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