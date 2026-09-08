// @dsh-external/dsh-code-pipeline — 动态注入 code-pipeline 阶段子代理工具。
//
// 分工:
//   - agent 预设（code-pipeline）仍是会话级组合的载体：基础 persona、PTC（Code Mode）展示、
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
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Schema from "@deepseek-ai/schemastery";

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
  plan: `You are a PTC (Code Mode) subagent: your tools arrive through the generated SDK — call them as \`await tools.name(args)\` inside \`run_code\` programs, bundling your read-only research into as few programs as practical. You are the PLANNING stage of a coding pipeline. Your ONLY role is planning: given the task statement, research the codebase yourself first — read the relevant modules and files (with paths), data flow, dependencies, constraints, existing patterns to reuse, and risks — then produce a decision-complete implementation plan: goal and success criteria; changes grouped by subsystem with exact file paths; public API, schema, and data-flow impacts; edge cases and failure modes; tests and acceptance criteria; explicit assumptions. Verify claims by reading the actual code; never guess. Prefer existing functions and patterns. Format the plan as clean Markdown (a title heading, sections per subsystem, exact file paths in code spans, acceptance criteria) so it can be presented to the user unchanged. Keep it concise enough to review, detailed enough that another engineer implements it without making design decisions. You have no write tools by design — the plan is executed by a later stage, not you. You NEVER review, audit, verify, or approve an implementation, and you never issue APPROVED / CHANGES REQUIRED verdicts — that is the REVIEW stage's job. If the prompt asks you to review code or audit a change set, state that planning is your only role and decline, returning your planning output only. Your dispatch message may arrive as a TEMP FILE path reference — ALWAYS read the referenced file with the read tool first; do not expect its content inline.`,
  impl: `You are a PTC (Code Mode) agent: run your whole implementation sequence as \`run_code\` programs against the generated SDK (\`await tools.pwsh(...)\`, \`await tools.write(...)\`, ...) — compose dependent calls into as few programs as practical. You are the IMPLEMENTATION stage of a coding pipeline. Execute the given plan exactly; when a numbered review-issue list is included, fix those issues. Work only within the workspace. Follow repository conventions; keep changes minimal and focused; run available checks/tests when practical. Finish with a concise summary of every change made: files touched, behavior change, and any deviation from the plan (with reason). Your dispatch message may arrive as a TEMP FILE path reference — ALWAYS read the referenced file with the read tool first; do not expect its content inline.`,
  review: `You are a PTC (Code Mode) subagent: your tools arrive through the generated SDK — call them as \`await tools.name(args)\` inside \`run_code\` programs, bundling your read-only audit into as few programs as practical. You are the REVIEW stage of a coding pipeline. Your ONLY role is reviewing: audit the implementation against the plan — correctness, omissions, regressions, unhandled edge cases, test coverage, and convention violations. Verify by reading the actual changed code — do not trust the summary alone; the prompt may include a diff excerpt captured by the orchestrator — use it to focus your reading, but confirm claims against the actual files. Your whole dispatch message may arrive as a TEMP FILE path reference — read it with the read tool before auditing; do not expect its content in the prompt. You have no write tools by design. Your reply MUST start with exactly "APPROVED" or "CHANGES REQUIRED:" followed by a numbered issue list; each issue names the file path, the problem, and a suggested fix. Never approve with unresolved material defects. You NEVER plan, design, or propose implementations — that is the PLANNING stage's job. If the prompt asks you to design a solution or outline an implementation plan, state that reviewing is your only role and decline, returning your audit verdict only.`,
};

// ── 阶段可选输入字段（models 常按习惯传这些名称；全部声明为 string 并在
//    派发时结构化拼进子代理提示，保证物料完整到达，绝不静默剥离）──────────

const STAGE_INPUTS = {
  plan: [
    { key: "context", hint: "Background / audit results the planner must take as given." },
    { key: "constraints", hint: "Hard constraints the plan must honor." },
  ],
  impl: [
    { key: "context", hint: "Background context for the implementer." },
    { key: "plan", hint: "The approved plan text the implementer must execute exactly." },
    { key: "constraints", hint: "Hard constraints for the implementation." },
  ],
  review: [
    { key: "context", hint: "Background context for the reviewer." },
    { key: "plan", hint: "The plan the implementation is audited against." },
    { key: "implementationSummary", hint: "The implementation summary produced by the impl stage." },
    { key: "diff", hint: "The captured change set (git diff / change summary) to audit." },
    { key: "focus", hint: "Specific review focal points the user asked about." },
  ],
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
"Pipeline PLAN stage. CONTRACT: params = prompt|task (task text; one of them required) + description (display label, optional) + context? + constraints? (both merged into the child's prompt, never dropped). Unknown keys are rejected. BACKGROUND-ONLY: returns { kind: 'continuable', subagentId } immediately; the runtime notifies this session when it settles — fetch the plan from that notice or subagent.history. PLANNING ONLY: never use it to review/audit/verify/approve code (that is subagent_review's job). PRESENTATION RULE: print the plan as a normal Markdown reply and END the turn — NEVER call ask_user_question to confirm it. The stage model is configured in Settings → 代码流水线. The whole dispatch message (prompt + all stage inputs) is written to a SINGLE temp file automatically — the child reads that one file with the read tool; never inline large material into these fields (inline generation is truncated at the model output limit)." +
      "WorkSpace hygiene is ABSOLUTE: never create ANY material or intermediate file inside the workspace — not in the workspace root, not in `.pipeline-tmp/`, not in any subdirectory (no `*.diff` / `.review_*.diff` dumps, no change-set files, nothing). If an artifact is genuinely needed, write it EXCLUSIVELY to `$env:TEMP\\dsh-code-pipeline\` (system temp, outside the workspace) and delete it before this call returns. The review diff travels in the diff/implementationSummary parameters — never as workspace files.",
  },
  {
    key: "impl",
    toolName: "subagent_impl",
    label: "实现（impl）",
    readOnly: false,
    persona: PERSONAS.impl,
    description:
"Pipeline IMPLEMENTATION stage. CONTRACT: params = prompt|task (required) + description (label) + context? + plan? + constraints? (all merged into the child's prompt, never dropped); unknown keys are rejected. BACKGROUND-ONLY: returns { kind: 'continuable', subagentId } immediately; the runtime notifies this session when it settles — collect the implementation summary from that notice or subagent.history. DELEGATION RULE: after the plan is approved (in-chat gate) or the user directly asked for the change, call THIS tool — do not implement the change yourself in the main session; when review returns CHANGES REQUIRED, re-dispatch THIS tool with the issue list. The stage model is configured in Settings → 代码流水线. The whole dispatch message (prompt + all stage inputs) is written to a SINGLE temp file automatically — the child reads that one file with the read tool; never inline large material into these fields (inline generation is truncated at the model output limit)." +
      "WorkSpace hygiene is ABSOLUTE: never create ANY material or intermediate file inside the workspace — not in the workspace root, not in `.pipeline-tmp/`, not in any subdirectory (no `*.diff` / `.review_*.diff` dumps, no change-set files, nothing). If an artifact is genuinely needed, write it EXCLUSIVELY to `$env:TEMP\\dsh-code-pipeline\` (system temp, outside the workspace) and delete it before this call returns. The review diff travels in the diff/implementationSummary parameters — never as workspace files.",
  },
  {
    key: "review",
    toolName: "subagent_review",
    label: "评审（review）",
    readOnly: true,
    persona: PERSONAS.review,
    description:
"Pipeline REVIEW stage. CONTRACT: params = prompt|task (required) + description (label) + context? + plan? + implementationSummary? + diff? + focus? (all merged into the child's prompt, never dropped); unknown keys are rejected. BACKGROUND-ONLY: returns { kind: 'continuable', subagentId } immediately; the runtime notifies this session when it settles — merge the verdict from that notice or subagent.history. Its reply starts with APPROVED or CHANGES REQUIRED: followed by numbered issues. REVIEWING ONLY: never use it to plan/design/propose implementations; after impl settles call THIS tool for the verdict — do not audit or judge the change yourself. HARD RULE: the diff field must be the FULL patch text (contains @@ hunk headers) — stat-only or 'see git show' references are rejected; the whole dispatch message is auto-spilled to a single temp file the child reads via the read tool. The stage model is configured in Settings → 代码流水线." +
      "WorkSpace hygiene is ABSOLUTE: never create ANY material or intermediate file inside the workspace — not in the workspace root, not in `.pipeline-tmp/`, not in any subdirectory (no `*.diff` / `.review_*.diff` dumps, no change-set files, nothing). If an artifact is genuinely needed, write it EXCLUSIVELY to `$env:TEMP\\dsh-code-pipeline\` (system temp, outside the workspace) and delete it before this call returns. The review diff travels in the diff/implementationSummary parameters — never as workspace files.",
  },
];

// ── 派发消息整体落盘（单个临时文件）────────────────────────────────────────────
// 主代理派发给阶段子代理的完整消息（prompt + 该阶段所有输入字段合并）默认整体
// 写入平台临时目录下的一个文件，子代理提示中只保留文件路径引用——防止长文本在
// 派发/模型上下文中被截断；子代理（只读工具面含 read）用 read 工具读取该文件，
// 一次即可拿到全部消息。spillAllFields=false 时退回阈值模式：仅当消息行数超过
// largeFieldLines 才落盘。
const TEMP_ROOT = join(tmpdir(), "dsh-code-pipeline");

async function materializeDispatchMessage(stage, args, promptText, cfg) {
  const parts = [promptText];
  for (const input of STAGE_INPUTS[stage.key]) {
    const value = args[input.key];
    if (typeof value === "string" && value.trim().length > 0) {
      parts.push("\n\n**" + input.key + "**\n" + value);
    }
  }
  const fullPrompt = parts.join("");
  const lineCount = fullPrompt.split("\n").length;
  const spill = cfg.spillAllFields || lineCount > cfg.largeFieldLines;
  if (!spill) return { fullPrompt, pointer: null };
  await mkdir(TEMP_ROOT, { recursive: true });
  const file = join(TEMP_ROOT, `${stage.key}-${randomUUID()}.txt`);
  await writeFile(file, fullPrompt, "utf8");
  return {
    fullPrompt: `<dispatch message (${lineCount} lines, ${fullPrompt.length} chars)> written to temp file: ${file} — read the WHOLE file with the read tool; do not expect its content here.`,
    pointer: file,
  };
}

async function cleanOldTempFiles(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const names = await readdir(TEMP_ROOT);
    const now = Date.now();
    for (const name of names) {
      const file = join(TEMP_ROOT, name);
      try {
        if (now - (await stat(file)).mtimeMs > maxAgeMs) await rm(file, { force: true });
      } catch { /* 单个文件失败不影响清理 */ }
    }
  } catch { /* 目录不存在/无权限：忽略 */ }
}
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

/**
 * 已安装预设的兼容性自检（只读、只警告，绝不改写用户文件）。
 *
 * dsh 0.1.3 把 @deepseek-ai/dsh-persona 的配置字段从 text 改成 prefix（必填）
 * ——旧预设的 persona 行会激活失败，整个预设挂载报 agent-preset/invalid。
 * 这里检测已安装副本里 persona 行是否仍是旧 text 键，给出可操作的升级提示。
 */
function warnIfPresetPersonaIsStale(ctx, compositionPath, presetDir) {
  try {
    const text = readFileSync(compositionPath, "utf8");
    const personaAt = text.indexOf("- id: persona");
    if (personaAt === -1) return;
    const row = text.slice(personaAt, personaAt + 800);
    if (!/^[ \t]+text:/m.test(row) || /^[ \t]+prefix:/m.test(row)) return;
    ctx.logger.warn(
      `[dsh-code-pipeline] installed preset at ${presetDir} still uses the retired persona field \"text:\" — dsh 0.1.3+ requires \"prefix:\", and the whole preset will fail to mount (agent-preset/invalid). Copy preset/code-pipeline over it (see README 「升级同步」): Copy-Item -Recurse -Force "<package>/preset/code-pipeline" "${presetDir}"`,
    );
  } catch {
    /* 读失败不影响启动 */
  }
}

async function ensurePresetInstalled(ctx, dshHome, preset) {
  const presetDir = join(dshHome, ".agent-presets", preset);
  const sourceDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "preset", preset);
  try {
    if (existsSync(join(presetDir, "agent.cordis.yml"))) {
      ctx.logger.info(`[dsh-code-pipeline] agent preset \"${preset}\" already installed at ${presetDir}`);
      warnIfPresetPersonaIsStale(ctx, join(presetDir, "agent.cordis.yml"), presetDir);
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
  spillAllFields: Schema.boolean()
    .default(true)
    .description("是否把派发给子代理的完整消息整体写入单个临时文件（true 一律落盘；false 仅超过 largeFieldLines 行时落盘）"),
  stages: Schema.object({
    plan: STAGE_SCHEMA.default({ ...DEFAULT_STAGES.plan }),
    impl: STAGE_SCHEMA.default({ ...DEFAULT_STAGES.impl }),
    review: STAGE_SCHEMA.default({ ...DEFAULT_STAGES.review }),
  }).default({
    plan: { ...DEFAULT_STAGES.plan },
    impl: { ...DEFAULT_STAGES.impl },
    review: { ...DEFAULT_STAGES.review },
  }),
  followupMode: Schema.union([Schema.const("steer"), Schema.const("queue")])
    .default("steer")
    .description("给已派发的阶段子代理发消息（pipeline_followup）的默认投递方式：steer = 插入（运行中最近步骤即收到，不排队）；queue = 排队（当前回合结束后按顺序处理）"),
});

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

/** 给子代理发消息的默认投递方式：steer = 插入（最近步骤收到），queue = 排队（回合后处理）。 */
function resolveFollowupMode(source) {
  const settings = source() ?? {};
  return settings.followupMode === "queue" ? "queue" : "steer";
}

function buildStageToolDef(ctx, stage, source, cfg) {
  return {
    name: stage.toolName,
    description: stage.description,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        description: {
          type: "string",
          description:
            "A short (3-5 word) label shown as this subagent's name in the subagent list (e.g. \"plan tokens cleanup\"). Provide it when convenient; it falls back to the tool name.",
        },
        prompt: {
          type: "string",
          description:
            "The complete, self-contained task for the stage subagent. It does not share this conversation's context, so include everything it needs (task statement, plan, review issues, captured diff, ...). Alias 'task' is also accepted; prompt wins when both are given.",
        },
        task: {
          type: "string",
          description: "Alias for prompt (models that name the delegation payload 'task' still work).",
        },
        run_in_background: {
          type: "boolean",
          description:
            "FIXED: stages are background-only — always returns a durable subagentId and notifies this session when it settles; false is rejected. Very short tasks should NOT be dispatched at all.",
        },
        ...Object.fromEntries(
          STAGE_INPUTS[stage.key].map((input) => [
            input.key,
            { type: "string", description: input.hint + " It is merged into the child's prompt — never silently dropped." },
          ]),
        ),
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "subagentId"],
        properties: {
          kind: { type: "string", const: "continuable" },
          subagentId: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `started stage subagent ${value.subagentId}; the runtime will notify this session when it settles`,
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
      // 契约校验：只接受本阶段声明的键。未知键绝不被静默剥离——立即报错并列出
      // 支持的键，让“物料未到达子代理”变得可见。
      const knownKeys = new Set([
        "description",
        "prompt",
        "task",
        "run_in_background",
        ...STAGE_INPUTS[stage.key].map((input) => input.key),
      ]);
      const unknownKeys = Object.keys(args ?? {}).filter((key) => !knownKeys.has(key));
      if (unknownKeys.length > 0) {
        throw new Error(
          `${stage.toolName}: unknown parameter(s) ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")} — supported keys: ${[...knownKeys].sort().join(", ")}. Pass per-material fields (context/plan/constraints/implementationSummary/diff/focus) as separate string params; they are merged into the child's prompt, never silently dropped.`,
        );
      }
      // 硬校验：review 的 diff 必须是完整补丁文本（含 @@ 块头）——禁止"统计摘要/
      // 引用"类物料（如 "see git show / 完整 diff 见…"），子代理无 shell，无法自行抓取。
      if (stage.key === "review" && typeof args.diff === "string" && args.diff.trim().length > 0 && !args.diff.includes("@@")) {
        throw new Error(
          `${stage.toolName}: diff must be the FULL diff text (git diff / git show output with @@ hunk headers) — stat-only summaries or "see git show" references are rejected (the review subagent has no shell and cannot run git). Pass the raw patch text; the whole dispatch message is auto-spilled to a single temp file.`,
        );
      }
      // 完整派发消息（prompt + 所有阶段输入合并）默认整体写入单个临时文件并替换
      // 为路径引用——子代理只需 read 一次；spillAllFields=false 时仅超阈值落盘。
      const { fullPrompt } = await materializeDispatchMessage(stage, args, promptText, cfg);
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
        prompt: [{ type: "text", text: fullPrompt }],
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
      // 固定后台：阶段工具一律返回 durable subagentId 并结束回合；完成时
      // runtime 通过父会话 inbox 发送通知（含 outcome 与最终回复），可用
      // list_agents 查看状态、subagent.history 取回结果。run_code 有 20 分钟
      // wall-clock 上限，前台等待必然被截断，因此显式 false 直接拒绝。
      if (args.run_in_background === false) {
        throw new Error(
          `${stage.toolName} is background-only: it always returns a subagentId and notifies this session when it settles — do not wait inside the current turn (run_code is capped at a 20-minute wall clock). Very short tasks should not be dispatched at all; handle them directly in the main session.`,
        );
      }
      // 显式守卫（双版本兼容）：宿主 subagents 服务缺少 startContinuable
      //（服务形状漂移 / 版本不匹配）时，给出可诊断的明确错误而不是裸 TypeError。
      if (typeof subagents?.startContinuable !== "function") {
        throw stageUnavailable(
          stage,
          'subagent service is unavailable: subagents.startContinuable is not a function on ctx.get("subagents") — this host version cannot dispatch continuable stage subagents',
        );
      }
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
        const childId = String(cont.childId);
        dispatched.set(childId, {
          childId,
          stage: stage.key,
          label: descriptionText,
          parentId: parent.id,
          at: Date.now(),
        });
        return { kind: "continuable", subagentId: childId };
      } catch (error) {
        throw stageUnavailable(stage, `subagent could not start (background): ${error?.message ?? String(error)}`);
      }
    },
  };
}

// ── 阶段子代理跟踪 + 跟进插入工具 ─────────────────────────────────────────────
// pipeline_followup 解决"已派发的阶段子代理要改需求"：走宿主原生
// subagents.sendMessage（alpha.4 语义 = 插入/steer——运行中的子代理在最近
// 步骤就收到消息，而不是排队等当前回合结束），并免去模型先 list_agents
// 再对号入座的步骤。纯插件侧实现，不依赖任何宿主改动。

/** 本插件派发过的阶段子代理（childId → 元信息）。 */
const dispatched = new Map();

const STAGE_ALIASES = {
  plan: "plan", "规划": "plan", "计划": "plan",
  impl: "impl", "实现": "impl", "编码": "impl",
  review: "review", "评审": "review", "审查": "review",
};

/** 按查询解析最近派发的阶段子代理 id；无命中返回 undefined。 */
function resolveDispatchedChild(query, parentId) {
  const owned = [...dispatched.values()].filter((entry) => entry.parentId === parentId);
  if (owned.length === 0) return undefined;
  const q = (query ?? "").trim().toLowerCase();
  if (q === "" || q === "latest") {
    return owned.reduce((best, entry) => (entry.at > best.at ? entry : best), owned[0]).childId;
  }
  if (dispatched.has(q)) return q;
  const alias = STAGE_ALIASES[q];
  if (alias !== undefined) {
    const matches = owned.filter((entry) => entry.stage === alias);
    if (matches.length === 0) return undefined;
    return matches.reduce((best, entry) => (entry.at > best.at ? entry : best), matches[0]).childId;
  }
  const prefixHits = owned.filter((entry) => entry.childId.startsWith(q));
  return prefixHits.length === 1 ? prefixHits[0].childId : undefined;
}

function buildFollowupToolDef(ctx, source, cfg) {
  return {
    name: "pipeline_followup",
    description:
      "Send a requirement change to an already-dispatched pipeline stage subagent using the plugin's configured delivery mode (设置 → 代码流水线 → 子代理消息投递): " +
      "steer = INSERT the message (a working child steers its nearest step — the very next model step sees it; idle/settled children wake into a new turn); queue = PARK the message (processed as a new turn after the child's current turn ends). " +
      "child accepts: \"latest\" (most recent stage subagent this agent started) | a stage key (plan | impl | review) or its Chinese alias (规划/计划/实现/评审/审查) | an exact subagentId (session-...). " +
      "Prefer this over dispatching a new stage when the user updates a requirement mid-flight.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["child", "message"],
      properties: {
        child: {
          type: "string",
          description: "Which stage subagent to target: latest | plan | impl | review | 规划/计划 | 实现 | 评审/审查 | exact subagentId.",
        },
        message: {
          type: "string",
          description: "The requirement change to insert. Complete and self-contained (the child does not share this conversation's context).",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok", "childId", "stage"],
        properties: {
          ok: { type: "boolean", const: true },
          childId: { type: "string" },
          stage: { type: "string" },
          // 投递回执(宿主 sendMessage/prompt 返回);undefined 时 JSON 序列化会省略
          // 该键,不影响 strict additionalProperties 校验。
          messageId: { type: "string" },
          // 投递回执(宿主 sendMessage/prompt 返回);undefined 时 JSON 序列化
          // 会省略该键,不影响 strict additionalProperties 校验。
          messageId: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `requirement change delivered to stage subagent ${value.childId} (${value.stage})` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error("pipeline_followup requires a calling agent (exec.agent was undefined)");
      if (typeof args.message !== "string" || args.message.trim().length === 0) {
        throw new Error("pipeline_followup: \"message\" must be a non-empty string");
      }
      const childId = resolveDispatchedChild(String(args.child ?? ""), parent.id);
      if (childId === undefined) {
        const owned = [...dispatched.values()].filter((entry) => entry.parentId === parent.id);
        throw new Error(
          `pipeline_followup: no stage subagent matches child="${String(args.child)}" — this agent has dispatched: `
          + (owned.map((entry) => `${entry.stage}(${entry.label})`).join(", ") || "(none)"),
        );
      }
      const subagents = ctx.get("subagents");
      if (!subagents) {
        throw new Error("pipeline_followup: subagent service is unavailable");
      }
      const mode = resolveFollowupMode(source);
      let messageId;
      try {
        if (mode === "queue") {
          // 排队投递：宿主原生 human-queue 通道（subagents.prompt，永远排到
          // 当前回合之后）。alpha.4 wire 判别符是 'continuable'；未来宿主改为
          // 'queue' 时回退重试一次——两种宿主全兼容。
          messageId = await queueFollowupMessage(subagents, parent, childId, args.message, exec.signal);
        } else {
          if (typeof subagents.sendMessage !== "function") {
            throw new Error("pipeline_followup: subagent messaging service is unavailable");
          }
          messageId = await subagents.sendMessage(
            parent,
            childId,
            [{ type: "text", text: args.message }],
            { signal: exec.signal },
          );
        }
      } catch (error) {
        throw new Error(`pipeline_followup delivery failed: ${error?.message ?? String(error)}`);
      }
      const entry = dispatched.get(childId);
      return { ok: true, childId, stage: entry?.stage ?? "unknown", messageId };
    },
  };
}
/**
 * 通过宿主 human-queue 通道排队投递一条消息到子代理（当前回合结束后处理）。
 * 零依赖：直接调用 subagents.prompt Remote（服务方法进程内可直接调用）。
 *
 * 载荷按宿主版本探测（首个被接受的形状即返回）：
 *   1. dsh 0.1.3-alpha.2+：control schema 要求 mode:'continuable' + delivery:'queue'
 *      （delivery 是必填枚举；缺失即 gateway/bad-request）。
 *   2. alpha.4：只有 mode:'continuable'。
 *   3. 更早/未来宿主：mode:'queue'。
 * 仅对 "invalid payload for subagent.prompt" 这一种校验失败继续探测，其他错误原样抛出。
 */
async function queueFollowupMessage(subagents, parent, childId, text, signal) {
  // 显式守卫：宿主缺少 prompt 通道（human-queue）时给出明确错误而不是 TypeError；
  // 调用方（pipeline_followup）会再包一层 delivery failed 上下文。
  if (typeof subagents?.prompt !== "function") {
    throw new Error("pipeline_followup: queue delivery unavailable — subagents.prompt is not a function on ctx.get(\"subagents\") (host does not support the human-queue channel)");
  }
  const base = {
    requestId: `pipeline-followup-${randomUUID()}`,
    parentSessionId: parent.id,
    childSessionId: childId,
    content: [{ type: "text", text }],
  };
  const isBadPayload = (error) =>
    error?.code === "gateway/bad-request" && error?.message === "invalid payload for subagent.prompt";
  const attempts = [
    { ...base, mode: "continuable", delivery: "queue" },
    { ...base, mode: "continuable" },
    { ...base, mode: "queue" },
  ];
  let lastError;
  for (const payload of attempts) {
    try {
      const receipt = await subagents.prompt(payload, signal);
      return receipt?.messageId;
    } catch (error) {
      if (!isBadPayload(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}



// ── 注入管理 ─────────────────────────────────────────────────────────────────

export async function apply(ctx, config = {}) {
  // 防御性默认值：dsh-app-boot 的 loader 不一定会对 bundle 插件行应用导出的
  // Config schema 默认值（实测 apply 收到的 config 缺少 preset 等字段）；
  // 这里显式兜底，保证注入守卫比较的是"code-pipeline"而不是 undefined。
  const preset = config.preset ?? "code-pipeline";
  const providerName = config.providerName ?? "spawn";
  const maxDepth = config.maxDepth ?? 1;
  const largeFieldLines = config.largeFieldLines ?? 100;
  const spillAllFields = config.spillAllFields ?? true;
  const runtime = { preset, providerName, maxDepth, largeFieldLines, spillAllFields };

  // 预设自动安装：仅当目标预设缺失时从包内 preset/ 拷贝（幂等、不覆盖）。
  const dshHome = (typeof process !== "undefined" && process.env && process.env.DSH_HOME) || join(homedir(), ".dsh");
  await ensurePresetInstalled(ctx, dshHome, preset);
  await cleanOldTempFiles();

  // 设置来源：先组合配置，settings 服务出现后切换到解析后的作用域（实时）。
  // 阶段工具每次调用都读 source()，因此设置变更即时生效。
  // dsh 0.1.2-alpha.3：模块级 installSettingsSection 已移除，改为
  // ctx.settings.installSection（SettingsProvider 实例方法，签名不变）；
  // 无 settings 服务时注入不触发，回退组合配置——与旧版语义完全一致。
  let source = () => config;
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, "code-pipeline", Config, config, {
      setSource: (next) => {
        source = next;
      },
      onChange: () => {
        // 无需重新注入：工具调用时读取最新设置。
      },
    });
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
    tools.register(buildFollowupToolDef(ctx, source, runtime));
    injected.add(agent.id);
    pending.delete(agent);
    ctx.logger.info(
      `[dsh-code-pipeline] injected ${STAGES.length} stage tools + pipeline_followup into agent "${agent.id}" (preset "${preset}", provider "${providerName}")`,
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