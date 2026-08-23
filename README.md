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

## 安装

1. 在 `C:\Users\zhoujin\.dsh\profiles\web\package.json` 的
   `dsh.profile.bundles` 与 `dependencies` 中加入本包（`link:` 指向本目录）。
2. 在 profile 目录执行 `pnpm install`。
3. **安装预设**：把本仓库 `preset/code-pipeline/` 拷贝到
   `$DSH_HOME\.agent-presets\` 下（见下节「预设文件」，插件不会替你做这一步）。
4. 重启 web 启动（bundle 插件双层加载，需要重启）。

## 预设文件（preset/）

`code-pipeline` 预设的组合内容（主代理 persona 与流水线协议、Code Mode 展示、
禁用通用 `subagent`/`subagent_fork`、delegation 组等）**随本仓库在
`preset/code-pipeline/` 目录维护**（`agent.cordis.yml` + `preset.yml`），但——

> **插件不会安装、更新或改写该预设。** 安装与升级都由你**手动拷贝**到 dsh 的
> agent-presets 目录，预设仍是 dsh 预设机制下的普通组合文件。

- 首次安装：

  ```powershell
  Copy-Item -Recurse -Force "$PSScriptRoot\preset\code-pipeline" "$env:DSH_HOME\.agent-presets\code-pipeline"
  ```

  （`$env:DSH_HOME` 默认 `C:\Users\<user>\.dsh`；等价于把 `preset\code-pipeline\` 目录内容
  放到 `C:\Users\<user>\.dsh\.agent-presets\code-pipeline\`。）

- 更新预设：用仓库新版本**整目录覆盖** `$DSH_HOME\.agent-presets\code-pipeline\`
  （`Copy-Item -Recurse -Force`，保持 `agent.cordis.yml` 与 `preset.yml` 都更新）。

- 生效时机：**新会话/新子代理**生效（dsh 的 standing 挂载按组合文件的变化时间戳
  重建）；**已经在运行的会话不会**自动切换——需要换新预设请开新会话。

- 插件与预设的版本对应：插件只保证与**仓库内 preset/ 副本**一致的那一版预设协同
  工作。升级插件后若发现行为对不上（如工具名、规则文本变化），优先检查
  `$DSH_HOME\.agent-presets\code-pipeline\` 是否落后于仓库的 `preset/code-pipeline\`——
  `diff -r` 两份目录即可确认。插件启动时如果发现目标预设目录不存在，会打一条
  warning 提示安装。

## 预设要求

- 预设中**不得**再包含静态的 `stage-plan` / `stage-impl` / `stage-review` 行
  （由插件注入，避免重名/双重定义）。
- 其余组成（persona、Code Mode 展示、只读过滤语义、禁用通用
  `subagent`/`subagent_fork`、delegation 组）保持仓库 `preset/` 副本的样子。
- 仓库内的 `preset/code-pipeline/` 就是唯一维护源：对预设的任何修改请先改这里，
  再同步拷贝到 `$DSH_HOME\.agent-presets\code-pipeline\`。

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
  预设；`persona` → 子代理 `deployment:persona` 提示段；`toolFilter` →
  `childCtx.tools.restrict(...)`；`agentOptions.provider/model` 优先于父代理路由。
- 工具注册的层由注册时 ctx 的作用域决定（实测：预设 standing 挂载不向其他
  会话泄漏）；通过 `agent.ctx` 注册落入该代理自身层，代理销毁自动回收。
- `tools.restrict` 只过滤继承层（global + 祖先），不过滤代理自身层 —— 因此
  阶段工具只注入 ROOT 代理，避免子代理的自有层被其只读过滤豁免。
