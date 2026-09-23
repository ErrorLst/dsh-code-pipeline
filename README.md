# @dsh-external/dsh-code-pipeline

DSH bundle 插件：为 `code-pipeline` agent 预设（PTC / Code Mode）注入三阶段子代理工具
`subagent_plan` / `subagent_impl` / `subagent_review`，外加 `pipeline_followup` 与
`pipeline_result`；阶段模型、并发上限、墙钟预算、read 窗口下限、压缩触发比例都在
设置页（Settings → 代码流水线）实时配置。

要求：**dsh ≥ 0.1.7-alpha.1**、Node ≥ 22.19.0（见 `package.json` 的 `engines`）。
历史版本说明全部在 [CHANGELOG.md](CHANGELOG.md)。

## 解决的问题

`code-pipeline` 预设原本把三个 `dsh-tool-subagent` 行和每阶段的 provider / model /
persona / toolFilter 静态钉死在组合里——改模型 = 改 YAML = 重启会话。

本插件把「注册哪些工具」与「用哪个模型」解耦：

- **工具注册（静态）**：监听 `agent/created`，对组合了 `code-pipeline` 预设的 ROOT 代理，
  在其自身作用域注册 5 个工具。阶段子代理不注入（它们的 persona / 只读工具面由父代理
  通过 `subagents.start` 请求传入）。
- **模型选择（动态）**：每次工具调用都读当前设置，保存后**下一次派发**立即生效。
- **设置页（浏览器）**：`settings.section` 卡片编辑插件 Config 的 volatile 字段；
  provider / 模型 / 思考等级选项来自 `GET /dsh-code-pipeline/options`（不可用时字段禁用），
  实时运行状态来自 `GET /dsh-code-pipeline/status`（5 秒轮询）。

## 安装 / 升级 / 卸载

```bash
# GitHub 分发（推荐）
dsh plugin --profile web add github:ErrorLst/dsh-code-pipeline

# 本地开发（改 lib/ 后重启 dsh 生效）
dsh plugin --profile web add link:<本仓库绝对路径>

# 卸载（预设随包声明，不会留下已安装副本）
dsh plugin --profile web remove @dsh-external/dsh-code-pipeline
```

`dsh plugin add` 会自动完成依赖安装与 bundle 登记；重启 `dsh web` 后生效。

## 使用

### 三个阶段工具

三个工具的入参契约一致：`prompt`（或别名 `task`）+ `description`（显示名）+ `files`
（**必填**：本阶段要读的路径，一行一个；单个 `-` 显式声明没有清单）+ 各阶段的物料字段
（`context` / `plan` / `constraints` / `implementationSummary` / `diff` / `focus`）。
未知键会被拒绝，绝不静默丢弃物料。

- **`subagent_plan`**：只读研究并产出计划。**只做规划**——不审查、不审计、不审批代码。
- **`subagent_impl`**：完整工具面，按计划修改工作区。**只做实现**。
- **`subagent_review`**：只读审计变更集。**只做审查**——不做规划、不做设计；
  `diff` 必须是完整补丁文本（含 `@@` 块头），统计摘要 / “见 git show” 会被拒绝。

三者都是**后台模式**：立即返回 `{ kind: "continuable", subagentId }`，子代理独立会话继续跑，
settle 时 runtime 自动向本会话发完成通知（结果与最终回复就在通知里）。阶段结束时可以把
产出文件交给主代理登记（`present` 行随预设声明携带）。

**派发消息整体落盘**：prompt 与该阶段全部物料合并后的全文写入一个临时文件
（`os.tmpdir()/dsh-code-pipeline/`，默认一律落盘），子代理提示里只留路径引用，
`read` 一次即可拿到全部消息；启动时清理超过 24 小时的临时文件。

### `pipeline_followup`：改需求 / 后续轮次

同一个工作流的后续轮次**不新派子代理**，而是把消息投给已有的那个：

```
pipeline_followup({ child, message, files, issues?, changeSet?, compact? })
```

- `child`：`latest` | 阶段键 `plan`/`impl`/`review`（含中文别名）| 精确 `subagentId`（支持唯一前缀）；
  未命中进程内台账时回退宿主持久面，dsh 重启后仍可按 id 寻址。
- `files`：**必填**，与阶段工具同一契约（`-` 表示本轮没有候选清单）。
- `issues[]`：把裁决后的待修项原样传递，插件渲染进消息——不必手抄、不会丢字段。
- `compact`：投递**之前**压缩该子代理自己的历史（10 分钟上限），失败则**什么都不投递**。
  冷子代理（dsh 重启后未唤醒）无法压缩，实践中复用时按不可用处理。
- 投递方式由设置项 `followupMode` 决定：`steer`（插入，运行中下一个模型步骤就看到）
  或 `queue`（排队，当前回合结束后处理）。
- 续跑一个**已停下**的子代理会按当前设置**重新起算**墙钟（回执带 `wallClockRearmed`）；
  给运行中的子代理插话不重置。

### `pipeline_result`：读结构化回执

阶段子代理在最终回复末尾给出一个 `json` 围栏 envelope（`plan` / `impl` / `review` 三种），
插件在 `subagent/end` 解析并做语义校验（例如 review 的 blocking 必须有 `failureScenario`、
`docs` / `style` 永不 blocking、verdict 与 findings 机械一致）。主代理用
`pipeline_result({ child })` 把它当数据读回来做白名单过滤，而不是“读文本再抄一遍”。
解析失败不阻塞——回执里带 `{ parsed: false, reason }`。

### 人工闸门

闸门是**对话内自然闸门**，不用 `ask_user_question`（卡片不支持 Markdown，长计划会被挤压）：
plan 返回后主代理把完整计划以普通 Markdown 回复呈现并结束回合；用户下一条消息即答复——
批准（approve / 批准 / 同意 / ok / 可以 / 开始 / 没问题 等且无新增要求）进入实现，
其他内容视为修订反馈。**修订没有次数上限**，循环由用户控制。

## 设置项

| 设置 | 字段 | 默认 | 语义 |
| --- | --- | --- | --- |
| 启用 | `stages.<stage>.enabled` | `true` | 关闭后该阶段工具调用直接报错 |
| Provider 路由 | `stages.<stage>.provider` | `deepseek-official` | 仅从宿主 provider 列表选择 |
| 模型 | `stages.<stage>.model` | `deepseek-flash` | 仅从该 provider 的模型列表选择 |
| 思考等级 | `stages.<stage>.reasoningEffort` | `""` | 留空 = 继承 provider 路由级默认；选项按模型实际支持面列出 |
| 最大并发 | `stages.<stage>.maxConcurrency` | `0` | 同一父会话内该阶段**同时在跑**的上限；0 = 不限制 |
| 墙钟预算 | `stages.<stage>.budgetMinutes` | `0` | 单次派发的最长运行时间（分钟）；0 = 不限制 |
| 压缩触发比例 | `compactionThresholdRatio` | `0.5` | 0.05–0.8；写入 profile 的预设声明 |
| 投递方式 | `followupMode` | `steer` | `pipeline_followup` 的默认方式 |
| read 窗口下限 | `readWidenMinLines` | `200` | 低于该值的 read 请求被自动拓宽；`2000` = 一整窗；`0` = 关闭 |

设置为插件 Config 的 volatile 字段，值持久化到 profile 的 Cordis patch；除压缩触发比例外
都**立即生效**（压缩比例写入预设声明，对新会话 / 新派发的阶段子代理生效）。

## 机制

### 每阶段并发上限

按 `(父会话 × 阶段)` 统计宿主 `activity = running` 的子代理数，**按会话独立判定**。
准入两步：同步先到先得（插件账本 + 在途预留，避免 `Promise.all` 并发调用互相算名额而双双被拒）
→ 再用 `subagents.listChildren` 异步核对真实运行数并修剪账本。

**没有「已创建总量」上限**：新的独立工作流一律新派自己的子代理；只有同一工作流的后续轮次
才用 `pipeline_followup` 续用（不创建子代理）。到上限时新派发被拒——这是**瞬时策略拒绝，
不是阶段不可用**，等名额释放后在后续步骤重派即可。宿主另有每会话「同时存活 continuable
子代理」上限（`subagent.maxActiveSubagents`，默认 8）与每个 `run_code` 程序 10 个并行子调用
的上限。

### 每阶段墙钟预算

15 秒一轮巡检账本；预算 80% 处给**仍在运行**的子代理插一条「开始收尾」提醒（只发一次），
到 100% 时：

1. `subagents.interrupt(childId, { kind: "ancestor", agent: parent })` —— 只结束**当前回合**，
   Activation / 未领取 inbox 都保留，之后仍可用 `pipeline_followup` 续跑同一个子代理；
2. 经 `delivery: "queue"` 投递一条自包含的收尾报告指令（已完成 / 每处改动状态 / 未完成 /
   风险 / 建议），父代理收到的完成通知因此带可用现状；
3. 收尾回合另有 3 分钟宽限，再超时第二次中断（硬停）。

预算在派发时快照：改设置只影响之后的派发。预算到点是「被中断 + 收尾」，**不是**阶段不可用。

### read 读取窗口拓宽

在宿主的 `tools/execute` around-waterfall 上，对本预设代理（主会话 root + 阶段子代理）
发出的 `read` 做**执行前参数改写**：`limit` 低于下限 → 拓宽到下限；超过工具上限 2000 →
治愈为 2000（否则整批 read 直接失败）；`limit` 缺省或已 ≥ 下限 → 不动。

PTC 下 `read` 只在 `run_code` 程序内发生，**嵌套结果只进程序、不进模型历史**，所以拓宽是
零 token 成本的——它消除的是「一个文件几十行几十行地翻、每多一步重发整个上下文」的分页模式。
除机制外，预设 persona、三段阶段 persona 的 TOOL GOTCHAS 与 `files` 派发块都会写明**实时**下限值。

### 评审复用与增量

第 1 轮照常 `subagent_review`（计划 + 实现摘要 + 完整 diff），并记住它返回的 `subagentId`；
第 2 轮起用 `pipeline_followup` 投给**同一个**评审子代理，只送自上次裁决以来变化的 hunk
（计划与历轮 diff 不再重复传送——它们还在那个子代理的会话里，前缀缓存可命中）。
新任务用新的 `subagent_review`，绝不复用别的任务的评审子代理。

## 计划的工作流切分（Workstreams）

plan 阶段必须以 `## Workstreams` 表结尾（`id / goal / owned files / depends on / acceptance check`），
或一句话 `Workstreams: single workstream`。硬规则：

- 任一文件只能出现在一个 workstream；共享串行点（`package.json`、lockfile、barrel、迁移、生成物）
  收进最后一个 `integration` workstream；
- 一个 workstream 要值得独占一个子代理（大致 >1 个文件或 >15 分钟），但也不能把多组不相关交付物
  捆成一个（那会把它拖成 50+ 步、数百万 token 的重发）；
- 并行 impl 仅用于**文件不相交 + 真正独立 + 各自可机器校验 + T2 规模**；写入默认串行；
- 并行评审时按 workstream 捕获**路径受限 diff**（`git diff HEAD -- <owned paths>`）。

## 兼容与自检

插件对宿主服务 / 事件的依赖集中在 [lib/host-contract.js](lib/host-contract.js)，
访问统一经 [lib/host.js](lib/host.js) 的 `getService` / `onHost`（都不抛错）：

- **启动自检**：一条 INFO 汇总全部宿主面。服务在 `apply` 之后才注册的**缺席只记 INFO**
  （本插件本就有 `subagent/provider-added` 这类补注入路径）；只有「**在场但缺必需方法**」
  （真正的 API 形状漂移）才 WARN，并点名缺哪个方法。
- **`GET /dsh-code-pipeline/status`** 返回 `host.checks`（逐面探测）、`host.broken` 与
  `host.injection`（`matched` / `injected` / `failed`）——「阶段工具没出现」可直接判读，
  不必翻日志。
- 插件不写任何宿主配置文件（压缩触发比例经宿主的 `configEditor` 写入插件自己的预设声明条目），
  也不在工作区创建任何物料文件：确需落盘只允许 `$TMPDIR/dsh-code-pipeline`。

### dsh 升级后

1. `npm run verify` —— 冒烟 + 预设漂移检查（断言数以输出为准）；
2. 若 `check:preset` 报错，按它给的清单改 `preset/code-pipeline/agent.cordis.yml`
   （包名不可解析 = 整份预设挂载失败；上游新增且启用的行 = 功能丢失）；
3. `npm run build:preset` 重新生成 `preset/code-pipeline/cordis.patch.yml`；
4. 重启 `dsh web`。

## 本地验证

```bash
npm install              # 或 pnpm install：解析 @deepseek-ai/schemastery 与 yaml
npm test                 # 假 ctx 集成冒烟（断言数以输出为准，当前 239）
npm run check:preset     # 与已安装 dsh 的内置 ptc 预设比对
npm run verify           # 以上两者
```

冒烟脚本用假 ctx（假 `agents` / `subagents` / `webServer` / settings / configEditor + 可控
`Date.now`）加载真实的 `lib/index.js`，覆盖墙钟状态机、并发准入与竞态、压缩顺序与失败路径、
别名解析、结构化回执、read 拓宽、files 契约、status 字段、预设内容契约，以及宿主安全
（契约清单与源码逐一对齐、缺服务降级、hook 绝不抛进宿主、profile 树引用契约、文案预算）。
`check:preset` 会实际读取已安装 dsh 的内置 `ptc` 预设；找不到宿主时**报错而不是静默通过**
（假绿会掩盖真正的漂移）。

## 已知边界

- **阶段不可用 = 结束任务**：阶段工具报错（被禁用、未配置 provider/凭据、provider 未注册、
  启动失败）时错误文案要求主代理停下并报告，不得自己接手、不得换路由。**例外**（瞬时拒绝，
  不算不可用）：插件运行并发闸门、宿主存活容量上限（`ACTIVATION_LIMIT_REACHED` /
  `subagent/delivery-unavailable`）。
- **墙钟预算到点**是「被中断 + 收尾」，不是阶段不可用。
- **压缩需要活着的 agent**：冷子代理无法压缩，重复唤醒也救不了（答完就回到冷态）。
- **`pipeline_result` 依赖子代理遵守 envelope 契约**；解析失败不阻塞，但该轮没有结构化回执。
- 旧子代理若既没有 `<stage>/` label 前缀也没有 `stageKey`，无法回溯归属（不计入并发行）。
- 同 id 冷恢复的会话会重新注入工具（按对象身份记账，不用 id 集合）。

## 变更记录

全部历史版本说明见 [CHANGELOG.md](CHANGELOG.md)。
