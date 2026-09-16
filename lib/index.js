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

import { existsSync, readFileSync } from "node:fs";
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

// ── 默认值：所有阶段统一 deepseek-official / deepseek-flash；思考等级留空
//    （""）表示继承 provider 路由级默认（如 llm-deepseek.reasoningEffort: max）──
//    deepseek-flash = DeepSeek-V41-Flash：dsh 0.1.5-rc.1 起宿主的默认模型 id
//    （bundle 的 agent-default-model 同款）。旧 id deepseek-v4-flash 仍在默认目录里，
//    但宿主目录可被 settings.yaml 的 llm-deepseek.models 收窄（只列新模型），
//    插件默认值必须落在默认目录内，否则未配置阶段的派发会解析不到模型。

const DEFAULT_STAGES = {
  plan: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "", maxConcurrency: 0, budgetMinutes: 0 },
  impl: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "", maxConcurrency: 0, budgetMinutes: 0 },
  review: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "", maxConcurrency: 0, budgetMinutes: 0 },
};

// ── 各阶段 persona（与预设行文本一致；子代理创建时作为请求 persona 传入）────────
// 角色边界是硬约束：plan 只做规划、review 只做审查 —— persona 里明确写出，避免
// 主代理把审查任务误派给 plan（或把规划任务误派给 review）时子代理仍然照做。

const PERSONAS = {
  plan: `You are a PTC (Code Mode) subagent: your tools arrive through the generated SDK — call them as \`await tools.name(args)\` inside \`run_code\` programs, bundling your read-only research into as few programs as practical. You are the PLANNING stage of a coding pipeline. Your ONLY role is planning: given the task statement, research the codebase yourself first — read the relevant modules and files (with paths), data flow, dependencies, constraints, existing patterns to reuse, and risks — then produce a decision-complete implementation plan: goal and success criteria; changes grouped by subsystem with exact file paths; public API, schema, and data-flow impacts; edge cases and failure modes; tests and acceptance criteria; explicit assumptions. Verify claims by reading the actual code; never guess. Prefer existing functions and patterns. Format the plan as clean Markdown (a title heading, sections per subsystem, exact file paths in code spans, acceptance criteria) so it can be presented to the user unchanged. Keep it concise enough to review, detailed enough that another engineer implements it without making design decisions. **End every plan with a \`## Workstreams\` dispatch map.** Either the single line \`Workstreams: single workstream\` (small, single-file, or inherently serial work) or a table \`| id | goal | owned files (exact paths or globs) | depends on | acceptance check |\` plus one line naming which workstreams can run in parallel. Hard rules: **no file may appear in two workstreams** (parallel implementers would overwrite each other); shared serialization points (package.json, lockfiles, index/barrel files, migrations, generated files) go into a final \`integration\` workstream that depends on the others; a workstream must be worth its own subagent (roughly: more than one file, or more than ~15 minutes of work) — never split one coherent change into pieces that cannot be verified apart; every workstream carries its own acceptance check so its implementer can verify locally. You have no write tools by design — the plan is executed by a later stage, not you. You NEVER review, audit, verify, or approve an implementation, and you never issue APPROVED / CHANGES REQUIRED verdicts — that is the REVIEW stage's job. If the prompt asks you to review code or audit a change set, state that planning is your only role and decline, returning your planning output only. Your dispatch message may arrive as a TEMP FILE path reference — ALWAYS read the referenced file with the read tool first; do not expect its content inline.`,
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
"Pipeline PLAN stage. CONTRACT: params = prompt|task (task text; one of them required) + description (display label, optional) + context? + constraints? (both merged into the child's prompt, never dropped). Unknown keys are rejected. BACKGROUND-ONLY: returns { kind: 'continuable', subagentId } immediately; the runtime notifies this session when it settles — the child's final reply arrives in this session as a settled notice; read the plan from that notice. PLANNING ONLY: never use it to review/audit/verify/approve code (that is subagent_review's job). PRESENTATION RULE: print the plan as a normal Markdown reply and END the turn — NEVER call ask_user_question to confirm it. The stage model is configured in Settings → 代码流水线. The whole dispatch message (prompt + all stage inputs) is written to a SINGLE temp file automatically — the child reads that one file with the read tool; never inline large material into these fields (inline generation is truncated at the model output limit)." +
      "WorkSpace hygiene is ABSOLUTE: never create ANY material or intermediate file inside the workspace — not in the workspace root, not in `.pipeline-tmp/`, not in any subdirectory (no `*.diff` / `.review_*.diff` dumps, no change-set files, nothing). If an artifact is genuinely needed, write it EXCLUSIVELY to `$env:TEMP\\dsh-code-pipeline\` (system temp, outside the workspace) and delete it before this call returns. The review diff travels in the diff/implementationSummary parameters — never as workspace files." +
      " CONCURRENCY & CREATION CAP: each stage has its own cap (Settings → 代码流水线 → 最大并发; 0 = unlimited) covering BOTH the children running at once AND the total number of children ever CREATED for this session × stage. A call rejected for the RUNNING cap is TRANSIENT, not a stage failure — do NOT stop the task: wait for a settled notice, then send the remaining work to the child you already have with pipeline_followup instead of creating another. A call rejected for the CREATION cap is a policy refusal of the creation itself, still NOT a stage failure — the rejection lists the subagent ids, labels and activity you can reuse: pick one and deliver there with pipeline_followup, and when that child's accumulated history actively interferes with the new work pass compact: true so it is compacted before delivery; a child settling does NOT free a creation slot (the cap counts creations), only reuse does. When independent targets are genuinely first-round work, dispatch them in PARALLEL in ONE program (Promise.all) so they work simultaneously and the work finishes sooner.",
  },
  {
    key: "impl",
    toolName: "subagent_impl",
    label: "实现（impl）",
    readOnly: false,
    persona: PERSONAS.impl,
    description:
"Pipeline IMPLEMENTATION stage. CONTRACT: params = prompt|task (required) + description (label) + context? + plan? + constraints? (all merged into the child's prompt, never dropped); unknown keys are rejected. BACKGROUND-ONLY: returns { kind: 'continuable', subagentId } immediately; the runtime notifies this session when it settles — the child's final reply arrives in this session as a settled notice; collect the implementation summary from that notice. DELEGATION RULE: after the plan is approved (in-chat gate) or the user directly asked for the change, call THIS tool — do not implement the change yourself in the main session; call THIS tool for the FIRST round of a workstream; send every LATER round of that same workstream (issues from CHANGES REQUIRED, a requirement the user changed mid-flight, a wall-clock continue) to the child you already have with pipeline_followup (child = its exact subagentId). The stage model is configured in Settings → 代码流水线. The whole dispatch message (prompt + all stage inputs) is written to a SINGLE temp file automatically — the child reads that one file with the read tool; never inline large material into these fields (inline generation is truncated at the model output limit)." +
      "WorkSpace hygiene is ABSOLUTE: never create ANY material or intermediate file inside the workspace — not in the workspace root, not in `.pipeline-tmp/`, not in any subdirectory (no `*.diff` / `.review_*.diff` dumps, no change-set files, nothing). If an artifact is genuinely needed, write it EXCLUSIVELY to `$env:TEMP\\dsh-code-pipeline\` (system temp, outside the workspace) and delete it before this call returns. The review diff travels in the diff/implementationSummary parameters — never as workspace files." +
      " CONCURRENCY & CREATION CAP: each stage has its own cap (Settings → 代码流水线 → 最大并发; 0 = unlimited) covering BOTH the children running at once AND the total number of children ever CREATED for this session × stage. A call rejected for the RUNNING cap is TRANSIENT, not a stage failure — do NOT stop the task: wait for a settled notice, then send the remaining work to the child you already have with pipeline_followup instead of creating another. A call rejected for the CREATION cap is a policy refusal of the creation itself, still NOT a stage failure — the rejection lists the subagent ids, labels and activity you can reuse: pick one and deliver there with pipeline_followup, and when that child's accumulated history actively interferes with the new work pass compact: true so it is compacted before delivery; a child settling does NOT free a creation slot (the cap counts creations), only reuse does. When independent targets are genuinely first-round work, dispatch them in PARALLEL in ONE program (Promise.all) so they work simultaneously and the work finishes sooner.",
  },
  {
    key: "review",
    toolName: "subagent_review",
    label: "评审（review）",
    readOnly: true,
    persona: PERSONAS.review,
    description:
"Pipeline REVIEW stage. CONTRACT: params = prompt|task (required) + description (label) + context? + plan? + implementationSummary? + diff? + focus? (all merged into the child's prompt, never dropped); unknown keys are rejected. BACKGROUND-ONLY: returns { kind: 'continuable', subagentId } immediately; the runtime notifies this session when it settles — the child's final reply arrives in this session as a settled notice; merge the verdict from that notice. Its reply starts with APPROVED or CHANGES REQUIRED: followed by numbered issues. REVIEWING ONLY: never use it to plan/design/propose implementations; after impl settles call THIS tool for the verdict — do not audit or judge the change yourself. HARD RULE: the diff field must be the FULL patch text (contains @@ hunk headers) — stat-only or 'see git show' references are rejected; the whole dispatch message is auto-spilled to a single temp file the child reads via the read tool. The stage model is configured in Settings → 代码流水线." +
      "WorkSpace hygiene is ABSOLUTE: never create ANY material or intermediate file inside the workspace — not in the workspace root, not in `.pipeline-tmp/`, not in any subdirectory (no `*.diff` / `.review_*.diff` dumps, no change-set files, nothing). If an artifact is genuinely needed, write it EXCLUSIVELY to `$env:TEMP\\dsh-code-pipeline\` (system temp, outside the workspace) and delete it before this call returns. The review diff travels in the diff/implementationSummary parameters — never as workspace files." +
      " CONCURRENCY & CREATION CAP: each stage has its own cap (Settings → 代码流水线 → 最大并发; 0 = unlimited) covering BOTH the children running at once AND the total number of children ever CREATED for this session × stage. A call rejected for the RUNNING cap is TRANSIENT, not a stage failure — do NOT stop the task: wait for a settled notice, then send the remaining work to the child you already have with pipeline_followup instead of creating another. A call rejected for the CREATION cap is a policy refusal of the creation itself, still NOT a stage failure — the rejection lists the subagent ids, labels and activity you can reuse: pick one and deliver there with pipeline_followup, and when that child's accumulated history actively interferes with the new work pass compact: true so it is compacted before delivery; a child settling does NOT free a creation slot (the cap counts creations), only reuse does. When independent targets are genuinely first-round work, dispatch them in PARALLEL in ONE program (Promise.all) so they work simultaneously and the work finishes sooner.",
  },
];

// ── 阶段 label 前缀（让"持久"的宿主 label 也能归属阶段）──────────────────────
// 宿主 subagents.listChildren 的行只有 id / label / activity（control-types.ts:33-62），
// 没有 stageKey；插件台账 dispatched 重启即丢。把阶段 key 写进 label 前缀后，宿主那
// 一侧就成了**持久**的阶段标记——label 来自 startContinuable 的 descriptor
// （continuation.ts:117-126 的 snapshotSubagentDescriptor({ label: spec.label })）。

const STAGE_LABEL_RE = /^(plan|impl|review)\//;

/**
 * 阶段子代理的显示名（durable label 的唯一来源）。
 *
 * **只在输入已带「当前阶段」前缀时原样保留**；带了**别的阶段**前缀时一律再加当前前缀
 * （`impl` + `plan/auth refactor` → `impl/plan/auth refactor`）。绝不能原样保留别的
 * 阶段前缀：重启后台账丢失，阶段归属只剩 label 前缀（stageOfChildRow → stageFromLabel），
 * 一个被判成 plan 的 impl 子代理会让 impl 的创建上限被穿透（计数少 1）、plan 被误拒。
 *
 * base 为空时用 stageKey。request.label / startContinuable 的 label / 台账三处必须用
 * 同一个字符串，宿主 label 与台账才一致。
 */
function stageLabel(stageKey, descriptionText) {
  const base = String(descriptionText ?? "").trim();
  if (base.startsWith(`${stageKey}/`)) return base;
  return `${stageKey}/${base.length > 0 ? base : stageKey}`;
}

/** 从 label 反解阶段 key；没有可识别前缀时返回 undefined。 */
function stageFromLabel(label) {
  const match = STAGE_LABEL_RE.exec(String(label ?? "").trim());
  return match === null ? undefined : match[1];
}

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
  maxConcurrency: Schema.number()
    .min(0)
    .max(64)
    .default(0)
    .description("同时运行的并发上限 + 已创建（含已结束）总量上限；到达已创建上限后新的派发被拒绝，错误会列出可复用的子代理 id，请用 pipeline_followup 复用（有干扰时先压缩再复用）。0 = 不限制（沿用旧行为）。仍受宿主每个 run_code 程序最多 10 个并行子调用的上限约束"),
  budgetMinutes: Schema.number()
    .min(0)
    .max(1440)
    .default(0)
    .description("该阶段单次派发的墙钟预算（分钟）；0 = 不限制。超时后插件中断该子代理的当前回合（Activation 与 inbox 保留，之后仍可用 pipeline_followup 续跑），并自动排队一条收尾报告指令，让它汇报已完成 / 半成品 / 未完成 / 风险，供主代理决定续跑、拆分还是停止。只对之后的派发生效"),
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

/**
 * 已安装副本与包内副本的一致性自检（只读、只警告，绝不改写用户文件）。
 * 插件升级后预设不会自动覆盖（预设是用户可编辑资产），但副本落后会让行为对不上；
 * 这里给出「无本地改动就覆盖」的可操作提示。 */
function warnIfPresetDiffersFromBundle(ctx, compositionPath, sourcePath, sourceDir, presetDir) {
  try {
    if (!existsSync(sourcePath)) return;
    if (readFileSync(compositionPath, "utf8") === readFileSync(sourcePath, "utf8")) return;
    ctx.logger.warn(
      `[dsh-code-pipeline] installed preset at ${presetDir} differs from the bundled copy (${sourcePath}) — the plugin may ship a newer preset. If you have no local edits, refresh it: Copy-Item -Recurse -Force "${sourceDir}" "${presetDir}" (see README 「升级同步」)`,
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
      warnIfPresetDiffersFromBundle(ctx, join(presetDir, "agent.cordis.yml"), join(sourceDir, "agent.cordis.yml"), sourceDir, presetDir);
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

const STAGES_SCHEMA = Schema.object({
  plan: STAGE_SCHEMA.default({ ...DEFAULT_STAGES.plan }),
  impl: STAGE_SCHEMA.default({ ...DEFAULT_STAGES.impl }),
  review: STAGE_SCHEMA.default({ ...DEFAULT_STAGES.review }),
}).default({
  plan: { ...DEFAULT_STAGES.plan },
  impl: { ...DEFAULT_STAGES.impl },
  review: { ...DEFAULT_STAGES.review },
});

const FOLLOWUP_MODE_SCHEMA = Schema.union([Schema.const("steer"), Schema.const("queue")])
  .default("steer")
  .description("给已派发的阶段子代理发消息（pipeline_followup）的默认投递方式：steer = 插入（运行中最近步骤即收到，不排队）；queue = 排队（当前回合结束后按顺序处理）");

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
  largeFieldLines: Schema.number()
    .min(0)
    .default(100)
    .description("spillAllFields=false 时，派发消息超过该行数才整体落盘（默认 100）"),
  stages: STAGES_SCHEMA,
  followupMode: FOLLOWUP_MODE_SCHEMA,
});

// 设置节 schema：只暴露真正"改了会生效"的两项。preset / providerName / maxDepth /
// spillAllFields / largeFieldLines 是组合配置（cordis.patch.yml / profile patch 层），
// 从设置页写它们不会生效——不把它们放进设置节，避免出现"写了没反应"的开关。
const SettingsSchema = Schema.object({
  stages: STAGES_SCHEMA,
  followupMode: FOLLOWUP_MODE_SCHEMA,
});

// ── 工具构造 ─────────────────────────────────────────────────────────────────

/** 阶段不可用时的统一指导文本：要求主代理结束任务并告知用户,而不是自己接手。 */
const UNAVAILABLE_GUIDANCE =
  "Pipeline stage UNAVAILABLE — STOP and report to the user (state what failed and why); do NOT continue the task yourself (do not implement, plan, or review in place), do not retry on another route, and do not invent a substitute. Wait for the user's decision.";

function stageUnavailable(stage, detail) {
  return new Error(`${stage.toolName}: ${detail}\n\n${UNAVAILABLE_GUIDANCE}`);
}

/**
 * 并发上限拒绝：这是**瞬时策略拒绝**，不是阶段不可用——绝不能套用
 * UNAVAILABLE_GUIDANCE（那会让主代理终止整个任务）。
 *
 * `running` 与 `starting` 必须分开报：调用点的计数含「本次程序里仍在创建中的兄弟
 * 派发」（pendingStageStarts）。旧文案把两者一律说成 "already running" 并教模型
 * 「等一条完成通知」——当在跑数是 0、名额全被在途创建占着时，那句指引会让模型空等一个
 * 永远不会到来的 settle 通知（测试 A5 的两个被拒调用正是这种形状）。
 */
function stageConcurrencyReached(stage, running, starting, limit) {
  const runningCount = Math.max(0, running ?? 0);
  const startingCount = Math.max(0, starting ?? 0);
  const detail = [
    runningCount > 0 ? `${runningCount} running` : "",
    startingCount > 0 ? `${startingCount} starting (dispatch in flight)` : "",
  ].filter((part) => part.length > 0).join(" + ") || "0 running";
  return new Error(
    `${stage.toolName}: stage concurrency limit reached — ${detail} for stage "${stage.label}" in this session (limit ${limit}; Settings → 代码流水线 → 最大并发). `
    + "This is NOT a stage failure and NOT a reason to stop the task. "
    + (runningCount === 0 && startingCount > 0
      ? "No child of this stage is actually running: the slot(s) are held by dispatch(es) still being created in the same program, so a settled notice will NOT free one — retry this target in a LATER step (once those creations have been admitted) and reuse the child you already have with pipeline_followup. "
      : "Wait for a settled notice, then reuse the child you already have with pipeline_followup instead of dispatching another. ")
    + "Reminder: a REUSE (pipeline_followup to an existing child) never counts against either cap — reuse is always available.",
  );
}

/**
 * 创建数量上限拒绝：与 stageConcurrencyReached 同级、同为**瞬时策略拒绝**——绝不能
 * 套用 UNAVAILABLE_GUIDANCE（那会让主代理终止整个任务）。它拒绝的是"再创建一个子代理"
 * 这件事，阶段本身是健康的。
 *
 * 文案必须自带可复用清单与出路：PTC 只把 message 交给模型（终态形状 { kind, message }，
 * error.code 不进模型上下文），所有可操作指引只能写进这段文本。
 */
/**
 * 「暂时无法核实创建数」拒绝：宿主 listChildren 瞬时失败，且本进程还没有任何一次成功
 * 的观测（高水位为 0）。此时**绝不能按 0 放行**——那会把重启后的持久面整体旁路，创建
 * 上限形同虚设（实测可复现）。与另外两条拒绝一样是瞬时策略拒绝、不是阶段不可用；文案
 * 必须说清是暂时性的、可重试。
 */
function stageCreationCapUnverifiable(stage, limit) {
  return new Error(
    `${stage.toolName}: the stage CREATION count for "${stage.label}" CANNOT BE VERIFIED right now — the host subagent listing (subagents.listChildren) failed transiently and this process has no successful observation of this session's created-child count yet (limit ${limit}; Settings → 代码流水线 → 最大并发). `
    + "This is NOT stage unavailability and NOT a stage failure: it is a TRANSIENT inability to verify the cap, so this dispatch was refused instead of being silently let past it. "
    + "Retry this dispatch in a LATER step (such listing failures are usually momentary); if it keeps failing, report to the user that the stage cap cannot be verified on this host. "
    + "Reuse is unaffected: pipeline_followup to a child whose exact subagentId you already know stays available.",
  );
}

function stageCreationCapReached(stage, used, limit, available) {
  const listing = available.length === 0
    ? "  (no reusable child is visible right now — if you already have one, target it by the exact subagentId from its settled notice)"
    : available.map((row) => `  - ${row.id}  "${row.label}"  [${row.activity}]`).join("\n");
  return new Error(
    `${stage.toolName}: stage CREATION limit reached — ${used} child(ren) of stage "${stage.label}" have already been CREATED for this agent (limit ${limit}; Settings → 代码流水线 → 最大并发). `
    + "This is NOT stage unavailability and NOT a stage failure — do NOT report UNAVAILABLE and do NOT stop the task: the stage is healthy, and what was refused is POLICY on CREATING another child. "
    + "（这里报 UNAVAILABLE 是错的：阶段是健康的，这是对「创建」的策略上限。）\n"
    + "This cap counts CREATIONS, not running children: settled / stopped / lost children still occupy their creation slot, so waiting for a child to settle does NOT free a slot — only REUSE does.\n"
    + `Reusable stage subagents you already have for this stage (a REUSE never counts against either cap):\n${listing}\n`
    + "Your next step — one of these three:\n"
    + "  1) REUSE an existing child: call pipeline_followup with child = an exact id from the list above, carrying your new/updated requirement.\n"
    + "  2) If that child's accumulated history actively interferes with the new work (the same task family but the direction changed, a new requirement reverses a conclusion it contributed, or the diff it wrote was discarded wholesale), call pipeline_followup with compact: true — it compacts THAT child's history first and delivers afterwards.\n"
    + "  3) If every reusable child is currently running, wait for its settled notice and then reuse it — do not create another child.",
  );
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

/** 模型可见的工作流切分契约（只挂在 plan 工具上）：决定 impl 能否并行派发。 */
const WORKSTREAMS_NOTE =
  " WORKSTREAMS: the plan MUST end with a `## Workstreams` dispatch map — either `Workstreams: single workstream` or a table of `id / goal / owned files (exact paths or globs) / depends on / acceptance check` with a line naming which workstreams are parallelizable. No file may appear in two workstreams; shared serialization points belong to a final integration workstream. The orchestrator uses this map to dispatch one subagent_impl per independent workstream in parallel — an unclear split costs a revision round.";

/** 模型可见的墙钟语义：预算到点是被中断 + 收尾，不是阶段不可用。 */
const WALL_CLOCK_NOTE =
  " WALL-CLOCK BUDGET: when this stage's budget (Settings → 代码流水线 → 墙钟预算) expires, the plugin interrupts the running child and queues a wrap-up report instruction. A settle notice reading \"was stopped before it finished\" is therefore NOT stage unavailability — wait for the follow-up notice carrying the child's status report, then decide: continue the same child with pipeline_followup, split the remaining work into smaller dispatches, or stop and report to the user.";

function buildStageToolDef(ctx, stage, source, cfg) {
  return {
    name: stage.toolName,
    description: stage.description + WALL_CLOCK_NOTE + (stage.key === "plan" ? WORKSTREAMS_NOTE : ""),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        description: {
          type: "string",
          description:
            "A short (3-5 word) label shown as this subagent's name in the subagent list. Provide it when convenient; omitting it falls back to this stage's tool name. The durable label is ALWAYS prefixed with the stage (e.g. \"impl/plan tokens cleanup\") — that prefix is how a subagent is still attributed to its stage after a dsh restart, so never encode another stage's prefix here.",
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
      // 显示名统一带阶段前缀（`<stage>/...`）：宿主 listChildren 的行只有
      // id/label/activity 没有 stageKey，前缀让持久面也能归属阶段。
      const label = stageLabel(stage.key, descriptionText);
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
        label,
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
      // runtime 通过父会话 inbox 发送通知（含 outcome 与最终回复）——通知本身
      // 就是最终结果，可用 list_agents 查看状态、send_message 继续子代理。
      // run_code 的墙钟默认 120 s、部署上限 600 s（可传 timeoutMs 顶到上限），
      // 前台等待必然被截断，因此显式 false 直接拒绝。
      if (args.run_in_background === false) {
        throw new Error(
          `${stage.toolName} is background-only: it always returns a subagentId and notifies this session when it settles — do not wait inside the current turn (run_code's wall clock defaults to 120 s and is capped at 600 s — pass timeoutMs to reach the cap; even the cap is far shorter than a stage). Very short tasks should not be dispatched at all; handle them directly in the main session.`,
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
      // ── 每阶段并发上限准入 ────────────────────────────────────────────────
      // 两步：① 同步先到先得准入——PTC 的 Promise.all 会让同阶段多个调用同时
      // 进入 execute，判定必须完全同步（账本 + 预留），否则并发的两个调用会互相
      // 把对方算进名额而双双被拒；② 异步核对宿主 listChildren 的真实运行数，
      // 捕获本插件账本不知道的子代理（重启前派发、被 followup 唤醒等），偏保守
      // 时可以拒绝一个刚准入的调用。整块放在所有同步守卫之后、startContinuable
      // 之前，并用 try/catch 保证任何抛出都归还预留。
      const limit = normalizeConcurrency(stageCfg.maxConcurrency);
      let reserved = false;
      if (limit > 0) {
        const runningBefore = activeStageCount(parent.id, stage.key);
        const startingBefore = pendingStageCount(parent.id, stage.key);
        if (runningBefore + startingBefore >= limit) throw stageConcurrencyReached(stage, runningBefore, startingBefore, limit);
        reserveStageStart(parent.id, stage.key);
        reserved = true;
        try {
          const hostRunning = await countRunningStageChildren(ctx, subagents, parent.id, stage.key, exec.signal);
          const running = Math.max(hostRunning ?? 0, activeStageCount(parent.id, stage.key));
          const starting = Math.max(0, pendingStageCount(parent.id, stage.key) - 1);
          if (running + starting >= limit) throw stageConcurrencyReached(stage, running, starting, limit);
        } catch (error) {
          releaseStageStart(parent.id, stage.key);
          reserved = false;
          throw error;
        }
      }
      // ── 每阶段创建数量上限准入（第二道闸门：已创建总数）───────────────────
      // 与第一道闸门并列保留：运行数管"同时有几个在跑"，创建数管"一共创建过几个"。
      // 两者共用 pendingStageStarts 这一个预留（它本来就是"正在创建中的子代理"），
      // 上面的运行准入在 limit > 0 时已经预留了本次名额，这里直接用同一个预留做同步
      // 先到先得判定，不再单独预留——两个 reserved 标志会互相覆盖，所以只保留一个，
      // 抛错时在这里一次性归还（归还后清掉标志，外层 catch 不会重复归还）。
      // PTC 的 Promise.all 会让同阶段多个调用同时进入 execute，因此先同步判定，
      // await listChildren 之后再用重算后的计数复检。
      if (limit > 0) {
        // 减掉"本次预留"（上面的运行准入已经用 pendingStageStarts 预留了本次名额）；
        // 预留标志与计数同源，所以在任何一个分支里都只归还一次。
        const startingBefore = Math.max(0, pendingStageCount(parent.id, stage.key) - (reserved ? 1 : 0));
        // 同步预判：台账 ∪ 最近一次**成功观测**的高水位（只增不减）+ 其他在途创建。
        // 高水位必须参与同步判定，否则枚举失败时同步判定会按 0 放行。
        const observedSync = observedCreated(parent.id, stage.key);
        const createdSync = Math.max(ledgerStageChildren(parent.id, stage.key).length, observedSync?.count ?? 0) + startingBefore;
        if (createdSync >= limit) {
          releaseStageStart(parent.id, stage.key);
          reserved = false;
          throw stageCreationCapReached(stage, createdSync, limit, knownStageRows(parent.id, stage.key));
        }
        try {
          // 并集真值：本进程台账 ∪ 宿主 listChildren（持久 + 本插件看不到的创建）。
          // 本次预留不算"已创建"，所以要把 pending 里的自己减掉；其余并发预留照算。
          const collected = await collectStageChildren(ctx, subagents, parent.id, stage.key, exec.signal);
          const inFlightCreations = Math.max(0, pendingStageCount(parent.id, stage.key) - 1);
          if (collected.verified === false) {
            // 枚举瞬时失败：绝不能把持久面当 0（那会整体旁路重启后的创建上限）。
            const known = Math.max(
              ledgerStageChildren(parent.id, stage.key).length,
              observedCreated(parent.id, stage.key)?.count ?? 0,
            );
            if (known === 0) throw stageCreationCapUnverifiable(stage, limit);
            const total = known + inFlightCreations;
            if (total >= limit) throw stageCreationCapReached(stage, total, limit, knownStageRows(parent.id, stage.key));
          } else {
            const total = collected.rows.length + inFlightCreations;
            if (total >= limit) throw stageCreationCapReached(stage, total, limit, collected.rows);
          }
        } catch (error) {
          releaseStageStart(parent.id, stage.key);
          reserved = false;
          throw error;
        }
      }
      try {
        // label 必须用已回退的 descriptionText（再套阶段前缀，恒为非空字符串）：
        // dsh-subagent 的 continuable descriptor 对 label 无 undefined 守卫（one-shot
        // 分支有），传 undefined 会触发 "subagent descriptor is not losslessly
        // JSON-serializable"；宿主把 spec.label 原样写进 descriptor（continuation.ts:117-126），
        // 它同时是持久面（listChildren.label）与插件台账的同一个字符串。
        const cont = await subagents.startContinuable({
          provider: cfg.providerName,
          label,
          request,
          signal: exec.signal,
        });
        const childId = String(cont.childId);
        if (reserved) {
          releaseStageStart(parent.id, stage.key);
          reserved = false;
          trackStageChild(parent.id, stage.key, childId);
        }
        dispatched.set(childId, {
          childId,
          stage: stage.key,
          label,
          parentId: parent.id,
          // 单调递增的派发序号：别名解析按 seq 比较。绝不能用 at —— rearmStageBudget
          // 会把 entry.at 改写为 Date.now()（续跑 = 新的一轮），以 at 为准时"最近派发"
          // 的语义会在续跑后漂移。
          seq: (dispatchSeq += 1),
          at: Date.now(),
          // 墙钟预算在派发时快照进账本（改设置只影响后续派发，与并发上限同语义）；
          // phase 由看门狗状态机推进：running → timed-out → wrapup → wrapup-done，
          // 自行结束为 settled，异常路径为 stopped / lost。
          budgetMs: normalizeBudgetMs(stageCfg.budgetMinutes),
          phase: "running",
          warned: false,
        });
        return { kind: "continuable", subagentId: childId };
      } catch (error) {
        if (reserved) {
          releaseStageStart(parent.id, stage.key);
          reserved = false;
        }
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

/** 派发序号（模块级自增）：别名解析的稳定比较键，见 resolveDispatchedChild。 */
let dispatchSeq = 0;

// ── 每阶段并发上限的账本（准入控制）─────────────────────────────────────────
// 计数口径：宿主 subagents.listChildren(parent.id) 中 activity === "running" 的
// 阶段子代理（权威、按父会话隔离）；再与插件自己的账本取较大值，覆盖两个盲区：
//   - pendingStageStarts：startContinuable 尚未返回时，子代理还没出现在
//     listChildren 里。PTC 的 Promise.all 会让同一阶段的多个调用同时进入
//     execute，因此预留必须发生在任何 await 之前，否则会集体超限。
//   - activeStageChildren：本插件已派发、尚未观察到 settle 的子代理。准入时会
//     用 listChildren 的结果修剪（已 settle 的移除），所以漏掉一个 end 事件也
//     不会永久占住名额。
const activeStageChildren = new Map(); // parentId → Map<stageKey, Set<childId>>
const pendingStageStarts = new Map(); // parentId → Map<stageKey, number>

function stageBucket(map, parentId, stageKey, create) {
  let perStage = map.get(parentId);
  if (perStage === undefined) {
    if (!create) return undefined;
    perStage = new Map();
    map.set(parentId, perStage);
  }
  let bucket = perStage.get(stageKey);
  if (bucket === undefined) {
    if (!create) return undefined;
    bucket = new Set();
    perStage.set(stageKey, bucket);
  }
  return bucket;
}

function pendingStageCount(parentId, stageKey) {
  return pendingStageStarts.get(parentId)?.get(stageKey) ?? 0;
}

function reserveStageStart(parentId, stageKey) {
  const perStage = pendingStageStarts.get(parentId) ?? new Map();
  perStage.set(stageKey, (perStage.get(stageKey) ?? 0) + 1);
  pendingStageStarts.set(parentId, perStage);
}

function releaseStageStart(parentId, stageKey) {
  const perStage = pendingStageStarts.get(parentId);
  if (perStage === undefined) return;
  const next = (perStage.get(stageKey) ?? 0) - 1;
  if (next > 0) perStage.set(stageKey, next);
  else {
    perStage.delete(stageKey);
    if (perStage.size === 0) pendingStageStarts.delete(parentId);
  }
}

function trackStageChild(parentId, stageKey, childId) {
  stageBucket(activeStageChildren, parentId, stageKey, true).add(childId);
}

function untrackStageChild(parentId, stageKey, childId) {
  stageBucket(activeStageChildren, parentId, stageKey, false)?.delete(childId);
}

function activeStageCount(parentId, stageKey) {
  return stageBucket(activeStageChildren, parentId, stageKey, false)?.size ?? 0;
}

/** 设置里的并发上限：非法/缺省/<=0 一律按 0（不限制）处理，上限 64。 */
function normalizeConcurrency(value) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(64, Math.trunc(parsed)) : 0;
}

/**
 * 宿主权威运行数：listChildren(parent.id) 中 activity === "running" 且属于本
 * 阶段（dispatched 里有阶段身份）的子代理数。顺带把已 settle 的子代理从本插件
 * 账本里修剪掉（自愈）。
 *
 * 宿主没有 listChildren 或查询失败时退回本插件账本，并用 live Agent 的 status
 * 修剪已 settle 的子代理——只在明确 idle 时删除，属性缺失时绝不误删（宁可少
 * 修剪，也不让上限静默失效）。
 */
async function countRunningStageChildren(ctx, subagents, parentId, stageKey, signal) {
  const bucket = stageBucket(activeStageChildren, parentId, stageKey, false);
  let rows;
  try {
    rows = typeof subagents.listChildren === "function"
      ? await subagents.listChildren(parentId, signal)
      : undefined;
  } catch {
    rows = undefined;
  }
  if (rows !== undefined) {
    let running = 0;
    for (const row of rows ?? []) {
      if (!row || row.kind !== "child") continue;
      const childId = String(row.id ?? "");
      if (dispatched.get(childId)?.stage !== stageKey) continue;
      if (row.activity === "running") running += 1;
      else bucket?.delete(childId);
    }
    return running;
  }
  if (!bucket) return 0;
  const agents = ctx.get("agents");
  if (agents && typeof agents.get === "function") {
    for (const childId of [...bucket]) {
      if (agents.get(childId)?.status === "idle") bucket.delete(childId);
    }
  }
  return bucket.size;
}

// ── 「已创建」计数（第二道硬闸门：创建数量上限）───────────────────────────────
// 口径与"运行数"完全不同：这里数的是**创建过的子代理总数**——含已 settle、已硬停
// (stopped) 与 lost 的条目；同一 workstream 的多轮复用只占 1 个名额（复用不创建），
// integration 也占 1 个。**不数"正在跑"**：等一个子代理 settle 不会腾出名额。
//
// 真值 = 本进程台账（dispatched，永不修剪）∪ 宿主 listChildren（持久，覆盖重启前
// 创建的）。阶段归属判定优先级：dispatched.get(id)?.stage → 活 agent 的
// agent.options.stageKey（child-agent.ts 原样展开 agentOptions）→ label 的
// `<stage>/` 前缀。并集偏保守（宁少放行）。
//
// **只增不减**：即使宿主某次枚举没返回某一行（子代理刚结束、投影还没落盘等），也绝不
// 把它从计数里扣掉——否则会出现"创建了但宿主暂时枚举不到"的穿透窗口，上限形同虚设。
// 代价：本会话内到顶后除复用外永不放行。这是刻意选择（上限的语义就是"创建"）。

/** 仍在推进的相位（其余相位视为 inactive，但仍占创建名额）。 */
const ACTIVE_PHASES = new Set(["running", "timed-out", "wrapup"]);

/** 台账里某 (父会话 × 阶段) 的已创建条目（只增不减）。 */
function ledgerStageChildren(parentId, stageKey) {
  const rows = [];
  for (const entry of dispatched.values()) {
    if (entry.parentId !== parentId || entry.stage !== stageKey) continue;
    rows.push({
      id: entry.childId,
      label: entry.label,
      activity: ACTIVE_PHASES.has(entry.phase) ? "running" : "inactive",
    });
  }
  return rows;
}

/**
 * 宿主可见行（一次 listChildren，带阶段归属）。
 *
 * 返回 **null = 枚举失败**，与「枚举成功但没有行」（`[]`）严格区分：调用方据此决定
 * 「保守判定」还是「按 0 放行」——把枚举失败当成空列表会让重启后的创建上限被整体旁路。
 */
async function hostStageRows(ctx, subagents, parentId, signal) {
  if (typeof subagents?.listChildren !== "function") return null;
  let rows;
  try {
    rows = await subagents.listChildren(parentId, signal);
  } catch {
    return null;
  }
  const out = [];
  for (const row of rows ?? []) {
    if (!row || row.kind !== "child") continue;
    const childId = String(row.id ?? "");
    if (childId === "") continue;
    const owner = dispatched.get(childId)?.parentId;
    if (owner !== undefined && owner !== parentId) continue;
    const label = typeof row.label === "string" && row.label.length > 0 ? row.label : undefined;
    out.push({
      id: childId,
      label,
      activity: row.activity === "running" ? "running" : "inactive",
      stage: stageOfChildRow(ctx, childId, label),
    });
  }
  return out;
}

/**
 * 台账条目 ∪ 宿主行（按 id 去重）。宿主行是活跃状态的权威、label 缺失时用台账兜底；
 * 任一侧说"在跑"就报 running（偏保守：宁可让模型等，也不要它以为可以立刻复用）。
 * `stageKey` 为 undefined 时不按阶段过滤（用于合并"已按阶段过滤过"的观测行）。
 */
function mergeStageRows(ledgerRows, hostRows, stageKey) {
  const byId = new Map();
  for (const row of ledgerRows) byId.set(row.id, row);
  for (const row of hostRows ?? []) {
    if (stageKey !== undefined && row.stage !== undefined && row.stage !== stageKey) continue;
    const known = byId.get(row.id);
    byId.set(row.id, {
      id: row.id,
      label: row.label ?? known?.label ?? row.id,
      activity: row.activity === "running" || known?.activity === "running" ? "running" : "inactive",
    });
  }
  return [...byId.values()];
}

/**
 * 每 (父会话 × 阶段) 最近一次**成功枚举**的观测：已创建计数（单调高水位）+ 当时的清单。
 *
 * 为什么需要：宿主 listChildren 是持久面唯一的来源。它瞬时失败时若把持久面当 0，重启后
 * 的创建上限就被整体旁路（计数变 0 → total < limit → 放行）。所以：
 *   - 判定取 max(高水位, 当前并集)（只增不减）；
 *   - 枚举失败且高水位为 0、limit > 0 时按「暂时无法核实」**瞬时拒绝**，不按 0 放行；
 *   - 拒绝文案用高水位那次观测的清单兜底。
 */
const createdObservation = new Map(); // parentId → Map<stageKey, { count, rows }>

function noteCreatedObservation(parentId, stageKey, rows) {
  const perStage = createdObservation.get(parentId) ?? new Map();
  const prev = perStage.get(stageKey);
  const count = Math.max(prev?.count ?? 0, rows.length);
  perStage.set(stageKey, { count, rows: rows.length >= (prev?.rows?.length ?? 0) ? rows : prev.rows });
  createdObservation.set(parentId, perStage);
  return count;
}

function observedCreated(parentId, stageKey) {
  return createdObservation.get(parentId)?.get(stageKey);
}

/** 已知的可复用清单（台账 ∪ 最近一次成功观测），枚举不可用时用于拒绝文案兜底。 */
function knownStageRows(parentId, stageKey) {
  return mergeStageRows(ledgerStageChildren(parentId, stageKey), observedCreated(parentId, stageKey)?.rows, stageKey);
}

/** 宿主行的阶段归属：台账 stage → 活 agent options.stageKey → label 前缀。 */
function stageOfChildRow(ctx, childId, label) {
  const fromLedger = dispatched.get(childId)?.stage;
  if (fromLedger !== undefined) return fromLedger;
  const agents = ctx.get("agents");
  const live = typeof agents?.get === "function" ? agents.get(childId) : undefined;
  const fromOptions = live?.options?.stageKey;
  if (typeof fromOptions === "string" && fromOptions.length > 0) return fromOptions;
  return stageFromLabel(label);
}

/**
 * 某 (父会话 × 阶段) 的「已创建」真值：台账 ∪ 宿主可见行。
 *
 * 返回 `{ rows, verified }`：`verified === false` 表示宿主枚举失败（rows 只含台账部分）。
 * 调用方必须结合 `createdObservation` 的高水位保守判定，**不得**把它当成"持久面为空"。
 */
async function collectStageChildren(ctx, subagents, parentId, stageKey, signal) {
  const ledgerRows = ledgerStageChildren(parentId, stageKey);
  // 宿主**根本没有**枚举能力（服务形状不同）：持久面不存在，台账即全部真值——按台账
  // 判定，不能因此永久拒绝所有派发（与运行闸门同一降级口径）。注意这与"枚举抛错"严格
  // 区分：后者是瞬时失败，持久面**存在但暂时读不到**，必须保守拒绝。
  if (typeof subagents?.listChildren !== "function") return { rows: ledgerRows, verified: true };
  const hostRows = await hostStageRows(ctx, subagents, parentId, signal);
  if (hostRows === null) return { rows: ledgerRows, verified: false };
  const rows = mergeStageRows(ledgerRows, hostRows, stageKey);
  noteCreatedObservation(parentId, stageKey, rows);
  return { rows, verified: true };
}

// ── 墙钟预算看门狗（超时中断 + 自动索取收尾报告）───────────────────────────────
// 宿主对子代理没有回合/步数/时长上限（agent-loop 的 Config 只有 maxParallelToolCalls，
// 工具调用超时也只管单次工具），所以一个跑飞的 impl 只能由模型自己决定停下。这里给
// 每次派发记一个墙钟预算（设置页按阶段配置），到点后：
//   ① 中断该子代理的当前回合（subagents.interrupt，authority = 派发时的父代理）——
//      只结束当前 turn，Activation、未领取的 inbox、已发布的下级都保留，因此之后
//      仍可用 pipeline_followup 把剩下的活儿交回同一个子代理（前缀还在，命中缓存）；
//   ② 排队投递一条「收尾报告」指令（host-protocol queue 通道，排到当前回合之后），
//      让它只输出文本：已完成 / 半成品 / 未完成 / 风险 / 建议——父代理随后收到的
//      settle 通知里就有可用现状，而不是只有一句 "left no closing message"；
//   ③ 收尾回合本身也有宽限（WRAPUP_GRACE_MS）：再超时就第二次中断（硬停，不再收尾）。
// 预算在派发时从设置快照读入账本：改设置只影响后续派发，与并发上限同语义。

const WATCHDOG_SWEEP_MS = 15_000;
const WRAPUP_GRACE_MS = 3 * 60_000;
const WRAPUP_IDLE_WAIT_MS = 15_000;
const WRAPUP_POLL_MS = 2_000;
const WRAPUP_DELIVERY_TIMEOUT_MS = 30_000;
// 预算用到该比例时先发一条软警告（steer 插入，让子代理有机会自己收尾）；
// 到 100% 才中断。软警告只发一次，失败也只是少一次机会，硬路径不受影响。
const SOFT_WARN_RATIO = 0.8;

/** 设置里的墙钟预算（分钟）→ 毫秒；缺省/非法/<=0 一律 0（不限制），上限 24 小时。 */
function normalizeBudgetMs(value) {
  const minutes = typeof value === "number" ? value : Number.parseFloat(String(value ?? 0));
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(minutes, 1440) * 60_000;
}

/** 超时后投给子代理的收尾报告指令：自包含、只要求文本、明确禁止继续改工作区。 */
function buildWrapupInstruction(stageKey, elapsedMs) {
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
  return [
    `[code-pipeline] The wall-clock budget for this ${stageKey} stage dispatch expired (~${minutes} min elapsed) and your current turn was interrupted.`,
    "Stop working now: do NOT edit files, do NOT run commands, do NOT start new work.",
    "Reply with ONE concise status report (plain text):",
    "1) what you completed, with the exact file paths you changed (if any);",
    "2) the state of each change (complete / half-applied);",
    "3) what is still unfinished;",
    "4) known risks or unverified parts (checks/tests not run);",
    "5) your recommendation: continue / split into smaller workstreams / revert.",
    "The orchestrator uses this report to decide the next step, so be precise and brief.",
  ].join("\n");
}

/** 预算接近用尽时的软警告：要求收尾并给出报告，说明超时会被中断。 */
function buildSoftWarning(stageKey, remainingMs) {
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  return [
    `[code-pipeline] About ${Math.round(SOFT_WARN_RATIO * 100)}% of this ${stageKey} stage dispatch's wall-clock budget is used (~${minutes} min left).`,
    "Start wrapping up NOW: finish the change you are in the middle of, do not start new work, run only the checks you actually need, and end your turn with a concise status report (done / half-applied / still left / risks).",
    "When the budget runs out the plugin interrupts this turn and asks for that report anyway — reporting before then is cheaper and keeps your work reviewable.",
  ].join("\n");
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 子代理当前是否在跑。返回 true / false，宿主查询不可用（服务缺失/查询抛错）或列表里
 * 没有这一行时返回 undefined（未知）。中断判定不依赖它——预算到点一律中断（重复中断
 * 是宿主 no-op）；收尾投递只用它决定"要不要再等一会儿"：未知时不再等待，直接排队
 * （等待改变不了未知，而把报告要回来仍然是对的）。
 */
async function childIsRunning(ctx, entry) {
  const subagents = ctx.get("subagents");
  if (typeof subagents?.listChildren !== "function") return undefined;
  try {
    const rows = await subagents.listChildren(entry.parentId);
    const row = (rows ?? []).find(
      (candidate) => candidate && candidate.kind === "child" && String(candidate.id) === entry.childId,
    );
    if (row === undefined) return undefined;
    return row.activity === "running";
  } catch {
    return undefined;
  }
}

/** 中断某阶段子代理的当前回合；授权用该子代理的 live 父代理（ancestor 授权）。 */
function interruptStageChild(ctx, entry, reason) {
  const subagents = ctx.get("subagents");
  if (typeof subagents?.interrupt !== "function") {
    entry.phase = "lost";
    ctx.logger.warn(
      `[dsh-code-pipeline] cannot interrupt ${entry.stage} subagent ${entry.childId} (${reason}): subagents.interrupt is unavailable on this host`,
    );
    return false;
  }
  const parent = ctx.get("agents")?.get(entry.parentId);
  if (!parent) {
    entry.phase = "lost";
    ctx.logger.warn(
      `[dsh-code-pipeline] cannot interrupt ${entry.stage} subagent ${entry.childId} (${reason}): parent agent ${entry.parentId} is no longer live`,
    );
    return false;
  }
  try {
    subagents.interrupt(entry.childId, { kind: "ancestor", agent: parent });
    return true;
  } catch (error) {
    entry.phase = "lost";
    ctx.logger.warn(
      `[dsh-code-pipeline] interrupt failed for ${entry.stage} subagent ${entry.childId} (${reason}): ${error?.message ?? String(error)}`,
    );
    return false;
  }
}

/**
 * 软警告（预算 SOFT_WARN_RATIO 处）：用 subagents.sendMessage（steer 语义，运行中的
 * 子代理在最近步骤就看到）提醒收尾。steer 对 idle 目标是"开一个新回合"，所以只在
 * 确认还在跑（childIsRunning === true）时才发；未知一律跳过——硬超时那条路不依赖它。
 */
async function deliverSoftWarning(ctx, entry) {
  const subagents = ctx.get("subagents");
  const parent = ctx.get("agents")?.get(entry.parentId);
  if (typeof subagents?.sendMessage !== "function" || !parent) return;
  const running = await childIsRunning(ctx, entry);
  if (running !== true) return;
  const remainingMs = Math.max(0, entry.budgetMs - (Date.now() - entry.at));
  try {
    await subagents.sendMessage(
      parent,
      entry.childId,
      [{ type: "text", text: buildSoftWarning(entry.stage, remainingMs) }],
      { signal: AbortSignal.timeout(WRAPUP_DELIVERY_TIMEOUT_MS) },
    );
    entry.warnedAt = Date.now();
    ctx.logger.info(
      `[dsh-code-pipeline] soft wall-clock warning sent to ${entry.stage} subagent ${entry.childId} (~${Math.round(remainingMs / 60_000)} min left)`,
    );
  } catch (error) {
    ctx.logger.warn(
      `[dsh-code-pipeline] soft wall-clock warning failed for ${entry.stage} subagent ${entry.childId}: ${error?.message ?? String(error)}`,
    );
  }
}

/**
 * 超时收尾：先等当前回合真的停下（有界轮询，超时即放弃等待），再排队投递收尾报告
 * 指令。排队用 host-protocol 的 delivery:'queue'（当前回合之后处理），避开"abort 中
 * 投递被当作已领取工作丢弃"的竞态。等待期间子代理若因别的原因 settle（phase 被
 * subagent/end 改写），就不再唤醒它——完成通知已经是最终结果。
 */
async function deliverWrapupRequest(ctx, entry) {
  const subagents = ctx.get("subagents");
  const deadline = Date.now() + WRAPUP_IDLE_WAIT_MS;
  let running = await childIsRunning(ctx, entry);
  while (running === true && Date.now() < deadline) {
    await delay(WRAPUP_POLL_MS);
    running = await childIsRunning(ctx, entry);
  }
  if (entry.phase !== "timed-out") return;
  const parent = ctx.get("agents")?.get(entry.parentId);
  if (!parent) {
    entry.phase = "lost";
    return;
  }
  try {
    await queueFollowupMessage(
      subagents,
      parent,
      entry.childId,
      buildWrapupInstruction(entry.stage, entry.elapsedMs ?? Date.now() - entry.at),
      AbortSignal.timeout(WRAPUP_DELIVERY_TIMEOUT_MS),
    );
    entry.phase = "wrapup";
    entry.wrapupAt = Date.now();
    ctx.logger.info(
      `[dsh-code-pipeline] wrap-up report requested from ${entry.stage} subagent ${entry.childId}`,
    );
  } catch (error) {
    entry.phase = "stopped";
    ctx.logger.warn(
      `[dsh-code-pipeline] wrap-up report could not be queued for ${entry.stage} subagent ${entry.childId}: ${error?.message ?? String(error)}`,
    );
  }
}

/**
 * 墙钟看门狗的一轮巡检，推进每个阶段子代理的状态机：
 *   running →（预算 SOFT_WARN_RATIO 处）软警告一次（相位不变）
 *   running →（预算到点）timed-out →（收尾指令投递成功）wrapup →（收尾回合结束）wrapup-done
 *   running →（自行 settle）settled
 *   timed-out →（投递失败）stopped；wrapup →（宽限用尽仍在跑）stopped（第二次中断，硬停）
 * 只有 running / wrapup 两个相位会被巡检推进；中断与投递都是幂等的（重复中断是
 * no-op，重复队列在相位检查处被挡住）。
 */
function sweepStageBudgets(ctx) {
  const now = Date.now();
  const due = [];
  const warn = [];
  for (const entry of dispatched.values()) {
    if (entry.phase === "running") {
      if (entry.budgetMs <= 0) continue;
      const elapsed = now - entry.at;
      if (elapsed >= entry.budgetMs) due.push(entry);
      else if (!entry.warned && elapsed >= entry.budgetMs * SOFT_WARN_RATIO) warn.push(entry);
    } else if (entry.phase === "wrapup" && now - (entry.wrapupAt ?? now) >= WRAPUP_GRACE_MS) {
      due.push(entry);
    }
  }
  // 软警告先发：先同步标记再异步投递，避免投递期间下一轮巡检重复发。
  for (const entry of warn) {
    entry.warned = true;
    void deliverSoftWarning(ctx, entry).catch((error) => {
      ctx.logger.warn(
        `[dsh-code-pipeline] soft warning flow failed for ${entry.stage} subagent ${entry.childId}: ${error?.message ?? String(error)}`,
      );
    });
  }
  for (const entry of due) {
    if (entry.phase === "running") {
      entry.phase = "timed-out";
      entry.timedOutAt = now;
      entry.elapsedMs = now - entry.at;
      ctx.logger.info(
        `[dsh-code-pipeline] ${entry.stage} subagent ${entry.childId} exceeded its wall-clock budget `
        + `(${Math.round(entry.elapsedMs / 60_000)} min) — interrupting and requesting a wrap-up report`,
      );
      if (interruptStageChild(ctx, entry, "wall-clock budget expired")) {
        void deliverWrapupRequest(ctx, entry).catch((error) => {
          entry.phase = "stopped";
          ctx.logger.warn(
            `[dsh-code-pipeline] wrap-up flow failed for ${entry.stage} subagent ${entry.childId}: ${error?.message ?? String(error)}`,
          );
        });
      }
      continue;
    }
    entry.phase = "stopped";
    ctx.logger.warn(
      `[dsh-code-pipeline] ${entry.stage} subagent ${entry.childId} is still running after its wrap-up grace — interrupting again (hard stop)`,
    );
    interruptStageChild(ctx, entry, "wrap-up grace expired");
  }
}

// ── 续跑（pipeline_followup）与墙钟的关系 ─────────────────────────────────────
// 每次「派发」都是新孩子、新账本条目、新预算快照 → 各自的独立墙钟，互不影响。
// 续跑同一个孩子时：
//   - 目标已经停下（settled / wrapup-done / stopped）→ 这次 followup 会开启新的一轮
//     工作，重新起算墙钟并按**当前设置**取新预算（新的一轮 = 新预算，否则续跑就成了
//     绕过止损线的手段）；
//   - 目标还在跑（running / timed-out / wrapup）→ 只是插话（steer），**不重置**墙钟，
//     否则"给运行中的孩子发条消息"就能无限延长时间。
// phase 为 lost 的条目不复位：看门狗已对该条目放弃（宿主缺 interrupt / 父代理缺失），
// 下一次新派发会重新计时。

/** 可重新起算墙钟的相位：孩子已停下、这次续跑会开新的一轮。 */
const REARMABLE_PHASES = new Set(["settled", "wrapup-done", "stopped"]);

/** 按当前设置给一个已停下的阶段子代理重新起算墙钟；返回新的预算（毫秒）。 */
function rearmStageBudget(source, entry) {
  const budgetMs = normalizeBudgetMs(resolveStages(source)[entry.stage]?.budgetMinutes);
  entry.at = Date.now();
  entry.budgetMs = budgetMs;
  entry.phase = "running";
  entry.warned = false;
  delete entry.warnedAt;
  delete entry.timedOutAt;
  delete entry.elapsedMs;
  delete entry.wrapupAt;
  delete entry.endedAt;
  return budgetMs;
}

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
    return owned.reduce((best, entry) => (entry.seq > best.seq ? entry : best), owned[0]).childId;
  }
  // 精确 id：必须同时校验 parentId —— dispatched 是模块级共享台账，跨父会话命中会把
  // 消息投给别的会话的子代理（followup 成为复用主路径后，这个洞的影响被放大）。
  const direct = dispatched.get(q);
  if (direct !== undefined && direct.parentId === parentId) return direct.childId;
  const alias = STAGE_ALIASES[q];
  if (alias !== undefined) {
    const matches = owned.filter((entry) => entry.stage === alias);
    if (matches.length === 0) return undefined;
    return matches.reduce((best, entry) => (entry.seq > best.seq ? entry : best), matches[0]).childId;
  }
  const prefixHits = owned.filter((entry) => entry.childId.startsWith(q));
  return prefixHits.length === 1 ? prefixHits[0].childId : undefined;
}

/**
 * followup 目标解析：先查进程内台账（同步、信息最全），未命中再回退到宿主持久面
 * `subagents.listChildren(parent.id)`。
 *
 * 为什么必须有持久回退：创建上限的真值是**持久**的（台账 ∪ listChildren），而寻址原先只认
 * 台账——dsh 重启后台账为空，于是上限看得见重启前创建的子代理（从而拒绝新建）、寻址却看
 * 不见它们（`no stage subagent matches`），而"台账丢了就重新派发"的回退又被上限拒绝
 * ⇒ 阶段被卡死：既不能复用也不能创建。修复后**凡能被创建上限计数到的子代理都可寻址**。
 *
 * 返回：
 *   - 命中：`{ childId, entry, stage, recovered }`（持久回退命中时 `entry` 为 undefined）；
 *   - 未命中：`{ childId: undefined, candidates, listingFailed }`（供错误文案列出可用 id）。
 */
async function resolveFollowupTarget(ctx, subagents, query, parentId, signal) {
  const ledgerHit = resolveDispatchedChild(query, parentId);
  if (ledgerHit !== undefined) {
    const entry = dispatched.get(ledgerHit);
    return { childId: ledgerHit, entry, stage: entry?.stage, recovered: false, candidates: [] };
  }
  const hostRows = await hostStageRows(ctx, subagents, parentId, signal);
  const listingFailed = hostRows === null;
  // 只有能归属到阶段的持久行才算"阶段子代理"（与创建上限的判定同一口径）。
  const candidates = (hostRows ?? []).filter((row) => row.stage !== undefined);
  if (candidates.length === 0) return { childId: undefined, candidates: [], listingFailed };
  const q = String(query ?? "").trim().toLowerCase();
  let picked;
  if (q === "" || q === "latest") {
    // 宿主按 createdAt 升序返回（control-types.ts:24-25）：最后一行就是最近创建的那个。
    picked = candidates[candidates.length - 1];
  } else {
    picked = candidates.find((row) => row.id.toLowerCase() === q);
    const alias = picked === undefined ? STAGE_ALIASES[q] : undefined;
    if (picked === undefined && alias !== undefined) {
      const matches = candidates.filter((row) => row.stage === alias);
      picked = matches[matches.length - 1];
    }
    if (picked === undefined && alias === undefined) {
      const prefixHits = candidates.filter((row) => row.id.toLowerCase().startsWith(q));
      if (prefixHits.length === 1) picked = prefixHits[0];
    }
  }
  if (picked === undefined) return { childId: undefined, candidates, listingFailed };
  return { childId: picked.id, entry: dispatched.get(picked.id), stage: picked.stage, recovered: true, candidates };
}

// ── 复用前压缩（pipeline_followup 的 compact: true）───────────────────────────
// 顺序是硬约束：**先 compactNow、再投递**。宿主 compactNow 走 agent.runMaintenance，
// inbox 里已有待处理消息就抛 ManualCompactionError('busy')（官方测试
// packages/compaction/compaction-basic/tests/manual-compaction.spec.ts 钉死），
// 先投递再压缩在 queue 模式下必然失败。压缩不计入也不重起该阶段的墙钟：续跑的
// rearm 仍按既有规则在投递之后进行（见下方 REARMABLE_PHASES）。

/** 单次压缩的墙钟上限（用户指定 10 分钟）。 */
const COMPACT_TIMEOUT_MS = 10 * 60 * 1000;

/** 压缩失败码 → 处置文案。宿主 ManualCompactionErrorCode 是封闭集合
 *  （busy | cancelled | changed | summary | commit | persistence）。 */
function compactionFailureGuidance(code) {
  switch (code) {
    case "busy":
      return "the child is not idle (it has a turn in flight, or waking work is already queued) — wait for its settled notice, then retry with compact: true.";
    case "cancelled":
      return "the compaction was cancelled (the 10-minute compaction timeout expired, or this program was aborted) — retry later.";
    case "changed":
      return "the history selected for compaction changed before it could be replaced; the attempt is recorded in the child's session log — retry.";
    case "summary":
      return "the summarizer could not produce a useful summary — the child's history is UNCHANGED, so you can reuse it as-is with compact: false.";
    case "commit":
      return "compaction did not finish cleanly and some session history may have changed — inspect the child's state before reusing it.";
    case "persistence":
      return "compaction finished but the session could not be saved — inspect the child's state before reusing it.";
    default:
      return "unexpected compaction failure — retry later, or reuse the child as-is with compact: false.";
  }
}

/** 合并调用方取消信号与压缩超时（AbortSignal.any 不可用时退回超时信号）。 */
function mergeAbortSignals(signal, timeoutSignal) {
  if (!(signal instanceof AbortSignal)) return timeoutSignal;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/**
 * 在投递之前压缩目标子代理自己的历史。任何失败都抛错——调用方据此保证
 * 「什么都没投递」。返回 { compacted }：compactNow 返回 null（没有安全可压的有用区间）
 * 不算失败，compacted 保持 false，投递照常发生。
 *
 * 服务寻址必须走 agentPresets.serviceFor(agent, "compaction")：预设把 compaction 关进
 * entry-local realm（preset/code-pipeline/agent.cordis.yml 的 isolate.compaction），而
 * 插件的 apply(ctx) 拿的是 bundle/root 层 ctx。宿主 root realm 另有一个 compaction 实例
 * （base bundle 的 compaction-basic），所以 ctx.get("compaction") **会成功返回那个错误的
 * 实例**——它的 inject（llm/tokenMeter/sessions）不是子代理所在 realm 的，用它压缩会打错
 * session 的账且不报错。官方入口：packages/preset/agent-presets/src/index.ts:652-654
 * （serviceFor）与 mount.ts:277-293（serviceForAgent）。
 */
async function compactFollowupTarget(ctx, childId, signal) {
  const undelivered = "Nothing was delivered to the child — its inbox is unchanged.";
  const agents = ctx.get("agents");
  const child = typeof agents?.get === "function" ? agents.get(childId) : undefined;
  if (!child) {
    throw new Error(
      `pipeline_followup: cannot compact ${childId} — that child is not awake in this process (cold subagent, compaction would need to resume it first). ${undelivered} `
      + "Do one ordinary reuse first (pipeline_followup with compact: false) to wake it, then retry with compact: true.",
    );
  }
  const compaction = ctx.get("agentPresets")?.serviceFor?.(child, "compaction");
  if (compaction === undefined || typeof compaction.compactNow !== "function") {
    throw new Error(
      `pipeline_followup: cannot compact ${childId} — the preset's realm-private compaction service is unreachable on this host `
      + '(agentPresets.serviceFor(agent, "compaction") returned no service exposing compactNow; host API drift). '
      + `${undelivered} Retry with compact: false to deliver your message without compacting.`,
    );
  }
  let result;
  try {
    result = await compaction.compactNow(child, mergeAbortSignals(signal, AbortSignal.timeout(COMPACT_TIMEOUT_MS)));
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : undefined;
    throw new Error(
      `pipeline_followup: compaction of ${childId} failed BEFORE delivery (${code ?? "unknown"}: ${error?.message ?? String(error)}) — ${compactionFailureGuidance(code)} ${undelivered} `
      + "Retry with compact: false to deliver your message without compacting.",
    );
  }
  return { compacted: result !== null && result !== undefined };
}

function buildFollowupToolDef(ctx, source, cfg) {
  return {
    name: "pipeline_followup",
    description:
      "Send a requirement change to an already-dispatched pipeline stage subagent using the plugin's configured delivery mode (设置 → 代码流水线 → 子代理消息投递): " +
      "steer = INSERT the message (a working child steers its nearest step — the very next model step sees it; idle/settled children wake into a new turn); queue = PARK the message (processed as a new turn after the child's current turn ends). " +
      "child accepts: \"latest\" (most recent stage subagent this agent started) | a stage key (plan | impl | review) or its Chinese alias (规划/计划/实现/评审/审查) | an exact subagentId (session-...). " +
      "Prefer this over dispatching a new stage when the user updates a requirement mid-flight. " +
      "REUSE IS ALWAYS AVAILABLE: a followup never counts against either stage cap (running or created). " +
      "Pass compact: true only when the child's accumulated history actively interferes with the new work — it compacts THAT child first (10-minute cap) and delivers afterwards; if compaction fails, nothing is delivered. " +
      "WALL CLOCK: continuing a stage subagent that already stopped (settled / timed out / wrap-up finished) starts a new round of work and re-arms its wall-clock budget from the current settings — the reply then carries wallClockRearmed: true. A message to a child that is still working only steers it and does NOT reset its budget.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["child", "message"],
      properties: {
        child: {
          type: "string",
          description: "Which stage subagent to target: latest | plan | impl | review | 规划/计划 | 实现 | 评审/审查 | exact subagentId. An exact subagentId also resolves against the durable subagent list, so a child created before a dsh restart is still addressable by its id.",
        },
        message: {
          type: "string",
          description: "The requirement change to insert. Complete and self-contained (the child does not share this conversation's context).",
        },
        compact: {
          type: "boolean",
          description:
            "Compress THIS child's own history BEFORE the message is delivered (default false). Use it only when the child's accumulated context actively interferes with the new work — the same task family but the direction changed, a new requirement reverses a conclusion it contributed, or the diff it wrote was discarded wholesale. Costs: compaction replaces everything beyond the summary with that summary (the child loses that detail memory) and forfeits its prefix cache. If compaction fails, NOTHING is delivered (its inbox is unchanged) — retry with compact: false to deliver without compacting. A cold (not awake) child cannot be compacted: reuse it once with compact: false first.",
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
          // 续跑一个「已停下」的子代理时置 true：它的墙钟预算已按当前设置重新起算。
          wallClockRearmed: { type: "boolean" },
          // 投递回执(宿主 sendMessage/prompt 返回);返回对象里缺该键时省略。
          messageId: { type: "string" },
          // compact: true 时该子代理的历史已在投递前被压缩（返回 null = 没有可压区间，
          // 不算失败，也不置 true）。
          compacted: { type: "boolean" },
          // 目标由**宿主持久面**命中（本进程台账没有它的条目，典型场景是 dsh 重启后按精确
          // id 复用重启前创建的子代理）：此时不重新起算墙钟，故不出现 wallClockRearmed。
          recovered: { type: "boolean" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `requirement change delivered to stage subagent ${value.childId} (${value.stage})`
            + (value.compacted ? "; its history was compacted first" : "")
            + (value.recovered
              ? "; addressed from the durable subagent list (this process had no ledger entry for it, so no wall-clock budget applies to this round)"
              : "")
            + (value.wallClockRearmed ? "; its wall-clock budget restarted from now" : ""),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error("pipeline_followup requires a calling agent (exec.agent was undefined)");
      if (typeof args.message !== "string" || args.message.trim().length === 0) {
        throw new Error("pipeline_followup: \"message\" must be a non-empty string");
      }
      const target = await resolveFollowupTarget(ctx, ctx.get("subagents"), args.child, parent.id, exec.signal);
      if (target.childId === undefined) {
        const owned = [...dispatched.values()].filter((entry) => entry.parentId === parent.id);
        const persistent = (target.candidates ?? []).map((row) => `${row.id} ("${row.label}")`).join(", ");
        throw new Error(
          `pipeline_followup: no stage subagent matches child="${String(args.child)}" — this agent has dispatched: `
          + (owned.map((entry) => `${entry.stage}(${entry.label})`).join(", ") || "(none)")
          + (persistent.length > 0 ? `; still addressable from the durable subagent list: ${persistent}` : "")
          + (target.listingFailed
            ? " (the host subagent listing failed transiently, so children created before this process started could not be checked — retry this call)"
            : ""),
        );
      }
      const childId = target.childId;
      // 重启后台账为空时由持久面命中：此时没有台账条目，下游一律降级处理——
      // 不 rearm（无条目可推进）、不报 wallClockRearmed，回执改报 recovered: true。
      const entry = target.entry;
      // ── 顺序是硬约束：先压缩、后投递 ─────────────────────────────────────
      // 压缩失败 => 抛错 => 什么都不投递（文案里明确写出这一点）。compact 严格取
      // true 才触发；其余值（缺省 / false / 非布尔）一律走原来的投递路径。
      let compacted = false;
      if (args.compact === true) {
        ({ compacted } = await compactFollowupTarget(ctx, childId, exec.signal));
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
          // 当前回合之后）。wire 载荷的判别符只有 'continuable'（探测表见
          // queueFollowupMessage）。
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
      // 续跑一个已经停下来的孩子 = 新的一轮工作：重新起算墙钟（按当前设置取新预算）。
      // 目标是运行中的孩子时只是插话（steer），不重置——见 REARMABLE_PHASES 的说明。
      let wallClockRearmed = false;
      if (entry !== undefined && REARMABLE_PHASES.has(entry.phase)) {
        const budgetMs = rearmStageBudget(source, entry);
        wallClockRearmed = true;
        if (budgetMs > 0) {
          ctx.logger.info(
            `[dsh-code-pipeline] wall clock re-armed for ${entry.stage} subagent ${childId} (${Math.round(budgetMs / 60_000)} min)`,
          );
        }
      }
      // messageId 可能是 undefined（宿主回执缺字段）；输出 schema 要求严格 JSON，
      // undefined 属性会被宿主判为 not lossless JSON 并在投递成功后报错。
      return {
        ok: true,
        childId,
        stage: entry?.stage ?? target.stage ?? "unknown",
        ...(compacted ? { compacted: true } : {}),
        ...(target.recovered ? { recovered: true } : {}),
        ...(wallClockRearmed ? { wallClockRearmed: true } : {}),
        ...(messageId === undefined ? {} : { messageId }),
      };
    },
  };
}
/**
 * 通过宿主 human-queue 通道排队投递一条消息到子代理（当前回合结束后处理）。
 * 零依赖：直接调用 subagents.prompt Remote（服务方法进程内可直接调用）。
 *
 * 载荷按宿主版本探测（首个被接受的形状即返回）：
 *   1. 当前形状（dsh 0.1.3-alpha.2 起）：mode:'continuable' + delivery:'queue'。
 *   2. 旧形状（0.1.3-alpha.2 之前）：只有 mode:'continuable'。
 * 宿主 control schema 的唯一合法判别符是 mode:'continuable'
 * （packages/subagent/subagent/src/control.ts:23 的 z.literal('continuable')）——不存在
 * mode:'queue' 这种形状；delivery 自 0.1.3-alpha.2 起必填（z.enum(['queue','steer'])）。
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
  // 宿主文案由 control.ts:46 的模板 `invalid payload for ${method}` 生成，因此不写死整句：
  // 两个条件取 OR，命中任一即继续探测（旧实现写成"前缀优先、否则看 issues"的三元：
  // RemoteError.message 恒为字符串，issues 那一支永不求值 = 死代码，宿主改文案后
  // 探测直接放弃回退）：
  //   1) message 前缀 invalid payload for subagent.prompt；
  //   2) 结构化 issues（RemoteError.details.issues，见
  //      packages/typert/protocol/src/remote-error.ts:25）。
  const isBadPayload = (error) =>
    error?.code === "gateway/bad-request"
    && (
      error?.message?.startsWith?.("invalid payload for subagent.prompt") === true
      || Array.isArray(error?.details?.issues)
    );
  const attempts = [
    { ...base, mode: "continuable", delivery: "queue" },
    { ...base, mode: "continuable" },
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
    settingsCtx.settings.installSection(ctx, "code-pipeline", SettingsSchema, config, {
      setSource: (next) => {
        source = next;
      },
      onChange: () => {
        // 无需重新注入：工具调用时读取最新设置。
      },
    });
  });

  // 已注入的代理集合（按对象身份），避免重复注入。
  // 用 WeakSet 而非 id 集合：宿主支持同 id 冷恢复（新 Agent 对象），
  // 旧的 id 集合会让新对象被误判为已注入，阶段工具在恢复后的会话里消失。
  const injected = new WeakSet();
  const pending = new Set();

  const isRootAgent = (agent) => {
    const agents = ctx.get("agents");
    const roots = agents?.roots() ?? [];
    return !roots.some((root) => root.id !== agent.id && agents.isOwnedBy(agent.id, root));
  };

  const injectInto = (agent) => {
    if (injected.has(agent)) return;
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
    injected.add(agent);
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
    if (agent && !injected.has(agent)) {
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

  // ── 并发账本维护 ──────────────────────────────────────────────────────────
  // 子代理 settle（宿主 subagent/end，payload 带 child id）时移出账本；父代理
  // 销毁时清空它的账本。即使这两条事件因作用域过滤没收到，准入时的
  // listChildren 修剪也会把已 settle 的子代理摘掉，不会永久占住名额。
  ctx.on("subagent/end", (info) => {
    const childId = String(info?.id ?? "");
    const entry = childId === "" ? undefined : dispatched.get(childId);
    if (!entry) return;
    untrackStageChild(entry.parentId, entry.stage, childId);
    entry.endedAt = Date.now();
    // phase 语义：running 自己结束 = 正常 settle；wrapup 结束 = 收尾回合完成；
    // timed-out 保持不变——这次 end 正是我们 interrupt 的结果，收尾报告仍要投递。
    if (entry.phase === "running") entry.phase = "settled";
    else if (entry.phase === "wrapup") entry.phase = "wrapup-done";
  }, { global: true });

  ctx.on("agent/disposed", ({ agent }) => {
    const parentId = String(agent?.id ?? "");
    if (parentId === "") return;
    activeStageChildren.delete(parentId);
    pendingStageStarts.delete(parentId);
    // 父代理没了：它的阶段子代理会被宿主 drain，看门狗不再对它们动手。
    for (const entry of dispatched.values()) {
      if (entry.parentId !== parentId) continue;
      if (entry.phase === "running" || entry.phase === "timed-out" || entry.phase === "wrapup") {
        entry.phase = "lost";
      }
    }
  }, { global: true });

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

  // 设置页的并发状态端：各阶段当前运行数 / 启动中 / 上限 / 已创建数 / 可复用清单
  //（只读，跨父会话汇总）。
  const statusHandler = async (_req, res) => {
    const stages = {};
    const stageCfgs = resolveStages(source);
    const now = Date.now();
    // 「已创建」与「可复用」需要宿主持久面：对本进程知道的每个父会话各查一次
    // listChildren（查询失败只影响这两项新字段，既有字段照常返回）。
    const subagents = ctx.get("subagents");
    const agents = ctx.get("agents");
    const presets = ctx.get("agentPresets");
    // 活着的 ROOT 代理也是父会话来源（重启前创建过、本进程还没派发过的阶段子代理只有
    // 从这里才能被 listChildren 看见，否则「已创建」会漏掉整个持久面）——但**只保留组合了
    // 本预设的 root**：否则设置页每次轮询都会对进程里每个会话各做一次持久 Session-store
    // 读（N+1），与 code-pipeline 无关的会话也被扫。
    const rootIds = typeof agents?.roots === "function"
      ? (agents.roots() ?? [])
        .filter((agent) => {
          try {
            return presets?.composedPreset(agent?.ctx) === preset;
          } catch {
            return false;
          }
        })
        .map((agent) => agent.id)
      : [];
    const parentIds = new Set([
      ...[...dispatched.values()].map((entry) => entry.parentId),
      ...activeStageChildren.keys(),
      ...pendingStageStarts.keys(),
      ...rootIds,
    ]);
    const hostRows = [];
    for (const parentId of parentIds) {
      // 单次枚举 + 阶段归属走同一条路径（hostStageRows）；失败（null）只影响
      // created / available 两项新字段，既有字段照常返回。
      for (const row of (await hostStageRows(ctx, subagents, parentId, undefined)) ?? []) hostRows.push(row);
    }
    for (const stage of STAGES) {
      let running = 0;
      for (const perStage of activeStageChildren.values()) running += perStage.get(stage.key)?.size ?? 0;
      let pendingCount = 0;
      for (const perStage of pendingStageStarts.values()) pendingCount += perStage.get(stage.key) ?? 0;
      // 墙钟：仍在推进（运行中 / 已被墙钟中断、正在收尾）的子代理数、最早已运行时长。
      // 已 settle / stopped / lost 的条目不计入，避免状态行被历史条目永久污染。
      let timedOut = 0;
      let longestRunningMs = 0;
      for (const entry of dispatched.values()) {
        if (entry.stage !== stage.key) continue;
        if (entry.phase !== "running" && entry.phase !== "timed-out" && entry.phase !== "wrapup") continue;
        if (entry.phase !== "running") timedOut += 1;
        const elapsed = now - entry.at;
        if (elapsed > longestRunningMs) longestRunningMs = elapsed;
      }
      // 已创建 = 本进程台账 ∪ 宿主当前可见行（上限的计数口径，只增不减）；
      // available = 这份并集本身，也就是可复用的子代理清单。
      const reusable = new Map();
      for (const entry of dispatched.values()) {
        if (entry.stage !== stage.key) continue;
        reusable.set(entry.childId, {
          id: entry.childId,
          label: entry.label,
          activity: ACTIVE_PHASES.has(entry.phase) ? "running" : "inactive",
        });
      }
      for (const row of hostRows) {
        if (row.stage !== stage.key) continue;
        const known = reusable.get(row.id);
        reusable.set(row.id, {
          id: row.id,
          label: row.label ?? known?.label ?? row.id,
          activity: row.activity === "running" || known?.activity === "running" ? "running" : "inactive",
        });
      }
      const available = [...reusable.values()];
      stages[stage.key] = {
        running,
        pending: pendingCount,
        limit: normalizeConcurrency(stageCfgs[stage.key].maxConcurrency),
        budgetMinutes: stageCfgs[stage.key].budgetMinutes ?? 0,
        timedOut,
        longestRunningMs,
        created: available.length,
        available,
      };
    }
    const body = JSON.stringify({ stages });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  };

  const registerRoutes = () => {
    const server = ctx.get("webServer");
    if (server === undefined) return false;
    try {
      server.register({ kind: "exact", path: "/dsh-code-pipeline/options", handler: optionsHandler });
      server.register({ kind: "exact", path: "/dsh-code-pipeline/status", handler: statusHandler });
      return true;
    } catch (error) {
      ctx.logger.warn(`[dsh-code-pipeline] route registration failed: ${error.message}`);
      return false;
    }
  };

  if (!registerRoutes()) {
    const retry = setTimeout(() => registerRoutes(), 2000);
    ctx.effect(() => () => clearTimeout(retry));
  }

  // ── 墙钟看门狗：15 秒一轮巡检账本 ──────────────────────────────────────────
  // unref 让定时器不阻止进程退出（测试/短命宿主进程不挂在它上面）；每轮只做同步
  // 判定，中断与投递由 sweepStageBudgets 内部异步推进。
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        sweepStageBudgets(ctx);
      } catch (error) {
        ctx.logger.warn(`[dsh-code-pipeline] wall-clock sweep failed: ${error?.message ?? String(error)}`);
      }
    }, WATCHDOG_SWEEP_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  });
}