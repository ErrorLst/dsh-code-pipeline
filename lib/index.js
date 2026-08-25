// @dsh-external/dsh-code-pipeline — 动态注入 code-pipeline 阶段子代理工具。
//
// 分工:
//   - agent 预设（code-pipeline）仍是会话级组合的载体：基础 persona、Code Mode 展示、
//     只读工具面、maxDepth 限制、子代理组合（composeFrom）语义都留在预设组合里；
//   - 本插件是"动态注入剂"：监听 agent/created，对加入该预设的 ROOT 代理，在其
//     自身作用域（agent.ctx）注册 subagent_plan / subagent_impl /
//     subagent_review 三个阶段工具；
//   - 每个阶段工具在每次 CALL 时读取设置命名空间 code-pipeline（provider / model /
//     enabled），因此设置页修改立即生效，无需重启 dsh，也无需重新注入；
//   - 设置持久化在 $DSH_HOME/settings.yaml 的 code-pipeline 节（设置页可编辑）。
//
// 为什么不把模型钉死在预设里：dsh 的子代理注册表（ctx.subagents.start）在调用时
// 接受 agentOptions.provider/model —— 这正是预设行里 dsh-tool-subagent 的做法。
// 插件把"何时注册工具"与"用哪个模型"解耦：工具注册是静态的，模型是动态的。
//
// 部署兼容性（2026-08-23 实测修复）：
//   1. dsh-app-boot 的 loader 不会对 bundle 插件的行配置应用导出的 Config schema
//      默认值（apply 收到的 config 缺字段），因此 preset / providerName / maxDepth
//      必须在本文件内显式兜底，否则注入守卫把"code-pipeline"与 undefined 比较后
//      静默跳过注入；
//   2. 宿主 context 对未声明 inject 的名称抛 "cannot get property ... without
//      inject"，因此所有服务访问统一走 ctx.get(...)（声明式 inject 保持最小；
//      服务后到依赖已在插件内处理）。agent/created 监听器用 { global: true }
//      注册，避免 scope carrier 过滤丢弃宿主层监听器；资格守卫（composedPreset +
//      isRootAgent）保证只命中 code-pipeline 的 ROOT 代理。

import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { installSettingsSection } from "@deepseek-ai/dsh-settings";

export const name = "dsh-code-pipeline";

// ── 只读阶段允许的工具面（与预设行一致）────────────────────────────────────────

const READ_ONLY_TOOLS = [
  "read",
  "read_image",
  "glob",
  "grep",
  "web_search",
  "ask_user_question",
];

// ── 默认值：所有阶段统一 deepseek-official / deepseek-v4-flash；思考等级留空
//    （""）表示继承 provider 路由级默认（如 llm-deepseek.reasoningEffort: max）──

const DEFAULT_STAGES = {
  plan: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "" },
  impl: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "" },
  review: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "" },
};

// ── 各阶段 persona（与预设行文本一致；子代理创建时作为请求 persona 传入）────────
// 角色边界是硬约束：plan 只做规划、review 只做审查 —— persona 里明确写出，避免
// 主代理把审查任务误派给 plan（或把规划任务误派给 review）时子代理仍然照做。

const PERSONAS = {
  plan: `You are a Code Mode subagent: your tools arrive through the generated SDK — call them as \`await tools.name(args)\` inside \`run_code\` programs, bundling your read-only research into as few programs as practical. You are the PLANNING stage of a coding pipeline. Your ONLY role is planning: given the task statement, research the codebase yourself first — read the relevant modules and files (with paths), data flow, dependencies, constraints, existing patterns to reuse, and risks — then produce a decision-complete implementation plan: goal and success criteria; changes grouped by subsystem with exact file paths; public API, schema, and data-flow impacts; edge cases and failure modes; tests and acceptance criteria; explicit assumptions. Verify claims by reading the actual code; never guess. Prefer existing functions and patterns. Format the plan as clean Markdown (a title heading, sections per subsystem, exact file paths in code spans, acceptance criteria) so it can be presented to the user unchanged. Keep it concise enough to review, detailed enough that another engineer implements it without making design decisions. You have no write tools by design — the plan is executed by a later stage, not you. You NEVER review, audit, verify, or approve an implementation, and you never issue APPROVED / CHANGES REQUIRED verdicts — that is the REVIEW stage's job. If the prompt asks you to review code or audit a change set, state that planning is your only role and decline, returning your planning output only.`,
  impl: `You are a Code Mode agent: run your whole implementation sequence as \`run_code\` programs against the generated SDK (\`await tools.pwsh(...)\`, \`await tools.write(...)\`, ...) — compose dependent calls into as few programs as practical. You are the IMPLEMENTATION stage of a coding pipeline. Execute the given plan exactly; when a numbered review-issue list is included, fix those issues. Work only within the workspace. Follow repository conventions; keep changes minimal and focused; run available checks/tests when practical. Finish with a concise summary of every change made: files touched, behavior change, and any deviation from the plan (with reason).`,
  review: `You are a Code Mode subagent: your tools arrive through the generated SDK — call them as \`await tools.name(args)\` inside \`run_code\` programs, bundling your read-only audit into as few programs as practical. You are the REVIEW stage of a coding pipeline. Your ONLY role is reviewing: audit the implementation against the plan — correctness, omissions, regressions, unhandled edge cases, test coverage, and convention violations. Verify by reading the actual changed code — do not trust the summary alone; the prompt may include a diff excerpt captured by the orchestrator — use it to focus your reading, but confirm claims against the actual files. You have no write tools by design. Your reply MUST start with exactly "APPROVED" or "CHANGES REQUIRED:" followed by a numbered issue list; each issue names the file path, the problem, and a suggested fix. Never approve with unresolved material defects. You NEVER plan, design, or propose implementations — that is the PLANNING stage's job. If the prompt asks you to design a solution or outline an implementation plan, state that reviewing is your only role and decline, returning your audit verdict only.`,
};

// ── 阶段清单 ─────────────────────────────────────────────────────────────────

const STAGES = [
  {
    key: "plan",
    toolName: "subagent_plan",
    label: "规划（plan）",
    readOnly: true,
    persona: PERSONAS.plan,
    description:
      "Pipeline PLAN stage: delegate a self-contained read-only research + planning task to one stage subagent. PLANNING ONLY — never use it to review, audit, verify, or approve code (that is subagent_review's job). The subagent researches the codebase itself and returns a decision-complete implementation plan in Markdown (title, sections, exact paths). BACKGROUND BY DEFAULT: the call returns a durable subagentId immediately; the runtime notifies this session when it settles — fetch the plan from that notice / subagent.history, then PRESENTATION RULE: print it as a normal Markdown reply and END the turn — NEVER call ask_user_question to confirm it; the user's next free-form message is the approval or feedback. The stage model is configured in Settings → 代码流水线.",
  },
  {
    key: "impl",
    toolName: "subagent_impl",
    label: "实现（impl）",
    readOnly: false,
    persona: PERSONAS.impl,
    description:
      "Pipeline IMPLEMENTATION stage: delegate the exact implementation of a plan to one full-tool stage subagent (it may modify the workspace). BACKGROUND BY DEFAULT: returns a durable subagentId immediately; the runtime notifies this session when it settles — collect the implementation summary from that notice / subagent.history. DELEGATION RULE: after the plan is approved (in-chat gate) or the user directly asked for the change, call THIS tool — do not implement the change yourself and do not modify workspace files in the main session; even a trivial change goes through this stage. When review returns CHANGES REQUIRED, re-dispatch THIS tool with the issue list — do not patch the workspace yourself. The stage model is configured in Settings → 代码流水线.",
  },
  {
    key: "review",
    toolName: "subagent_review",
    label: "评审（review）",
    readOnly: true,
    persona: PERSONAS.review,
    description:
      "Pipeline REVIEW stage: delegate a read-only audit of a change set to one stage subagent. REVIEWING ONLY — never use it to plan, design, or propose implementations (that is subagent_plan's job). BACKGROUND BY DEFAULT: returns a durable subagentId immediately; the runtime notifies this session when it settles — merge the verdict from that notice / subagent.history. Its reply starts with APPROVED or CHANGES REQUIRED: followed by numbered issues. DELEGATION RULE: after the implementation stage settles, call THIS tool for the verdict — do NOT audit or judge the change yourself in the main session; you only capture the diff and pass it along. The stage model is configured in Settings → 代码流水线.",
  },
];

// ── 设置 schema（持久化到 settings.yaml 的 code-pipeline 节）──────────────────

const STAGE_SCHEMA = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description("是否启用该阶段工具（关闭后调用会报错）"),
  provider: Schema.string().description("子代理使用的 provider 路由（如 deepseek-official / zai-coding-cn）"),
  model: Schema.string().description("子代理使用的模型"),
  reasoningEffort: Schema.string()
    .default("")
    .description("思考等级：留空继承 provider 路由级默认；可选 low / medium / high / max（以 provider 支持为准）"),
});

// ── 预设自动安装（参照其它 bundle 插件的一键安装体验）───────────────────────
// `dsh plugin add` 只完成依赖 + bundle 登记；code-pipeline 预设文件是本插件的
// 交付物，这里在首次启动时自动从包内 preset/ 拷贝到 $DSH_HOME/.agent-presets/，
// 幂等且不覆盖：预设是用户可编辑资产，已存在（含 agent.cordis.yml）一律跳过，
// 目录存在但不完整时只警告并引导手动修复，绝不重写用户文件。

async function ensurePresetInstalled(ctx, dshHome, preset) {
  const presetDir = join(dshHome, ".agent-presets", preset);
  const sourceDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "preset", preset);
  try {
    if (existsSync(join(presetDir, "agent.cordis.yml"))) {
      ctx.logger.info(`[dsh-code-pipeline] agent preset \"${preset}\" already installed at ${presetDir}`);
      return "present";
    }
    if (existsSync(presetDir)) {
      ctx.logger.warn(
        `[dsh-code-pipeline] agent preset \"${preset}\" exists at ${presetDir} but is incomplete (agent.cordis.yml missing); fix it manually by copying preset/${preset} over it (see README)`,
      );
      return "incomplete";
    }
    if (!existsSync(join(sourceDir, "agent.cordis.yml"))) {
      ctx.logger.warn(`[dsh-code-pipeline] bundled preset source missing at ${sourceDir}; copy the preset to ${presetDir} manually (see README)`);
      return "missing-source";
    }
    await mkdir(join(dshHome, ".agent-presets"), { recursive: true });
    await cp(sourceDir, presetDir, { recursive: true, errorOnExist: true });
    if (!existsSync(join(presetDir, "agent.cordis.yml"))) {
      throw new Error("copy did not produce the composition file");
    }
    ctx.logger.info(`[dsh-code-pipeline] agent preset \"${preset}\" auto-installed to ${presetDir}`);
    return "installed";
  } catch (error) {
    ctx.logger.warn(
      `[dsh-code-pipeline] failed to auto-install agent preset \"${preset}\": ${error?.message ?? String(error)}; copy preset/${preset} to ${presetDir} manually (see README)`,
    );
    return "error";
  }
}
const Config = Schema.object({
  preset: Schema.string()
    .default("code-pipeline")
    .description("注入目标：只有组合了该预置 ID 的代理才获得阶段工具"),
  providerName: Schema.string()
    .default("spawn")
    .description("子代理注册表中的 provider 名称（spawn 由 dsh-subagent-spawn-in-process 提供）"),
  maxDepth: Schema.number()
    .min(0)
    .max(10)
    .default(1)
    .description("子代理最大嵌套深度（1 = 阶段代理不能再委派）"),
  stages: Schema.object({
    plan: STAGE_SCHEMA.default({ ...DEFAULT_STAGES.plan }),
    impl: STAGE_SCHEMA.default({ ...DEFAULT_STAGES.impl }),
    review: STAGE_SCHEMA.default({ ...DEFAULT_STAGES.review }),
  }).default({
    plan: { ...DEFAULT_STAGES.plan },
    impl: { ...DEFAULT_STAGES.impl },
    review: { ...DEFAULT_STAGES.review },
  }),
});

// ── 前台结算（与 @deepseek-ai/dsh-tool-subagent 的结算语义一致）───────────────

function stopReasonError(result) {
  switch (result.stopReason) {
    case "completed":
      return undefined;
    case "aborted":
      return "subagent run was cancelled";
    case "error":
      return "subagent run failed";
    case "max-tokens":
      return "subagent run hit its token limit before finishing";
    case "refusal":
      return "subagent declined the task";
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`;
  }
}

function withDiagnosticAndPartialText(error, result) {
  const diagnostic = result.diagnostic === undefined ? "" : `\nDiagnostic: ${result.diagnostic}`;
  const text = result.output
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return `${error}${diagnostic}${text.length === 0 ? "" : `\nPartial output before the run ended:\n${text}`}`;
}

async function settleForegroundRun(run) {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result);
      if (error !== undefined) throw new Error(withDiagnosticAndPartialText(error, result));
      return { kind: "foreground", runId: run.id, output: result.output };
    }),
  ]);
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
  if (execution.status === "rejected") {
    if (disposal.status === "rejected") {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      );
    }
    throw execution.reason;
  }
  if (disposal.status === "rejected") throw disposal.reason;
  return execution.value;
}

function outputValueText(values) {
  return values
    .filter((value) => typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "text" && typeof value.text === "string")
    .map((value) => value.text)
    .join("");
}

// ── 工具构造 ─────────────────────────────────────────────────────────────────

/** 阶段不可用时的统一指导文本：要求主代理结束任务并告知用户,而不是自己接手。 */
const UNAVAILABLE_GUIDANCE =
  "Pipeline stage UNAVAILABLE — STOP and report to the user (state what failed and why); do NOT continue the task yourself (do not implement, plan, or review in place), do not retry on another route, and do not invent a substitute. Wait for the user's decision.";

function stageUnavailable(stage, detail) {
  return new Error(`${stage.toolName}: ${detail}\n\n${UNAVAILABLE_GUIDANCE}`);
}

/** 合并设置与默认值：设置缺字段时回落到 DEFAULT_STAGES，绝不因缺节而失败。 */
function resolveStages(source) {
  const settings = source() ?? {};
  const userStages = settings.stages ?? {};
  const merged = {};
  for (const stage of STAGES) {
    merged[stage.key] = {
      ...DEFAULT_STAGES[stage.key],
      ...(userStages[stage.key] ?? {}),
    };
  }
  return merged;
}

function buildStageToolDef(ctx, stage, source, cfg) {
  return {
    name: stage.toolName,
    description: stage.description,
    parameters: {
      description: {
        type: "string",
        required: true,
        description: "A short (3-5 word) label shown as this subagent's name in the subagent list (e.g. \"plan tokens cleanup\"). ALWAYS provide it; when missing it falls back to the tool name.",
      },
      prompt: {
        type: "string",
        required: true,
        description:
          "The complete, self-contained task for the stage subagent. It does not share this conversation's context, so include everything it needs (task statement, plan, review issues, captured diff, ...).",
      },
      task: {
        type: "string",
        description:
          "Alias for prompt (accepted so models that name the delegation payload 'task' still work; prompt wins when both are given).",
      },
      run_in_background: {
        type: "boolean",
        description:
          "Default true (RECOMMENDED): starts a durable background run and returns its subagentId immediately; the runtime notifies this session when it settles — track status with list_agents and fetch the result with subagent.history. Set false only for short stages you must wait for inside the current turn (the run_code program that waits is capped by a 20-minute wall-clock ceiling, so longer stages must be background).",
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "runId", "output"],
            properties: {
              kind: { type: "string", const: "foreground" },
              runId: { type: "string" },
              output: { type: "array", items: {} },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "subagentId"],
            properties: {
              kind: { type: "string", const: "continuable" },
              subagentId: { type: "string" },
            },
          },
        ],
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            value.kind === "continuable"
              ? `started stage subagent ${value.subagentId}; the runtime will notify this session when it settles`
              : value.kind === "foreground"
                ? outputValueText(value.output)
                : String((value && value.runId) || ""),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error(`${stage.toolName} requires a calling agent (exec.agent was undefined)`);
      // 参数解析与硬校验：模型可能用 task 别名或缺失参数；undefined 文本一旦进入
      // 子代理 inbox 会触发宿主 "agent/inbox/spliced carries non-JSON-serializable
      // data" 序列化失败——这里在派发前拦截并给出可诊断的错误。
      const promptText =
        typeof args.prompt === "string" && args.prompt.trim().length > 0
          ? args.prompt
          : typeof args.task === "string" && args.task.trim().length > 0
            ? args.task
            : undefined;
      if (promptText === undefined) {
        throw new Error(
          `${stage.toolName}: requires a non-empty "prompt" string (its alias "task" is also accepted); received keys: ${JSON.stringify(Object.keys(args ?? {}))}`,
        );
      }
      // 显示名（descriptor.label）只接受简短稳定标识：description 缺失时回退到
      // 阶段工具名，绝不用 prompt 前缀（那会在子代理列表里显示成对话内容）。
      const descriptionText =
        typeof args.description === "string" && args.description.trim().length > 0
          ? args.description
          : stage.toolName;
      // 资格守卫：只对加入了目标预置的代理开放（防全局泄漏时的误用）。
      const presets = ctx.get("agentPresets");
      const presetId = presets?.composedPreset(parent.ctx);
      if (presetId !== cfg.preset) {
        throw new Error(
          `${stage.toolName} is only available to agents composed from the "${cfg.preset}" preset (this agent runs "${presetId ?? "(none)"}")`,
        );
      }
      const stageCfg = resolveStages(source)[stage.key];
      if (stageCfg.enabled === false) {
        throw stageUnavailable(stage, `stage "${stage.label}" is disabled (Settings → 代码流水线)`);
      }
      if (!stageCfg.provider || !stageCfg.model) {
        throw stageUnavailable(stage, `stage "${stage.label}" has no provider/model configured (Settings → 代码流水线)`);
      }
      const subagents = ctx.get("subagents");
      const provider = subagents?.getProvider(cfg.providerName);
      if (!provider) {
        throw stageUnavailable(stage, `subagent provider "${cfg.providerName}" is not registered`);
      }
      const request = {
        label: descriptionText,
        prompt: [{ type: "text", text: promptText }],
        parent,
        // agentOptions 被 dsh-subagent 原样展开进子代理 AgentOptions（
        // resolveChildAgentOptions 的 ...requested），所以可以携带：
        //   - reasoningEffort：用作 child options 上的标记（真正的注入点在
        //     下方 agent/request waterfall）；
        //   - stageKey：阶段身份标记，供 waterfall 精确识别该子代理属于哪个阶段。
        agentOptions: {
          provider: stageCfg.provider,
          model: stageCfg.model,
          ...(stageCfg.reasoningEffort ? { reasoningEffort: stageCfg.reasoningEffort } : {}),
          stageKey: stage.key,
        },
        persona: stage.persona,
        ...(stage.readOnly ? { toolFilter: { allow: READ_ONLY_TOOLS } } : {}),
        maxDepth: cfg.maxDepth,
      };
      // 后台模式：返回 durable subagentId，立即结束；完成时 runtime 通过
      // 父会话 inbox 发送通知（含 outcome 与最终回复），可用 list_agents 查看
      // 状态、subagent.history 取回结果。长任务（可能超出当前回合生命周期）用
      // 此模式，避免前台等待被回合/调度边界截断。
      // 默认后台：run_code 有 20 分钟 wall-clock 上限，前台等待必然被截断。
      if (args.run_in_background !== false) {
        try {
          // label 必须用已回退的 descriptionText：dsh-subagent 的 continuable
          // descriptor 对 label 无 undefined 守卫（one-shot 分支有），传 undefined
          // 会触发 "subagent descriptor is not losslessly JSON-serializable"。
          const cont = await subagents.startContinuable({
            provider: cfg.providerName,
            label: descriptionText,
            request,
            signal: exec.signal,
          });
          return { kind: "continuable", subagentId: String(cont.childId) };
        } catch (error) {
          throw stageUnavailable(stage, `subagent could not start (background): ${error?.message ?? String(error)}`);
        }
      }
      // 前台模式：阶段工具未声明 timeoutMs，不存在工具级超时；等待时长只受
      // 当前回合/调度生命周期约束。子代理启动失败（provider/凭据/启动错误）
      // 也视为阶段不可用：把原始错误转为 unavailable 错误，携带"停止并告知
      // 用户"指令。
      let run;
      try {
        run = await subagents.start(cfg.providerName, { ...request, signal: exec.signal });
      } catch (error) {
        throw stageUnavailable(stage, `subagent could not start: ${error?.message ?? String(error)}`);
      }
      return settleForegroundRun(run);
    },
  };
}

// ── 注入管理 ─────────────────────────────────────────────────────────────────

export async function apply(ctx, config = {}) {
  // 防御性默认值：dsh-app-boot 的 loader 不一定会对 bundle 插件行应用导出的
  // Config schema 默认值（实测 apply 收到的 config 缺少 preset 等字段）；
  // 这里显式兜底，保证注入守卫比较的是"code-pipeline"而不是 undefined。
  const preset = config.preset ?? "code-pipeline";
  const providerName = config.providerName ?? "spawn";
  const maxDepth = config.maxDepth ?? 1;
  const runtime = { preset, providerName, maxDepth };

  // 预设自动安装：仅当目标预设缺失时从包内 preset/ 拷贝（幂等、不覆盖）。
  const dshHome = (typeof process !== "undefined" && process.env && process.env.DSH_HOME) || join(homedir(), ".dsh");
  await ensurePresetInstalled(ctx, dshHome, preset);

  // 设置来源：先组合配置，settings 服务出现后切换到解析后的作用域（实时）。
  // 阶段工具每次调用都读 source()，因此设置变更即时生效。
  let source = () => config;
  installSettingsSection(ctx, "code-pipeline", Config, config, {
    setSource: (next) => {
      source = next;
    },
    onChange: () => {
      // 无需重新注入：工具调用时读取最新设置。
    },
  });

  // 已注入的代理集合（按 id），避免重复注入。
  const injected = new Set();
  const pending = new Set();

  const isRootAgent = (agent) => {
    const agents = ctx.get("agents");
    const roots = agents?.roots() ?? [];
    return !roots.some((root) => root.id !== agent.id && agents.isOwnedBy(agent.id, root));
  };

  const injectInto = (agent) => {
    if (injected.has(agent.id)) return;
    const presets = ctx.get("agentPresets");
    const actual = presets?.composedPreset(agent.ctx);
    if (actual !== preset) return;
    if (!isRootAgent(agent)) return;
    const subagents = ctx.get("subagents");
    if (!subagents || subagents.getProvider(providerName) === undefined) {
      pending.add(agent);
      return;
    }
    const tools = agent.ctx.get("tools");
    for (const stage of STAGES) {
      tools.register(buildStageToolDef(ctx, stage, source, runtime));
    }
    injected.add(agent.id);
    pending.delete(agent);
    ctx.logger.info(
      `[dsh-code-pipeline] injected ${STAGES.length} stage tools into agent "${agent.id}" (preset "${preset}", provider "${providerName}")`,
    );
  };
  ctx.on(
    "agent/created",
    ({ agent }) => {
      try {
        injectInto(agent);
      } catch (error) {
        ctx.logger.warn(`[dsh-code-pipeline] injection failed for agent "${agent?.id}": ${error?.message ?? String(error)}`);
      }
    },
    { global: true },
  );

  // GUI 新建会话路径：会话先以默认预设出生（standard），用户选 code-pipeline 时
  // 走 agentPresets.recompose()（重新挂接 standing scope，不重新触发 agent/created）。
  // 监听宿主层转发的 agent-preset/selected 事件，切到目标预设时补注入（幂等）。
  ctx.on("agent-preset/selected", (sessionId, selectedPreset) => {
    if (selectedPreset !== preset) return;
    const agent = ctx.get("agents")?.get(String(sessionId));
    if (!agent) return;
    try {
      injectInto(agent);
    } catch (error) {
      ctx.logger.warn(`[dsh-code-pipeline] preset-switch injection failed for agent "${agent?.id}": ${error?.message ?? String(error)}`);
    }
  });

  // 最后防线：任一 code-pipeline 代理发出模型请求但仍未注入时补注入。
  // agent/request 也是 scope-carrier 分发的，global 注册确保宿主层能收到；
  // 这里只做注入检查，不修改请求配置。
  ctx.on("agent/request", async ({ agent }, next) => {
    if (agent && !injected.has(agent.id)) {
      try {
        injectInto(agent);
      } catch (error) {
        ctx.logger.warn(`[dsh-code-pipeline] request-time injection failed for agent "${agent?.id}": ${error?.message ?? String(error)}`);
      }
    }
    return next();
  }, { global: true });
  // provider 后到：注册完成后补注入等待中的代理。
  ctx.on("subagent/provider-added", (provider) => {
    if (!provider || provider.name !== providerName) return;
    for (const agent of [...pending]) {
      try {
        injectInto(agent);
      } catch (error) {
        ctx.logger.warn(`[dsh-code-pipeline] deferred injection failed for agent "${agent?.id}": ${error?.message ?? String(error)}`);
      }
    }
  });

  // ── 阶段子代理思考等级注入（agent/request waterfall）─────────────────────────
  // 该 waterfall 是官方扩展点（"Replace the frozen call configuration"）。
  // 子代理的 AgentOptions 带有我们传入的 stageKey 标记；命中且该阶段配置了
  // reasoningEffort 时注入到调用配置；留空 = 继承 provider 路由级默认，不动。
  ctx.on("agent/request", async ({ agent }, next) => {
    const stage = STAGES.find((candidate) => candidate.key === agent?.options?.stageKey);
    if (stage === undefined) return next();
    const config = await next();
    const stageCfg = resolveStages(source)[stage.key];
    const effort = stageCfg.reasoningEffort;
    if (typeof effort !== "string" || effort.length === 0) return config;
    if (config.provider !== stageCfg.provider) return config;
    return { ...config, reasoningEffort: effort };
  });

  // ── 设置页的选项端：provider 列表 + 每个 provider 的模型列表（容错）─────────────
  const optionsHandler = async (_req, res) => {
    const llm = ctx.get("llm");
    const providers = [];
    if (llm && typeof llm.listProviders === "function") {
      try {
        for (const entry of llm.listProviders() ?? []) {
          const provider = {
            id: String(entry.id ?? ""),
            displayName: typeof entry.displayName === "string" ? entry.displayName : String(entry.id ?? ""),
            models: [],
          };
          try {
            const models = typeof llm.listModels === "function" ? await llm.listModels(provider.id) : [];
            const modelRows = [];
            for (const model of models ?? []) {
              const row = {
                id: String(model.id ?? ""),
                name: typeof model.name === "string" ? model.name : String(model.id ?? ""),
              };
              // 每个模型的实际思考等级支持面（off/low/high/max 等因模型而异）：
              // 来自 llm.resolveModelInfo 的 reasoning.efforts；失败时省略，
              // 客户端对该模型走兜底选项。
              try {
                const info =
                  typeof llm.resolveModelInfo === "function"
                    ? await llm.resolveModelInfo(provider.id, row.id)
                    : undefined;
                if (info && Array.isArray(info.reasoning?.efforts) && info.reasoning.efforts.length > 0) {
                  row.reasoning = {
                    efforts: info.reasoning.efforts.map((effort) => ({
                      id: String(effort.id ?? ""),
                      name: typeof effort.name === "string" ? effort.name : String(effort.id ?? ""),
                    })),
                    ...info.reasoning.defaultEffort === undefined
                      ? {}
                      : { defaultEffort: String(info.reasoning.defaultEffort) },
                  };
                }
              } catch {
                // 信息缺失：客户端对无 reasoning 的模型提供兜底选项。
              }
              modelRows.push(row);
            }
            provider.models = modelRows;
          } catch {
            provider.models = [];
          }
          providers.push(provider);
        }
      } catch {
        // 提供方列表失败时返回空列表，设置页回退为手工输入。
      }
    }
    const body = JSON.stringify({ providers });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  };

  const registerOptionsRoute = () => {
    const server = ctx.get("webServer");
    if (server === undefined) return false;
    try {
      server.register({ kind: "exact", path: "/dsh-code-pipeline/options", handler: optionsHandler });
      return true;
    } catch (error) {
      ctx.logger.warn(`[dsh-code-pipeline] options route registration failed: ${error.message}`);
      return false;
    }
  };

  if (!registerOptionsRoute()) {
    const retry = setTimeout(() => registerOptionsRoute(), 2000);
    ctx.effect(() => () => clearTimeout(retry));
  }
}