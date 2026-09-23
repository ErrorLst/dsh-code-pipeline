# dsh-code-pipeline 设计稿（v0.3，历史文档）

> **这是历史设计稿，不是使用说明。** 当前行为看 [README](../README.md)，逐版本改动看
> [CHANGELOG](../CHANGELOG.md)。文中行号对应 `dfa88b0`（0.2.5），实现早已前移。
>
> **已落地**：T0/T1/T2 分档与惰性升级、评审分级裁决与主会话白名单 triage、结构化
> envelope（`plan` / `impl` / `review`）、`pipeline_result`、`pipeline_followup` 的
> `issues[]` / `changeSet`、评审轮次与 blocking 遥测（`/status` 的 `reviews`）、
> 并行写降级为例外、`files` 派发契约。
> **未落地**：`pipeline_tier` 档位闸门（§3.3，未实现，档位完全由协议文本约束）、
> `pipeline_submit` 窄工具（§5.5 因宿主 `tools.restrict` 只认全局工具名而回退为围栏解析）、
> search-replace 变更集表达（§6 阶段 3 实验项）。
>
> 本文的研究引用与决策记录保留原样，供后续重新评估这些方向时参考。

---

# 原设计稿正文

> 目标：把「不管任务大小都跑 plan→impl→review」改成**按复杂度分档**；把评审从「全量交回 impl」改成
> 「**先裁决、只修必须修的**」；把阶段间**纯文本 I/O** 改成**结构化契约**。
> 本文只给方案与落地路径，不含实现。行号对应当前 main（`dfa88b0`，0.2.5）。

---

## 0. 摘要

三个问题各自独立，但共同根因是**协议只写了"应该怎么做"，没有可数判据、没有机制兜底**：

| 问题 | 现状根因 | 方案要点 |
|---|---|---|
| 简单任务也跑全流程 | 分档表存在但被三条 ALL-CAPS 不变式压过；缺 T1「主会话自己规划」档；判据是形容词不是数字 | 重写分档为 T0/T1/T2 + **惰性升级**；把"默认最小档"写成不变式；插件层加"档位声明"闸门 |
| review 揪小概率/文档问题，3 轮跑满不 approve | reviewer 无 severity/confidence/触发条件要求；编排协议禁止主会话判断，全部 issue 原样交 impl；终止条件只有轮数 | **reviewer 必须分级出证**；主会话按**策略**（不是口味）裁决；加入收敛判据与"无 blocker 即可收尾" |
| 派发与回执都是纯文本 | 所有输入字段 `type:string` 拼成一段 Markdown 落盘；子代理回执是自由文本，父代理只能"读" | 输入改 JSON Schema 嵌套对象；子代理回执走**窄工具 `pipeline_submit`**（调用点校验）+ 围栏解析兜底，父代理经 `pipeline_result` 拿结构化对象 |

预期收益：**简单任务的 token 消耗降到现在的 ~1/3 以下**（完全不起子代理）；中等任务少一个 plan 子代理；
复杂任务的 review 循环从"最多 3 轮无条件重跑"变成"最多 3 轮且有收敛判据"，并让每轮的 issue 数量与修复面显著下降。

---

## 1. 现状诊断（代码证据）

### 1.1 分档表已经存在，但被更强的规则推翻

`preset/code-pipeline/agent.cordis.yml` 已经有分档（L136–142）：

- L136 **Trivial** — typo / 版本号 / 一行文档 → 主会话自己做
- L137 **Small** — ≤2 文件 **且"用户观察不到行为变化"** → 一个 `subagent_impl`，无 review
- L138 **Documentation-only** — 一份文档 → 一个 `subagent_impl`
- L139 **Standard** — 单子系统多文件行为变更 → plan → gate → impl → review
- L140 **Large** — 多子系统 → 完整流程
- L142 「拿不准就往小一档」

**但:**

1. **L126 明确否定了 L136**：`**After the plan is approved, delegate implementation to `subagent_impl` — never implement an approved plan yourself.** ... every planned change (even a trivial one) goes through the impl stage`。
   → "简单任务自己做"只在**没有 plan**时成立；一旦主会话顺手写了计划，就触发 impl 阶段。
2. **L128 禁止主会话做任何判断**：`Never review a change set yourself ... Never fix review issues yourself`。这两条在语义上把"分档"降级成了建议，而在**结构上**使下述 review 裁决方案不可能——必须先改这两条。
3. **L137 的"用户观察不到行为变化"** 把范围压得极窄：一个 2 文件的行为 bugfix 不满足 Small，直接落到 Standard（全流程）。
4. **没有 T1 档**："主会话自己规划 + impl→review"这个中间形态**不存在**——Small 是无 plan 的 impl，Standard 是"派 plan 子代理"。用户要的中间档恰好掉进缝里。
5. **判据不可数**：L132 用"几秒到一分钟"（事后才知道）、L137 用"roughly ≤2 files"（唯一硬指标）。

### 1.2 评审：无分级、无触发条件、无收敛判据

reviewer persona（`lib/index.js:69`）：

> `Your reply MUST start with exactly "APPROVED" or "CHANGES REQUIRED:" followed by a numbered issue list; each issue names the file path, the problem, and a suggested fix. Never approve with unresolved material defects.`

问题：
- **"material defects" 没有定义**，模型只能自己拿捏 → 保守起见一律 CHANGES REQUIRED。
- issue 只有"文件 + 问题 + 建议修法"，**没有 severity / confidence / 触发条件 / 是否本次引入 / 是否 blocking**。
- 没有任何"不要报你无法给出触发路径的问题""文档/风格问题不得 blocking"的约束。

impl persona（`lib/index.js:68`）：`when a numbered review-issue list is included, fix those issues` → **全量修**。

编排循环（L191）：

> `while the verdict is CHANGES REQUIRED and fewer than 3 review rounds have run: continue every affected workstream's SAME implementer with ... that workstream's own numbered issue list`

→ 只要 reviewer 每轮再提一条，就必然跑满 3 轮，然后按 L198–202 的「续/拆/停」收场，**永远看不到 APPROVED**。这正是用户观察到的现象。

更糟的是：**这个"3 轮上限"本身没有被任何机制执行**。插件不记 review 轮次（看门狗管的是墙钟），也不解析 `CHANGES REQUIRED:`——"最多 3 轮"和"APPROVED / CHANGES REQUIRED"一样，全靠模型自觉对齐自由文本。没有硬计数，也就没有"到轮必停"的保证。

### 1.3 I/O 全是文本

- 输入字段：`STAGE_INPUTS`（`lib/index.js:75-92`）全部是 `{type:"string"}`，在 `materializeDispatchMessage`（:170-189）里拼成 `**key**\nvalue` 的 Markdown，落一个 `.txt` 临时文件。
- 输出：阶段工具只返回 `{kind:'continuable', subagentId}`（:796-812）；子代理的**最终回复**通过宿主 settled notice 以自由文本进入主会话。
- 结果：`## Workstreams` 表、"APPROVED / CHANGES REQUIRED + 编号 issue" 这些**本来天然是结构化数据**的东西，全靠模型在文本里对齐格式；主会话想用它就得**再生成一遍**（把表格抄进 impl 的 prompt），既花 token 又易丢字段。

### 1.4 已有的可用底座（不用重造）

- 宿主 `subagent/end` 事件带 `lastAssistantMessage?: ContentBlock[]`（`packages/subagent/subagent/src/types.ts:116`），插件**已经**在监听它维护账本（`lib/index.js:2085`）→ 解析结构化回执是**顺手的事**。
- 只读阶段的工具面是 `READ_ONLY_TOOLS`（`lib/index.js:40-47` = read / read_image / glob / grep / web_search / ask_user_question）——**没有 write**。所以 plan/review 的机读结果**只能随最终回复回来**，不能"写个文件给父代理读"；这直接决定了 §5.2 的做法。
- 宿主工具的 JSON Schema 子集支持嵌套 `object` / `array` / `enum` / `const` / `additionalProperties:false`（`packages/core/tools/src/json-schema.ts:31-56`），且会生成对应 TS 类型（`ts-types.ts` 的 object/array frame）→ 结构化参数在 Code Mode 里直接是带类型的对象；但**明确拒绝** `$ref` / `pattern` / `min/max` / `format` / `anyOf` / `allOf` / `not`（`JsonSchemaError`）→ 所有新 schema 必须落在这个子集内。
- 插件已有「prompt 协议 + 插件层硬闸门」的成熟范式（并发/创建上限、墙钟），新增闸门有现成的实现位置与文案风格。

---

## 2. 研究依据

> **先说结论与不确定性**：三个方向都有可观的证据，但**没有任何 RCT 直接比较"自己做 / 单写者+评审 / 全流程"在真实编码工作上的差异**，**也没有研究给出"多少行代码该升级"的数值阈值**。下面把支持证据、反证和不确定性一并列出；§3.1 的阈值是**设计推断**，不是研究结论。

### 2.1 多智能体 vs 单智能体（决定分档）

**支持"默认最小档"：**

- Anthropic《Building effective agents》：**先用最简单的方案，只有证明更复杂确实更好时才加复杂度**；evaluator-optimizer 仅在"有明确评价标准 + 迭代确实有收益"时推荐。
- Anthropic 多智能体研究系统：子代理 **~4× token**、多智能体 **~15× token**（相对 chat）；并明确指出 **"多数编码任务真正可并行的部分远少于研究任务，而 LLM 目前不擅长实时协调和委派"**。
- **Agentless**（FSE 2025）：两/三阶段固定流水线在 SWE-bench Lite 上 **27.33% @ $0.34 → 32.00% @ $0.70**，同时期开源 agent 中性能最高、成本最低。
- 强单智能体基线（2026）：跨 7 个 benchmark，**单智能体可追平"同构"多智能体工作流，并额外获得 KV cache 复用的效率优势**。
- 长上下文不靠脚手架（2025）：把整个环境交给长上下文模型，38% SWE-bench Verified，**与精调脚手架（32%）相当**。

**支持"单写者 + 干净上下文的验证者"——这正是本插件 T1 的形态：**

- Cognition《Don't Build Multi-Agents》：并行写手各自做隐式决策 → 结果互相不一致；**默认应单线程线性**。
- Cognition 2026 复盘《Multi-Agents: What's Actually Working》：多智能体**只在"写入保持单线程、额外智能体只贡献智力而不是动作"时才成立**；Devin Review 在 Devin 自己写的 PR 上约 **2 bugs/PR，其中 58% 属严重**；并且**评审者与写者不共享上下文时效果最好**（干净上下文强制从实现往回推理）；同时明确警告评审循环**"会一轮轮找出新 bug——这并不总是好事，可能拖很久"**。
- Adversarial Review（ICML 2026）：**3 个智能体（coder + reviewer + critic）的最小协议优于 5 个**，智能体数量增加收益递减；并暴露"伪共识"失效模式（智能体在证据不足时趋于一致）。

**反证与不确定性（必须一起读）：**

- **没有** RCT 比较三种档位在真实编码工作上的净收益；最强证据是 benchmark + 厂商部署自述（Devin 的 2 bugs/PR 与 58% 是**厂商自报，无对照组**）。
- 2026 有工作主张 **agent benchmark 的差异主要来自 harness 而非模型**（"Binding Constraint Thesis"），即"多几个 agent"的收益可能只是脚手架效应。
- **不存在**"多少行 / 多少文件该升级"的数值阈值；§3.1 的阈值是设计推断。
- METR 2025"AI 让熟练开发者慢 19%"的结论，作者已于 2026-02 声明**过时且证据很弱**（选择偏差、报酬下调、并发干扰），**不要引用**。

### 2.2 评审质量与循环收敛（决定 triage 与终止条件）

**LLM review 的真实命中率不高，但可调：**

- Google AutoCommenter：有用率初始 **54%**（独立评分 60%），目标 80%；**抑制 17 类不可执行的 best-practice 建议后升到 66% / 74%**。其官方 nitpick 例子正是："给代码注释补句号——技术上正确，但让作者回 IDE 改一遍是净负价值"。
- CodeRabbit 线上 31,073 组反馈：**56.3% 被拒**，拒绝集中在**误报、冗余、超范围、与意图不符**；且"是否会被拒"可用轻量分类器以 **76% F1** 预测——低价值 finding 是**可学习、可预测的**。
- Kodus 180,739 条建议：**33.2% 变成代码**；OpenAI 自家 reviewer **52.7%** 被采纳，并明确**以 precision 优先于 recall**（宁可少报，不可误报）。

**"循环不收敛"是有机制的，不是玄学：**

- ICLR 2026 代码生成迭代精修研究：Self-Refine **不能稳定提升 Pass@1，反而常因"评论者给正确代码编造缺陷 → 作者引入回归"而下降**；且**换更小/更便宜的评论者会更糟**，过度精修让**总成本更高**。
- Mirror Loop（2025）：无外部依据的自我批判，信息量从早期到后期**衰减 55%**；在第 3 轮注入一次**有依据的验证**，信息量**回升 28%**。
- 自我评审坍塌（2026）：AI 自评门会滑入**"盖章模式：接受分数上升、而正确率下降"**。
- 修复循环**在第 3–4 轮收益饱和**（代码生成/测试生成/翻译均如此）；CriticGPT：模型批评在 **63%** 的情况下优于人类批评，**但会幻觉出不存在的 bug**，人机组合幻觉更少。
- 结构化与分级先例：reviewdog 把**报告级别与失败级别分离**（`-level` vs `-fail-level`，默认 `none` 即有问题也退出 0；且默认只看**新增/修改行**）；Microsoft hve-core 用 `verdict: approve | approve_with_comments | request_changes` + `severity_counts` + `findings[]` + `out_of_scope_observations`。

### 2.3 结构化 I/O 与上下文工程（决定交互格式）

- **程序化状态抽象**在同等 token 下把回报提升 **最高 +76%**（相对原始观测）；而**在层级里增加 deliberation 反而更差：最高 3.4× 更差、token 多 1.8–2.7 倍**（"deliberation cascade"）→ **"结构化"比"多审一层"划算**。
- **约束解码只保证语法，不保证正确**：接近容量上限的模型掉 **28–36 个百分点**，惩罚随 schema 复杂度上升；但**"先推理、后格式化"能挽回 80–87%**。
- **子代理只应回传蒸馏结果**（典型 1,000–2,000 token），探索过程留在它自己的窗口里。
- **交接包需要四件事**：目标、输出格式、工具/来源指引、清晰的任务边界；一句话任务会导致重复劳动与缺口。
- **前缀缓存是字节级的**：稳定前缀可省最多 **90%** 成本、延迟 >2×；前缀改一个字节，后面全部失效。
- **不要把模型写的 unified diff 当补丁执行**：宽松打补丁会**静默错打 14–20%** 且无错误信号。
- 顺序影响注意力：目标/约束放开头，最不关键的材料放中间（"lost in the middle"）；上下文随长度**退化**（"context rot"）。

### 2.4 引用清单

多智能体：`anthropic.com/engineering/building-effective-agents` · `anthropic.com/engineering/multi-agent-research-system` · `cognition.com/blog/dont-build-multi-agents` · `cognition.com/blog/multi-agents-working` · arXiv 2505.08120 · arXiv 2407.01489（Agentless，FSE 2025）· arXiv 2601.12307 · arXiv 2605.23950 · arXiv 2405.15793（SWE-agent）· arXiv 2402.01030（CodeAct）· arXiv 2608.18167（Adversarial Review）· arXiv 2408.03314 · arXiv 2412.21187 · arXiv 2406.18665（RouteLLM）· `scale.com/blog/swe-bench-pro` · `metr.org/blog/2026-02-24-uplift-update`

评审：arXiv 2405.13565（Google AutoCommenter）· arXiv 2607.03316（CodeRabbit）· `kodus.io/data` · ZenML LLMOps DB（OpenAI GPT-5-Codex reviewer / cubic）· arXiv 2607.05197（3–4 轮饱和）· arXiv 2609.10123（伪 bug 修复震荡）· arXiv 2604.06996（自评偏见）· arXiv 2407.00215（CriticGPT）· arXiv 2508.18771 · arXiv 2608.21311 · ICLR 2026 迭代精修 · arXiv 2510.21861（Mirror Loop）· arXiv 2606.28438（自评坍塌）· `github.com/reviewdog/reviewdog` · `github.com/microsoft/hve-core`

结构化 I/O：arXiv 2606.09410（约束解码容量代价）· arXiv 2605.16205（结构化状态 +76% / deliberation cascade）· arXiv 2609.00227（unified diff 不安全）· arXiv 2510.12487（Diff-XYZ）· arXiv 2605.29676（TRON/TOON）· arXiv 2605.06365（artifact DAG）· arXiv 2307.03172（lost in the middle）· `trychroma.com/research/context-rot` · `anthropic.com/engineering/effective-context-engineering-for-ai-agents` · `anthropic.com/engineering/effective-harnesses-for-long-running-agents` · `platform.claude.com/cookbook/misc-prompt-caching` · A2A / MCP / ACP 规范

## 3. 方案 A：按复杂度分档（T0 / T1 / T2）

### 3.1 分档定义（可数判据）

| 档 | 判据（满足任一即落档） | 流程 | 谁来做 |
|---|---|---|---|
| **T0 主会话直接做** | 净变更 ≤ ~60 行；触及 ≤2 文件；文档/注释/配置/重命名/格式化/机械替换；改动点唯一且无需设计决策 | 无阶段 | 主会话 `run_code` 自己写 |
| **T1 主会话规划 + impl→review** | 3–8 文件，或 ~60–500 行；单子系统内的行为变更；设计决策已由需求唯一确定 | 主会话把计划写进 `plan` 字段 → `subagent_impl` → `subagent_review` | 主会话规划，阶段执行+评审 |
| **T2 完整流程** | >~8 文件或 >~500 行；跨子系统；公共 API / schema / 持久化格式变更；需求有歧义、需要先调研；并发/安全/数据丢失敏感；用户明确要方案 | `subagent_plan` → 人工 gate → impl ↔ review | 全阶段 |

### 3.1.1 研究支撑，以及它的边界

**支撑：**

- **T0 是默认档**：Anthropic 明确"先用最简单的方案，只有证明更复杂确实更好时才加"；**Agentless** 用固定两/三阶段流水线就拿到当时开源 agent 的最高分且成本最低；2026 的强基线工作显示**单智能体可追平"同构"多智能体工作流，还多出 KV cache 复用的效率优势**；把环境整体交给长上下文模型（38%）也与精调脚手架（32%）相当。
- **T1 是证据最好的多智能体形态**：Cognition 2026 的结论是"**写入保持单线程、额外智能体只贡献智力而不是动作**"，且**评审者与写者不共享上下文时效果最好**——这正是 T1（主会话规划 + 独立 impl + 独立 review），也说明本插件"评审是独立子代理、不共享上下文"的设计是对的。Devin Review 自报约 2 bugs/PR、58% 属严重（**厂商自报、无对照组**）。
- **T2 要满足四个前置条件才值得**（研究对"何时该多智能体"的总结）：① ≥2 个**真正独立**的工作流且文件所有权不重叠；② 每个工作流有**机器可校验**的验收标准；③ 任务价值配得上 **~15× token**（Anthropic 实测多智能体约为 chat 的 15 倍）；④ 上下文**超过一个窗口**。
- **不要升级的情形**：工作强耦合、一个智能体已握有完整上下文、或者**没有可验证信号**。

**边界（必须承认）：**

- 不存在"多少行该升级"的研究阈值；没有 RCT 比较三个档位的净收益；有 2026 的工作主张 agent benchmark 的差异主要来自 **harness 而非模型**。所以 §3.1 的数字是**工程默认值，应当按你自己的数据调**（§8 给了度量方法）。
- 研究里也**没有公认的循环停止判据**；§4.3 的"本轮不产生新的可验证缺陷就停"是**设计推断**，不是有证据的阈值。

### 3.1.2 关于并行写：把现有立场调过来

现在 persona L146–148 写的是"**Parallel dispatch is the preferred choice, not a last resort**"。研究对"并行**写**"是**反对**的：

- Cognition：并行写手各自做隐式决策（风格、边界情况），彼此看不见 → 结果不一致（原文 Flappy Bird 例）。
- Anthropic：编码任务真正可并行的部分远少于研究任务，且 LLM 目前不擅长实时协调与委派。
- Adversarial Review：**3 个智能体的最小协议优于 5 个**，智能体数量增加收益递减；还暴露"伪共识"失效模式。

**建议改成**：并行只用于**读取 / 分析 / 评审**这类"只贡献智力"的工作；**并行写**只在满足 §3.1 T2 那四个前置条件时才用（真正独立 + 文件不重叠 + 各自可机器校验 + 价值够高），否则**串行**。`Promise.all` 的派发能力保留，但默认语气从"首选"改成"**例外，需先证明独立性**"。

配套规则（替换 L132–142）：

1. **默认 T0**。上表是**升级依据**，不是"选择菜单"——没有命中 T1/T2 判据就必须自己做完。
2. **惰性升级（lazy escalation）**：从 T0 开始做，一旦出现以下**触发条件**才升级，不预判整件事：
   - 动手后发现要改第 3 个文件，或净变更超过 ~60 行 → 升级到 T1（把已经想清楚的做法写进 `plan`）。
   - 出现需求歧义 / 需要跨子系统设计 / 公共接口变更 → 升级到 T2。
   - 用户明确要求"先给方案/先评审" → 直接 T2。
   - 升级是**单向**的，且必须用 `todo_write` 记录升级原因（可审计）。
3. **降级也允许**：T2 的 plan 如果结论是"就是个小改动"，允许跳过 impl/review 直接在主会话做完，并在报告里说明。
4. **T0 的边界**：T0 **不是**"绕过验证"。T0 完成后主会话必须自己跑可用的测试/构建（这是主会话本来就有的能力），只是不需要第二个模型来"审"。

### 3.2 必须同时改掉的三条不变式

只加表格不改这三条，模型仍会按旧习惯走：

| 位置 | 现在 | 改成 |
|---|---|---|
| L126 | `never implement an approved plan yourself ... every planned change (even a trivial one) goes through the impl stage` | `T0 work is NOT a planned change: if you judged the task T0, you implement it yourself. The impl stage exists for T1/T2 change sets.` |
| L128 | `Never review a change set yourself ... Never fix review issues yourself` | 拆成两句：**verdict 仍只能由 `subagent_review` 给出**（保留角色边界）；但**裁决（triage）由主会话做**——主会话按 §4.2 的**白名单策略**决定哪些 issue 进 impl，不得添加自己的判断，也不需要自己修。（这样既满足用户诉求，又不破坏"reviewer 拥有 verdict"的设计） |
| L137 | Small 仍派 `subagent_impl` | 删除 Small / Documentation-only 两档，并入 T0/T1 |

### 3.3 插件层机制（可选，但建议做——这是"不止是 prompt"的关键）

用户现有配置（`~/.dsh/settings.yaml`）默认 `maxConcurrency=0`（不限），说明**目前没有任何机制阻止小任务起子代理**。建议加一道轻闸门：

- 新增工具 `pipeline_tier({ tier: 'T0'|'T1'|'T2', reason: string })`：主代理**在第一次阶段派发前**必须声明档位；插件把档位记进会话账本，并：
  - `T0` + 任何阶段派发 → 拒绝，错误文案要求"要么按 T0 自己做，要么用 pipeline_tier 明确升级并说明触发条件"。
  - `T1` + `subagent_plan` → 拒绝（"T1 的计划由主会话自己写；要派 plan 就升到 T2"）。这条**直接强制**出用户想要的中间档。
  - `T2` → 放行全部。
- 档位与升级原因写进 `/dsh-code-pipeline/status`，设置页可见。
- 成本可控：档位是会话级的，不是每次派发都问。

> 为什么要机制：本插件已有的成功经验就是"prompt 协议 + 插件层硬上限"（并发/创建上限）。纯 prompt 的分档已经被证明会被更强的 ALL-CAPS 规则压过。

---

## 4. 方案 B：评审结论分级 + 主会话裁决

> 研究依据（详见 §2）：
> - LLM review 的**真实采纳率只有约 1/3**：CodeRabbit 31,073 组线上反馈里 **56.3% 被拒**（主因：误报、冗余、超范围、与开发者意图不符）；Kodus 180,739 条建议 **33.2% 变成代码**；OpenAI 自家 reviewer **52.7%** 被采纳。
> - 主流产品的"有用率"是**可调的**：Google AutoCommenter 初始 **54%**，抑制 17 类不可执行的 best-practice 建议后升到 **66%/74%**；其官方举例正是"给代码注释补句号——技术上正确，但让作者回 IDE 改一遍是净负价值"。
> - **修复循环在第 3–4 轮收益饱和**，且存在"程序本来没 bug，却反复加/删同一处改动"的**伪 bug 修复震荡**。
> - 结构化的"advisory vs blocking"分离是成熟做法（reviewdog 的 `-level` 报告 vs `-fail-level` 默认 none 才失败）；Microsoft hve-core 已有 `verdict: approve | approve_with_comments | request_changes` + `severity_counts` + `findings[]` + `out_of_scope_observations` 的 JSON 先例。

### 4.1 reviewer 必须产出结构化 findings

review 回执的机读 envelope（与 §5.2 同一通道）：

```json
{
  "kind": "review",
  "verdict": "approve | approve_with_comments | request_changes",
  "reviewScope": ["src/a.ts", "src/b.ts"],
  "severityCounts": { "critical": 0, "high": 1, "medium": 2, "low": 0 },
  "blockingCount": 1,
  "issues": [
    {
      "id": "R1",
      "severity": "critical | high | medium | low",
      "blocking": true,
      "category": "correctness | security | data-loss | breaking-change | concurrency | perf | test-gap | docs | style",
      "confidence": 0.9,
      "onChangedLines": true,
      "file": "src/foo.ts",
      "lines": "42-47",
      "problem": "what is wrong",
      "failureScenario": "the concrete input/state and the wrong outcome it produces",
      "evidence": "quoted code + the call path that reaches it",
      "suggestedFix": "a minimal, checkable change (or null + a question)",
      "objectiveCheck": "the test / type-check / static rule that would confirm it"
    }
  ],
  "outOfScope": [{ "id": "O1", "file": "…", "note": "…" }],
  "summary": "one paragraph"
}
```

reviewer persona 新增硬约束（改写 `lib/index.js:69`）：

1. 每条 issue **必填** `severity / blocking / category / confidence / onChangedLines / file / lines / problem / failureScenario / evidence / suggestedFix / objectiveCheck`。
2. **`failureScenario` 写不出来（说不出具体输入/状态与错误后果）的问题，一律 `blocking:false`，并倾向于放进 `outOfScope`。** 禁止"Consider…""this could be…"式表达。这一条直接压掉用户抱怨的"几乎不可能发生的小概率问题"。
3. `category ∈ {docs, style}` **不得 blocking**（文档/风格影响可读性，不影响正确性）。
4. **不在本次改动行上的问题（`onChangedLines:false`）不得 blocking**，放进 `outOfScope`（对应 reviewdog 的 `-filter-mode=added`）。
5. `blocking:true` 仅允许 `severity ∈ {critical, high}` 且 `confidence ≥ 0.8` 且能给出 `objectiveCheck`。
6. **每轮 blocking 上限 5 条**（超出按 severity/confidence 截断），总量上限 10 条，按 severity 降序——"少而扎实"严格优于"多而杂"。
7. verdict 规则改为**可执行**：存在 blocking → `request_changes`；无 blocking 但有非 blocking findings → `approve_with_comments`；都没有 → `approve`。（取代"Never approve with unresolved material defects"这种无法执行的措辞。）
8. anti-nitpick：`Do not pad the list. Fewer, well-evidenced findings are strictly better. Never raise a finding you cannot give a failure scenario for.`

### 4.2 主会话裁决策略（白名单 + 拒绝理由留痕）

主会话**不重新判断 severity**（那会引入第二个偏见，且研究显示 rubric 下自评偏见 >50%），只做**机械过滤 + 记录**：

```
送 impl 的 issue = blocking == true
                  且 severity ∈ {critical, high}
                  且 confidence >= 0.8
                  且 onChangedLines == true
其余 → 进 deferred 清单，每条记录：
       id / severity / category / 一句话原问题 /
       rejectionReason ∈ { false-positive | redundant | out-of-scope |
                           intent-misalignment | not-actionable | deferred-by-policy }
```

- **拒绝理由必须留痕**（CodeRabbit 的拒绝分类法）。它既是审计线索，也是将来调优 reviewer 的训练信号；没有它，同一个 nit 会每轮重复出现。
- 过滤在**主会话的 run_code 程序里**完成（§5.2 的 `pipeline_result` 直接返回结构化对象），不靠模型逐条"读文本再决定"。
- **客观信号优先**：有测试/类型检查/lint 可跑时先跑它们；**绝不让 LLM 意见推翻绿灯的客观信号**，也绝不因为 LLM 说"可能有问题"就跳过客观验证。
- 主会话**不得**把被过滤掉的 issue 塞回 impl，也不得自己动手修（保留 L128"不自己修"）。
- **无 blocking 即可收尾**：过滤后集合为空 → 立刻收尾（无论 verdict 是 `request_changes` 还是 `approve_with_comments`），报告里列出 deferred 清单与理由。**终止条件从"reviewer 满意"改成"没有必须修的问题"**——这是打破"3 轮跑满"的关键。

### 4.3 收敛与终止条件

把 L191 的 `while ... fewer than 3 review rounds` 换成：

1. 每轮 review 后做 §4.2 过滤；**过滤后为空 → 结束**。
2. **复验（re-verify）不要用开放式"再评审一遍"**——那正是诱发"编造新 bug"和震荡的原因。修正后给 reviewer 一个**封闭问题**：`Are findings #1..#n resolved? Answer yes/no per finding, with evidence. Do not open new findings.`
3. **无进展检测**：出现任一情况立即停止自动循环，转「续 / 拆 / 停」由用户决策——
   - 某轮的 blocking 数**没有严格下降**；
   - **同一个 `id` / `(file,category,failureScenario)` 在修过之后再次出现**（伪 bug 修复震荡：同一处改动反复加删）；
   - diff 增量为空。
4. **要求单调收敛**：每轮必须 `blocking_after < blocking_before`，否则停。reviewer 不得为了继续对话而"再找一条"。
5. **客观门收尾**：测试/类型检查/lint 全绿 **且**所有 blocking 已被修复或"带理由驳回" → 循环结束；advisory/nit 永远不延长循环。
6. 硬上限仍是 3 轮（研究里 3–4 轮是收益拐点），但它不再是"必然发生"，只是保险丝。

## 5. 方案 C：结构化 I/O

> 研究依据（详见 §2.3）：
> - **程序化状态抽象**在同等 token 下把回报提升**最高 +76%**（对比原始观测）；而"在层级里加更多 deliberation"会让表现变差**最高 3.4 倍、token 却多 1.8–2.7 倍**（"deliberation cascade"）——**结构化比"多审一层"划算**。
> - **约束解码只保证语法，不保证正确**，而且**有容量代价**：接近容量上限的模型掉 **28–36 个百分点**，惩罚随 schema 复杂度上升；但「**先推理、后格式化**」能挽回 **80–87%** 的损失。
> - **子代理应当只回传蒸馏结果**（典型 1,000–2,000 token），探索过程留在它自己的窗口里。
> - **前缀缓存是字节级的**：稳定前缀可省最多 **90%** 成本、延迟减半；前缀里改一个字节，后面全部失效。
> - **不要把"模型写的 unified diff"当成可执行补丁**：宽松打补丁会**静默错打 14–20%** 且无错误信号（这是整条链路里风险最高的交接）。
> - 交接包需要四件事：**目标、输出格式、工具与来源指引、清晰的任务边界**；一句话任务会让子代理互相重复、留缺口。

### 5.1 派发请求：typed task packet（不是一段 prompt）

把 `STAGE_INPUTS`（`lib/index.js:75-92`）从 `string` 改成 JSON Schema 嵌套对象，并在 `materializeDispatchMessage`（:170-189）里序列化成**一个 JSON 文件**（而非拼接 Markdown），子代理仍用 `read` 读它：

```jsonc
// 每个阶段的 task packet 公共骨架
{
  "objective": "one sentence: what done looks like",
  "acceptanceCriteria": ["checkable statement", "…"],   // 必填且非空
  "ownedPaths": ["src/a.ts", "src/b/**"],                // 该子代理唯一可写的路径集合
  "nonGoals": ["…"],                                     // 明确不做什么（防止擅自扩范围）
  "dependsOn": ["plan", "impl"],                         // 它需要先看到谁的结果
  "context": ["…"],                                      // 背景，非目标
  "requiredOutput": { /* §5.2 的 envelope schema */ },    // 回执契约随请求下发
  "toolGuidance": "read-only: 用 grep/glob 定位，不要猜测",
  "budget": { "wallClockMinutes": 20 }
}
```

- **派发前做确定性校验**（编排者校验，不是模型自觉）：`acceptanceCriteria` 非空；同一次并行派发里 `ownedPaths` **互不重叠**（这一条现在只是 persona 里的散文规则，可以变成硬拒绝）；`requiredOutput` 必须是宿主 schema 子集内的合法 schema。
- **不要把整个世界塞进 packet**：大块材料（diff、plan 全文）继续走"落盘 + 指针"，让子代理按需 `read`（这正是现在 `spillAllFields` 做的事，只是内容从 Markdown 变成 JSON）。
- **packet 只约束形状，不规定推理过程**——不要写"先想 A 再想 B"；研究显示额外的 deliberation 指令会拖慢并降低质量。

### 5.2 子代理回执：结构化 envelope

三个阶段各自一个 `kind` 判别的 envelope：

- `plan`：`{kind:"plan", goal, successCriteria[], workstreams[{id,goal,files[],dependsOn[],acceptance,parallelizable}], changes[{path,what}], risks[], assumptions[], openQuestions[]}`
- `impl`：`{kind:"impl", files[{path,change,added,removed,hash?}], deviations[], verification[{command,exitCode,outputSummary}], blockers[], summary}`
- `review`：§4.1 的 `{verdict, reviewScope[], severityCounts, blockingCount, issues[], outOfScope[], summary}`

**三条硬约束（有研究支撑）：**

1. **先给人类可读的 Markdown，再给一个 `json` 代码围栏的 envelope**（"think first, format later"）。人类可读部分继续用于 UI 展示与 plan 的人工 gate；envelope 只承载可执行结论，**总长控制在 ~1–2k token**。
2. **schema 保持浅**：必需字段少、避免深层嵌套与超长 enum。约束解码有容量代价，而且 review 阶段用的往往是更便宜/更小的模型。
3. **失败不阻塞**：解析/校验失败时回退为 `{parsed:false, reason, raw}` 并 `ctx.logger.warn`，绝不静默丢内容。

**回执通道（推荐：提交工具为主，解析为兜底）**：插件给阶段子代理注入一个窄工具 `pipeline_submit({ envelope })`，**在调用点**按该阶段 schema 校验——不合格立刻打回、子代理可以当场改，因此**不存在"事后解析失败"**。子代理仍照常给出人类可读的 Markdown 回复（供 UI 与人工 gate）。兜底通道保留：插件在 `subagent/end`（`lib/index.js:2085`，payload 已带 `lastAssistantMessage`）里抽最后一个 `json` 围栏解析，两者写入同一个 `dispatched.get(childId).result`。

```ts
const r = await tools.pipeline_result({ child: reviewId });
const toFix = (r.parsed ? r.result.issues : []).filter(i =>
  i.blocking && i.confidence >= 0.8 && i.onChangedLines &&
  (i.severity === 'critical' || i.severity === 'high'));
if (toFix.length === 0) { /* §4.2 收尾，附 deferred 清单 */ }
else await tools.pipeline_followup({ child: implId, issues: toFix, message: '…' });
```

**为什么不再把"解析最终回复"作为主通道**：文本围栏解析是**事后**的——格式错了只能整轮重来；而提交工具的 schema 校验是**调用时**的，错一次改一次。若两者都实现，`pipeline_result` 的返回里带 `source: "submit" | "parsed"`，便于观测哪条通道在起作用。

### 5.3 `pipeline_followup` 也结构化

现在只接受 `message: string`（`lib/index.js:1752-1770`）。加两个可选字段：

- `issues?: <§4.1 的 issue 数组>`（复验轮只传"待复验的 id 列表"）
- `changeSet?: {files, diff}`

插件负责把结构化字段渲染成子代理可读文本（`message` 保持向后兼容）。收益：主代理把过滤后的 issue 数组**原样传递**，不再"抄一遍"——既不丢字段，也不会在抄写时加戏。

**复验要封闭**：修正后不要发"再评审一遍"，而是发 §4.3 的封闭问题（"#1..#n 是否已解决？逐条 yes/no + 证据；**不要开新 finding**"）。

### 5.4 缓存与上下文卫生

1. **冻结前缀**：system prompt / persona / 工具 schema 在多次派发间必须**字节不变**；packet 里把**目标与约束放最前**、把变动内容（changeSet、issues）放最后，这样同一任务的后续轮次能命中前缀缓存（研究：最多省 90% 成本、延迟减半；反过来前缀里改一个字节就全废）。
2. **顺序照顾注意力**：目标/约束放开头，最不关键的材料放中间（长上下文中段最不可靠）。
3. **按构造隔离**：每个阶段自己的窗口；跨阶段只回传蒸馏后的 envelope，**绝不把某个子代理的 transcript 粘给另一个**。
4. **变更集只送增量**：沿用现有"按轮次快照 + delta"的规则（persona P:252 已有），结构化后可以让 `changeSet` 字段本身也只放本轮 hunk。
5. **不要新增"打补丁"环节**：review 保持只读，diff 是**证据**不是待执行补丁。若将来要做"确定性应用修改"，必须走"结构化编辑意图 + 确定性 applier"，**绝不能**把模型写的 unified diff 直接 `patch`（研究表明宽松打补丁会静默错打 14–20% 且无报错）。
6. **工具返回形状要省 token**：`pipeline_result` 只返回结构化字段 + 必要的截断/落盘指针，不要回吐整段原始文本。

### 5.5 关于给 plan / review 加 `write` 权限

**结论：加"能回传结构化结果"的能力值得，加通用 `write` 不值得。** 建议用 §5.2 的窄工具 `pipeline_submit`，而不是把 `write` 放进只读白名单。

理由：

1. **角色边界是结构性的，不只是文案。** 今天 `plan` / `review` 的 persona 明确写着 "You have no write tools by design"，而且 review 的整个前提是"**它拿到的变更集是数据**"（所以不需要 shell、也不需要写）。一旦给了 `write`，模型就有能力"顺手把问题改了"——而研究里最典型的失效模式恰恰是"评论者给**正确**代码编造缺陷 → 作者引入回归"；让评论者自己动手只会放大它。
2. **`write` 并不能让 review 变强。** review 真正缺的是**客观信号**（跑测试、类型检查——那是 shell/执行，不是 write）。插件刻意不给 review shell（所以它只看 diff、成本更低）。给 `write` 只增加它**改文件**的能力，不增加它**验证**的能力。
3. **通用 `write` 无法限定路径。** 宿主的 `toolFilter` 只有 allow/deny **工具名**名单（`childCtx.tools.restrict(composition.toolFilter)`，`packages/subagent/subagent/src/child-agent.ts:218`），**没有路径级约束**。给了 `write` 就等于把整个工作区交给它。
4. **窄工具能做到 `write` 做不到的**：schema 在**调用点**校验、结果直接进账本、不需要约定路径、不污染工作区。

**可行性已核实（实施细节）：**

- **注入机制现成**：插件现在就是用 `agent.ctx.get("tools").register(...)` 给 root 注入阶段工具（`lib/index.js:2019-2023`）；`agent/created` 对子代理同样触发（插件的 `isRootAgent` 过滤恰恰说明这一点），所以给阶段子代理注入是同一套机制。
- **白名单**：只读阶段通过 `toolFilter: { allow: READ_ONLY_TOOLS }` 限制（`lib/index.js:40-47`），把 `pipeline_submit` 加进这个数组即可；子代理 `descriptor` 会**持久化** toolFilter，冷恢复也带得上。
- **必须保留兜底通道**：重启前创建的旧子代理，其持久化 toolFilter 里没有 `pipeline_submit` → 它不会调用提交工具，自动走 §5.2 的围栏解析。
- **唯一需要留意的实现点**：子代理 `agent/created` 与 `tools.restrict` 的**先后顺序**——`restrict` 是白名单，工具必须**已注册且在白名单内**才可见；实现时要确保注册发生在子代理首个回合之前。实现时先写一条单测锁住这个顺序。

**如果你确实想给 `write`**：唯一我认为可接受的形态是"**只允许写到 `$TMPDIR/dsh-code-pipeline/` 的结果文件**"。但当前宿主 `toolFilter` 不支持路径级限制，需要先改宿主；相比直接加窄工具，收益相同而成本高得多，**不建议**。


## 6. 落地路线图（三阶段，每阶段可独立发布）

**阶段 1 · 协议与 persona（不改插件代码，收益最大、风险最低，应最先做）**

1. 分档重写：L126 / L128 / L132–142 → T0/T1/T2 + 惰性升级（§3.1、§3.2）；删除 Small / Documentation-only 两档。
2. reviewer persona（`lib/index.js:69`）→ §4.1 的字段契约 + 硬约束 + anti-nitpick + 可执行 verdict。
3. 循环与终止（L191 / L198–202 / L284）→ §4.3 的收敛判据与**封闭复验**。
4. 三阶段工具 description 同步：impl 的 `fix those issues` → `fix the ISSUES LIST GIVEN (already triaged by the orchestrator)`；plan/review 的 description 补上"必须输出 envelope"。
5. 把 alpha.2 的宿主**存活容量上限**（`subagent.maxActiveSubagents`，默认 8）写进 persona——审计显示它目前只在工具 description 里，persona 完全没提，模型可能把它误判成阶段不可用。
6. `test/watchdog.smoke.mjs` 的 E 块（预设内容契约）加上述锚点断言，沿用现有惯例。

**阶段 2 · 结构化 I/O（插件改动，收益次之）**

7. `STAGE_INPUTS` → JSON Schema task packet（§5.1）；落盘改 JSON；**派发前确定性校验**（`acceptanceCriteria` 非空、同批并行 `ownedPaths` 不重叠——现在这只是 persona 散文，可以变成硬拒绝）。
8. 给阶段子代理注入 `pipeline_submit` 窄工具（**调用点**校验）+ `subagent/end` 围栏解析兜底 + 新增 `pipeline_result` 工具（§5.2、§5.5）；schema 保持浅，解析失败回退不阻塞。再加一条单测锁住「先注册工具、再 restrict 白名单」的顺序。
9. `pipeline_followup` 接受 `issues[]` / `changeSet`（§5.3）。
10. **插件侧 review 轮次计数 + blocking 数遥测**：现在"最多 3 轮"没有任何机制执行（审计 §F(b)），轮次完全不落账本。计数器顺带给出"本轮 blocking 是否下降"的判据。

**阶段 3 · 机制兜底（可选）**

11. `pipeline_tier` 闸门（§3.3）+ `/dsh-code-pipeline/status` 暴露档位、轮次、blocking 趋势。
12. 客户端设置页：默认档位、每轮 blocking 上限、review 单轮最多 issue 数。
13. （实验，不默认开启）变更集用 **search-replace** 表达而非 unified diff——Diff-XYZ 显示大模型上 search-replace 表现更好；但现行 persona 有"`diff` 必须含 `@@`"的硬校验，切换前先 A/B。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| T0 放宽后主会话改坏代码 | T0 判据保留"必须自己跑测试/构建"；"安全/数据/并发敏感"作为 T2 最高优先级，**高于行数**；升级单向且必须 `todo_write` 留痕 |
| **过度加层反而更差**（研究：层级里加 deliberation 可能 3.4× 更差、token 多 1.8–2.7×） | 分档的目的正是**减少**层数；任何"再加一个 review/judge"的提议都必须先证明当前层的误报率 |
| 结构化 envelope 解析失败 | 失败**不阻塞**：回退 `{parsed:false, raw}` + 日志；schema 保持浅（约束解码有容量代价）；§5.2 备选提交工具兜底 |
| 主会话借 triage 放水 | triage 是**白名单策略**不是主观判断；被过滤的 issue 必须原样记录（含 `rejectionReason`）并出现在最终报告；reviewer 的 verdict/severity/confidence 不被改写 |
| reviewer 换模型后行为漂移（研究：同一 reviewer 对不同作者模型的评论分布不同） | 把"blocking/severity 分布"作为可观测指标；改动 reviewer 的 provider/model 时用固定回归集比对 |
| 档位闸门太硬挡住合理流程 | 只在"档位与派发的阶段矛盾"时拒绝，错误文案给出升级方法；默认档位可配置 |
| 协议文本大改引入回归 | E 块锚点断言 + A/B/C/D 块加 triage 与 envelope 单测；先只改 persona（阶段 1）观察一周再动代码 |

---

## 8. 验证方案

1. **分档有效性**：从 `~/.dsh/sessions` 抽 20 个真实历史任务，人工标注 T0/T1/T2，跑协议看落档是否符合。目标：**T0 占比 ≥ 40%**（现在基本为 0）。
2. **triage 有效性**：构造三组固定输入（① 真 bug ② 纯文档遗漏 ③ 无触发路径的小概率猜测），断言**只有 ① 进 impl**，②③ 进 deferred 且带 `rejectionReason`；断言"过滤后为空 → 正常收尾"（不再跑满 3 轮）。
3. **收敛有效性**：构造"同一处反复改"的震荡输入，断言**第 2 轮即停止**并转用户决策，而不是跑满 3 轮。
4. **客观信号优先**：断言测试/类型检查绿灯时，不因 LLM 的 blocking finding 而改动代码（除非属 security/data-loss 类）。
5. **结构化回执**：单测覆盖"正常 / 缺字段 / 非法 JSON / 多段围栏 / 无围栏"；断言 `pipeline_result` 返回形状与 `parsed:false` 回退。
6. **派发前校验**：并行派发的 `ownedPaths` 重叠必须被拒；`acceptanceCriteria` 为空必须被拒。
7. **成本与缓存回归**：用 `~/.dsh/deepseek-quota/quota.db` 的 `session_folds.samples`（按 parent 聚合 root + 子会话）对比改动前后的 token、子代理数，以及 **cacheRead 占比**（缓存命中率应上升）。
8. 现有 174 条断言保持全绿；新增断言后更新 README「变更记录」与计数（沿用现有惯例）。

---

## 9. 开放问题（需要你拍板）

1. **T0 阈值**：≤2 文件 / ≤~60 行 是我按经验给的。你要**更激进**（更多任务主会话自己做、更省 token、风险更高）还是**更保守**？
2. **档位闸门**（§3.3）要做成**硬拒绝**，还是只做提示 + 状态展示？
3. **review 的 blocking 白名单**：`test-gap`（缺测试）是否允许 blocking？我倾向**允许**（缺测试是真实回归风险），而 `docs` / `style` 一律不 blocking。你的偏好？
4. **结构化回执**已按你的意见定为「加窄工具 `pipeline_submit` + 围栏解析兜底」（§5.5）。剩一个小选择：`pipeline_submit` 是**必需**（子代理必须调用，否则整轮算失败）还是**可选**（调用不到就回落兜底解析）？我建议**可选 + 兜底**，并在 `pipeline_result` 里透出 `source`（`submit` / `parsed`）便于观测。
5. **谁来当"客观信号"**：T0/T1 是否强制"改完必须跑一次可用的测试/构建"（有则跑、没有则跳过）？这会让 T0 稍慢但显著降风险。
