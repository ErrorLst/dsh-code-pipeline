// @dsh-external/dsh-code-pipeline — 假 ctx 集成冒烟：每阶段墙钟预算（0.1.16）
//
// 覆盖：预算到点 -> 中断 + queue 收尾投递；80% 软警告（only once / 只在运行中）；预算 0 不误伤；
//       子代理自行 settle 不误伤；收尾宽限用尽 -> 第二次中断（硬停）；宿主缺 interrupt /
//       父代理缺失时只告警；status 端点新字段；阶段工具 description 的墙钟与 workstreams 文案。
//
// 运行：node test/watchdog.smoke.mjs（或 npm test）
// 依赖：@deepseek-ai/schemastery 必须可解析（pnpm install，或本地开发时链接宿主副本）。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ── 断言 ────────────────────────────────────────────────────────────────────
let checks = 0;
const failures = [];
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log('  ok   ' + label);
    return;
  }
  failures.push(label + (detail === undefined ? '' : ' -- ' + detail));
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' -- ' + detail));
}

// ── 时间与定时器控制 ────────────────────────────────────────────────────────
const realNow = Date.now.bind(Date);
let timeOffset = 0;
Date.now = () => realNow() + timeOffset;
const advance = (ms) => { timeOffset += ms; };
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const MINUTE = 60 * 1000;

let sweep;
globalThis.setInterval = (fn) => { sweep = fn; return { unref() {} }; };
globalThis.clearInterval = () => {};

// ── 假 ctx ──────────────────────────────────────────────────────────────────
// parentId 可指定：创建数量台账是模块级、按父会话隔离的，扩展场景各自用独立父会话，
// 才不会与前一个场景已创建的阶段子代理互相污染；childId 带 harness 序号以保证全局
// 唯一（dispatched 是按 childId 索引的模块级 Map，跨场景重名会互相覆盖）。
let harnessSeq = 0;
function createHarness(parentId = 'parent-1') {
  harnessSeq += 1;
  const harnessNo = harnessSeq;
  const handlers = new Map();
  const tools = new Map();
  const routes = new Map();
  const warnings = [];
  const interrupts = [];
  const queued = [];
  const steers = [];
  const children = new Map();
  const settings = { stages: {} };
  // 宿主调用记账：实参形状与调用次数（宿主契约回归——漏传 signal 会让脚本变红）。
  // promptPayloads 在"判定接受之前"记录每次尝试的载荷：探测表的尝试序列因此可断言
  // （光看 queued[last] 看不出中间试过哪些形状）。
  const calls = { prompt: 0, promptPayloads: [], promptSignals: [], startSignals: [], startPrompts: [], startPersonas: [], sendMessageOptions: [], rejectDelivery: false, rejectKnownShapes: false, rewriteBadPayloadMessage: false,
    // 运行上限 / 压缩顺序断言的记账：
    //   start          —— 宿主创建入口 startContinuable 的真实调用次数（证明闸门是代码拦的）；
    //   order          —— 跨服务统一调用序列（压缩必须早于投递）；
    //   serviceForArgs —— agentPresets.serviceFor 的实参（realm 私有 compression 服务寻址）；
    //   compactNowArgs —— compactNow 的实参（第一个实参必须是目标子代理对象）。
    start: 0, order: [], serviceForArgs: [], compactNowArgs: [],
    // 宿主容量拒绝模拟（dsh 0.1.6-alpha.2）：startFailure / promptFailure 非空时，
    // 对应入口抛出该错误对象，用于断言「瞬时容量拒绝」与「阶段不可用」的分流。
    startFailure: null, promptFailure: null };
  let childSeq = 0;

  const toolsRegistry = { register: (def) => tools.set(def.name, def) };
  // 非本预设的 root（P4）：status 不得对它们调用 listChildren（N+1）。
  const foreignRoots = [];
  // 预设门面：composedPreset 供注入/资格守卫（对 foreignRoots 返回别的预设名）；
  // serviceFor 供压缩寻址——测试可整体替换（模拟「realm 私有服务不可达」）。
  const presets = {
    composedPreset: (agentCtx) => (foreignRoots.some((root) => root.ctx === agentCtx) ? 'standard' : 'code-pipeline'),
    serviceFor: undefined,
  };
  const parent = {
    id: parentId,
    ctx: {
      get: (name) => name === 'tools'
        ? toolsRegistry
        : name === 'agentPresets'
          ? presets
          : undefined,
    },
  };

  const webServer = { register: ({ path, handler }) => routes.set(path, handler) };
  // 活着的子代理对象（agents.get）：压缩只对「本进程已唤醒」的子代理可行。测试用
  // childAgents.set(id, agent) 造出活对象，用 options.stageKey 造出阶段归属。
  const childAgents = new Map();
  const agentsService = {
    roots: () => [parent, ...foreignRoots],
    isOwnedBy: () => false,
    get: (id) => (id === parent.id ? parent : childAgents.get(id)),
  };
  // 宿主 subagents 持久面（listChildren）的可控假实现——扩展场景需要模拟：
  //   fail           —— 枚举瞬时抛错（P3：绝不能当成「持久面为空」而放行）；
  //   hold           —— 枚举挂起（P5：把调用卡在「已预留、尚未创建」的窗口里）；
  //   rows / rowsFor —— 只返回持久行（「重启」形状：台账为空、持久面有行；P1/P2/P3）；
  //   calls          —— 每次枚举的 parentId 实参（P4：不得对非本预设 root 做 N+1）。
  const host = { fail: false, hold: null, rows: null, rowsFor: null, calls: [] };
  /** 造一个「非本预设」的 root（composedPreset 对它返回 standard），用于 P4。 */
  const addForeignRoot = (id) => {
    const root = { id, ctx: { get: () => undefined } };
    foreignRoots.push(root);
    return root;
  };
  const subagents = {
    getProvider: (name) => ({ name }),
    startContinuable: async (spec) => {
      // 宿主契约（packages/subagent/subagent/src/types.ts:32-50，continuation.ts:102）：
      // spec.signal 是必填 AbortSignal，spec.request.prompt 是 ContentBlock[]。
      // 形状不符就抛与宿主同形的 TypeError，而不是静默接受。
      if (!(spec?.signal instanceof AbortSignal)) {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
      }
      if (spec?.request?.prompt?.[0]?.type !== 'text') {
        throw new TypeError('subagent start request carries no text prompt');
      }
      calls.startSignals.push(spec.signal);
      calls.startPrompts.push(spec.request.prompt[0].text);
      calls.startPersonas.push(spec.request?.persona);
      calls.start += 1;
      calls.order.push('startContinuable');
      // 容量拒绝发生在 reserve 阶段（宿主 continuation-activation.ts:41-55），
      // 也就是任何子代理出现之前——假宿主照做：不建行、直接抛。
      if (calls.startFailure) throw calls.startFailure;
      childSeq += 1;
      const childId = 'child-' + harnessNo + '-' + childSeq;
      // 宿主把 descriptor.label 原样写进持久面（listChildren.label）：假宿主照做，
      // 「`<stage>/` 前缀的持久行也能归属阶段」这条才可断言。
      children.set(childId, { activity: 'running', label: spec.label });
      return { childId, messageId: 'msg-0' };
    },
    listChildren: async (id) => {
      host.calls.push(String(id ?? ''));
      if (host.fail) throw new Error('subagent listing unavailable (simulated transient store failure)');
      if (host.hold !== null) await host.hold;
      if (typeof host.rowsFor === 'function') return host.rowsFor(String(id ?? ''));
      if (host.rows !== null) return host.rows;
      return [...children.entries()].map(([childId, row]) => ({ kind: 'child', id: childId, activity: row.activity, label: row.label }));
    },
    interrupt: (id, authority) => {
      interrupts.push({ id, authority });
      const row = children.get(id);
      if (row) row.activity = 'idle';
    },
    prompt: async (payload, signal) => {
      calls.prompt += 1;
      calls.order.push('prompt');
      // 宿主 continuation-activation.ts:489 对 signal 做 signal.throwIfAborted()：
      // 漏传尾部 transport 实参在这里必然 TypeError。
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
      }
      // 判定"接受"之前记账：拒绝路径也要留下痕迹，否则场景 10 的尝试序列无法断言。
      calls.promptPayloads.push(payload);
      // 可选的旧宿主模拟：
      //   rejectDelivery     —— 只拒带 delivery 的当前形状，逼探测表走第二项；
      //   rejectKnownShapes  —— 两种已知形状都拒（探测表全部项都被拒），逼出探测表真实
      //                         长度：把已删除的第三项 mode:'queue' 加回去就会多一次尝试。
      if (calls.rejectDelivery && (calls.rejectKnownShapes || payload?.delivery !== undefined)) {
        // 与宿主同形的 gateway/bad-request 校验失败
        // （packages/subagent/subagent/src/control.ts:44-47）：message 是模板串，
        // details.issues 是结构化问题列表（remote-error.ts:22-30）。
        const error = new Error(
          calls.rewriteBadPayloadMessage
            // 宿主改文案的模拟：前缀判定失效，结构化 issues 兜底必须接住。
            ? 'payload rejected: subagent.prompt'
            : 'invalid payload for subagent.prompt',
        );
        error.code = 'gateway/bad-request';
        error.details = { issues: [{ code: 'invalid_literal', path: ['delivery'] }] };
        throw error;
      }
      // 冷启动容量拒绝（宿主 continuation.ts:436 -> control.ts:139 映射为
      // 'subagent/delivery-unavailable'）：必须在判定接受之前抛，queued 不留痕。
      if (calls.promptFailure) throw calls.promptFailure;
      calls.promptSignals.push(signal);
      queued.push(payload);
      return { messageId: 'msg-1' };
    },
    sendMessage: async (_parent, childId, content, options) => {
      // 宿主 SubagentSendMessageOptions.signal 必填（types.ts:70-73）。
      if (!(options?.signal instanceof AbortSignal)) {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
      }
      calls.sendMessageOptions.push(options);
      calls.order.push('sendMessage');
      steers.push({ childId, text: String(content?.[0]?.text ?? '') });
      return 'msg-2';
    },
  };

  const ctx = {
    logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
    on: (name, fn) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    get: (name) => name === 'subagents'
      ? subagents
      : name === 'agents'
        ? agentsService
        : name === 'agentPresets'
          ? presets
          : name === 'webServer'
            ? webServer
            : undefined,
    inject: (_deps, cb) => cb({ settings: { installSection: (_t, _n, _s, _c, hook) => hook.setSource(() => settings) } }),
  };

  // 阶段子代理的假 agent（结构化 I/O 测试用）：宿主把 startContinuable 的 agentOptions
  // 原样展开到 agent.options（child-agent.ts），插件据此识别阶段子代理并注入
  // pipeline_submit；每个子代理有自己的 tools 注册表（真实宿主里就是它自己的 fiber scope）。
  const addStageChild = (childId, stageKey) => {
    const childTools = new Map();
    const child = {
      id: childId,
      options: { stageKey },
      ctx: {
        get: (name) => (name === 'tools'
          ? { register: (def) => childTools.set(def.name, def) }
          : undefined),
      },
    };
    childAgents.set(childId, child);
    return { agent: child, tools: childTools };
  };

  return {
    ctx, parent, settings, tools, routes, warnings, interrupts, queued, steers, children, handlers,
    agentsService, subagents, calls, presets, childAgents, parentId, host, addForeignRoot, foreignRoots, addStageChild,
    emit: (name, payload) => { for (const fn of handlers.get(name) ?? []) fn(payload); },
  };
}

function captureResponse() {
  const captured = { statusCode: undefined, body: undefined };
  return {
    captured,
    res: {
      writeHead: (code) => { captured.statusCode = code; },
      end: (body) => { captured.body = body; },
    },
  };
}

// ── 主体 ────────────────────────────────────────────────────────────────────
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-code-pipeline-smoke-'));
mkdirSync(join(dshHome, '.agent-presets'), { recursive: true });
cpSync(join(root, 'preset', 'code-pipeline'), join(dshHome, '.agent-presets', 'code-pipeline'), { recursive: true });
process.env.DSH_HOME = dshHome;

const plugin = await import(new URL('../lib/index.js', import.meta.url));
const h = createHarness();
await plugin.apply(h.ctx, { preset: 'code-pipeline' });
h.emit('agent/created', { agent: h.parent });

check('三个阶段工具 + pipeline_followup + pipeline_result 已注册', h.tools.size === 5, 'got ' + h.tools.size);
check('apply 期间启动了看门狗巡检函数', typeof sweep === 'function');
check(
  '阶段工具 description 带 WALL-CLOCK BUDGET',
  ['subagent_plan', 'subagent_impl', 'subagent_review'].every((name) => String(h.tools.get(name)?.description ?? '').includes('WALL-CLOCK BUDGET')),
);
check(
  'plan 工具 description 带 WORKSTREAMS 契约（impl/review 不带）',
  String(h.tools.get('subagent_plan')?.description ?? '').includes('WORKSTREAMS')
    && !String(h.tools.get('subagent_impl')?.description ?? '').includes('WORKSTREAMS'),
);

const dispatch = (toolName, args = {}) => h.tools.get(toolName).execute(
  { prompt: 'do the thing', files: '-', ...args },
  { agent: h.parent, signal: new AbortController().signal },
);
const statusOf = async () => {
  const { res, captured } = captureResponse();
  await h.routes.get('/dsh-code-pipeline/status')({}, res);
  return JSON.parse(captured.body).stages;
};
const allStages = (minutes) => ({ plan: { budgetMinutes: minutes }, impl: { budgetMinutes: minutes }, review: { budgetMinutes: minutes } });
const followup = (child, message) => h.tools.get('pipeline_followup').execute(
  { child, message, files: '-' },
  { agent: h.parent, signal: new AbortController().signal },
);
// 探测表载荷的简写形状（断言失败时把"到底试了哪些形状"打出来）。
const shapeOf = (row) => row === undefined
  ? '<none>'
  : String(row?.mode) + (row?.delivery === undefined ? '' : ' + delivery:' + String(row.delivery));

// 1) 默认预算 0：再久也不动手
{
  const beforeInterrupts = h.interrupts.length;
  const beforeSteers = h.steers.length;
  const result = await dispatch('subagent_impl');
  advance(2 * 60 * MINUTE);
  sweep();
  await tick(30);
  check('预算 0（默认）既不中断也不软警告',
    h.interrupts.length === beforeInterrupts && h.steers.length === beforeSteers && result.kind === 'continuable');
}

// 2) 预算 10 分钟：80% 处一次软警告（steer），到点才硬中断 + 收尾投递
{
  h.settings.stages = allStages(10);
  const beforeInterrupts = h.interrupts.length;
  const beforeQueued = h.queued.length;
  const result = await dispatch('subagent_impl');
  advance(8.5 * MINUTE);
  sweep();
  await tick(30);
  check('80% 处发出一次软警告（steer 到该子代理）',
    h.steers.length === 1 && h.steers[0].childId === result.subagentId && h.steers[0].text.includes('wall-clock budget'),
    JSON.stringify(h.steers[0] ?? null));
  check('软件警告要求收尾并给报告', h.steers[0].text.includes('Start wrapping up') && h.steers[0].text.includes('status report'));
  check('软警告阶段不中断', h.interrupts.length === beforeInterrupts);
  sweep();
  await tick(30);
  check('软警告不重复发', h.steers.length === 1, 'got ' + h.steers.length);
  advance(2 * MINUTE);
  sweep();
  await tick(30);
  const interrupt = h.interrupts[beforeInterrupts];
  check('到点触发一次硬中断', h.interrupts.length === beforeInterrupts + 1, 'got ' + (h.interrupts.length - beforeInterrupts));
  check('中断目标是刚派发的子代理', interrupt?.id === result.subagentId, String(interrupt?.id));
  check('中断授权用派发时的父代理（ancestor）',
    interrupt?.authority?.kind === 'ancestor' && interrupt?.authority?.agent === h.parent);
  check('收尾指令经 queue 通道投递',
    h.queued.length === beforeQueued + 1
      && h.queued[beforeQueued].delivery === 'queue'
      && h.queued[beforeQueued].mode === 'continuable'
      && h.queued[beforeQueued].childSessionId === result.subagentId,
    JSON.stringify(h.queued[beforeQueued] ?? null));
  const text = String(h.queued[beforeQueued]?.content?.[0]?.text ?? '');
  check('收尾指令要求只报告、不改工作区', text.includes('wall-clock budget') && text.includes('do NOT edit files'), text.slice(0, 60));
  const stages = await statusOf();
  check('status 报出 budgetMinutes / timedOut / longestRunningMs',
    stages.impl?.budgetMinutes === 10 && stages.impl?.timedOut >= 1 && stages.impl?.longestRunningMs >= 10 * MINUTE,
    JSON.stringify(stages.impl));

  // 3) 收尾宽限用尽 -> 第二次中断（硬停）
  h.children.set(result.subagentId, { activity: 'running' });
  advance(4 * MINUTE);
  const beforeGrace = h.interrupts.length;
  sweep();
  await tick(30);
  check('收尾宽限用尽触发第二次中断', h.interrupts.length === beforeGrace + 1, 'got ' + (h.interrupts.length - beforeGrace));
  check('硬停有告警', h.warnings.some((line) => line.includes('hard stop')));
  h.children.set(result.subagentId, { activity: 'idle' });
}

// 4) 子代理不在跑（idle）：不发软警告（steer 对 idle 目标是开新回合）
{
  const result = await dispatch('subagent_plan');
  h.children.set(result.subagentId, { activity: 'idle' });
  advance(8.5 * MINUTE);
  const beforeSteers = h.steers.length;
  sweep();
  await tick(30);
  check('子代理不在跑时不发软警告', h.steers.length === beforeSteers, 'got ' + (h.steers.length - beforeSteers));
  // 这个 idle 子代理在本场景里退出舞台：补一条 settle，避免它在后续场景的巡检里被算作超时。
  h.emit('subagent/end', { id: result.subagentId });
}

// 5) 子代理自行 settle：不误伤
{
  const before = h.interrupts.length;
  const result = await dispatch('subagent_impl');
  h.emit('subagent/end', { id: result.subagentId });
  h.children.set(result.subagentId, { activity: 'idle' });
  advance(20 * MINUTE);
  sweep();
  await tick(30);
  const touches = h.interrupts.slice(before).filter((row) => row.id === result.subagentId);
  check('自行 settle 的子代理不被中断', touches.length === 0, 'touches ' + touches.length);
}

// 6) 宿主缺 subagents.interrupt：只告警，不抛
{
  const original = h.subagents.interrupt;
  delete h.subagents.interrupt;
  const before = h.warnings.length;
  await dispatch('subagent_review');
  advance(11 * MINUTE);
  sweep();
  await tick(30);
  check('宿主缺 interrupt 时只告警', h.warnings.slice(before).some((line) => line.includes('subagents.interrupt is unavailable')));
  h.subagents.interrupt = original;
}

// 7) 父代理缺失：只告警，不抛
{
  const original = h.agentsService.get;
  h.agentsService.get = () => undefined;
  const before = h.warnings.length;
  await dispatch('subagent_plan');
  advance(11 * MINUTE);
  sweep();
  await tick(30);
  check('父代理不在时只告警', h.warnings.slice(before).some((line) => line.includes('is no longer live')));
  h.agentsService.get = original;
}

// 8) 墙钟与续跑（pipeline_followup）：运行中插话不重置；已停下续跑重新起算
{
  h.settings.stages = allStages(10);
  const followup = h.tools.get('pipeline_followup');
  const run = (child, message) => followup.execute({ child, message, files: '-' }, { agent: h.parent, signal: new AbortController().signal });

  // 8a) 运行中插话：不重置（否则 steer 就是绕过止损线的手段）
  const beforeRunning = h.interrupts.length;
  const childA = await dispatch('subagent_impl');
  advance(9 * MINUTE);
  const midRun = await run(childA.subagentId, 'keep going, one more thing');
  check('运行中插话不重置墙钟', midRun.wallClockRearmed === undefined, JSON.stringify(midRun));
  advance(2 * MINUTE);
  sweep();
  await tick(30);
  const hitsA = h.interrupts.slice(beforeRunning).filter((row) => row.id === childA.subagentId);
  check('原预算仍按时到期（插话不延长）', hitsA.length === 1, 'hits ' + hitsA.length);

  // 8b) 收尾回合结束后续跑：重新起算，并按当前设置取新预算
  h.emit('subagent/end', { id: childA.subagentId });
  h.settings.stages = allStages(4);
  const beforeRearm = h.interrupts.length;
  const continued = await run(childA.subagentId, 'now do the remaining part');
  check('续跑已停下的子代理会重新起算墙钟', continued.wallClockRearmed === true, JSON.stringify(continued));
  advance(3 * MINUTE);
  sweep();
  await tick(30);
  check('重新起算后按新预算计时（未到点不中断）', h.interrupts.length === beforeRearm, 'got ' + (h.interrupts.length - beforeRearm));
  advance(2 * MINUTE);
  sweep();
  await tick(30);
  const hitsA2 = h.interrupts.slice(beforeRearm).filter((row) => row.id === childA.subagentId);
  check('新预算到点再次中断', hitsA2.length === 1, 'hits ' + hitsA2.length);

  // 8c) 正常 settle 后的续跑（评审第 2 轮那条路）同样重新起算
  const childB = await dispatch('subagent_review', { prompt: 'review it', diff: '@@ -1 +1 @@' });
  h.emit('subagent/end', { id: childB.subagentId });
  const settledFollowup = await run(childB.subagentId, 'round 2: here is the new diff');
  check('settle 后续跑（评审第 2 轮）也重新起算', settledFollowup.wallClockRearmed === true, JSON.stringify(settledFollowup));
}

// 9) queue 投递路径（followupMode: 'queue'）：pipeline_followup 走 subagents.prompt，
//    载荷必须是宿主 control schema 的唯一合法形状 mode:'continuable' + delivery:'queue'，
//    且首项即被接受——探测表不得发生第 2 次尝试。
{
  h.settings.stages = allStages(0); // 本场景不设墙钟，避免巡检干扰
  h.settings.followupMode = 'queue';
  const child = await dispatch('subagent_impl');
  h.children.set(child.subagentId, { activity: 'idle' });
  const beforeAttempts = h.calls.prompt;
  const beforeQueued = h.queued.length;
  let result;
  try {
    result = await followup(child.subagentId, 'queued requirement change');
  } catch (error) {
    result = { threw: String(error?.message ?? error) };
  }
  const payload = h.queued[beforeQueued];
  check('followupMode=queue：pipeline_followup 成功返回并透出宿主回执的 messageId',
    result.ok === true && result.messageId === 'msg-1' && result.childId === child.subagentId,
    JSON.stringify(result));
  check('queue 载荷是宿主唯一合法形状（mode=continuable + delivery=queue）',
    payload?.mode === 'continuable' && payload?.delivery === 'queue'
      && payload?.childSessionId === child.subagentId
      && payload?.content?.[0]?.text.startsWith('queued requirement change'),
    JSON.stringify(payload ?? null));
  check('queue 投递只发生一次尝试（探测表首项即被接受，无第 2 次尝试）',
    h.calls.prompt === beforeAttempts + 1, 'attempts ' + (h.calls.prompt - beforeAttempts));
  h.emit('subagent/end', { id: child.subagentId });
  h.settings.followupMode = 'steer';
}

// 10) 探测表回退（两种已知形状都被宿主拒 = 探测表被走到底）：只尝试两次
//     「带 delivery 的当前形状」→「不带 delivery 的 continuable」，绝不尝试已删除的
//     mode:'queue'（第三项）。两种形状都拒是关键：只要第二项被接受，把第三项加回
//     探测表也不会多出任何一次尝试，断言就失去回归保护力。
{
  h.settings.stages = allStages(0);
  h.settings.followupMode = 'queue';
  const child = await dispatch('subagent_plan');
  h.children.set(child.subagentId, { activity: 'idle' });
  const beforeAttempts = h.calls.prompt;
  h.calls.rejectDelivery = true;
  h.calls.rejectKnownShapes = true;
  let result;
  try {
    result = await followup(child.subagentId, 'legacy host shape');
  } catch (error) {
    result = { threw: String(error?.message ?? error) };
  } finally {
    h.calls.rejectDelivery = false;
    h.calls.rejectKnownShapes = false;
  }
  check('两种已知形状都被拒：探测表只尝试两次',
    h.calls.prompt === beforeAttempts + 2,
    'attempts ' + (h.calls.prompt - beforeAttempts) + ' result ' + JSON.stringify(result));
  // 尝试序列（假宿主在判定接受之前记账）——这是"已删除的第三项永不被尝试"的有效断言：
  // 计数断言只能拦住更长的探测表（把 mode:'queue' 那一项加回就会多出一次尝试），序列
  // 断言额外钉住每次尝试的形状——回退项必须是不带 delivery 的 continuable（只改形状、
  // 例如给第二项加 delivery:'steer'，计数仍是 2、计数断言察觉不到，形状只能靠序列断言拦住）。
  const fallbackAttempts = h.calls.promptPayloads.slice(beforeAttempts);
  check('回退的尝试序列恰为 [continuable+delivery, continuable]，没有任何 mode=queue',
    fallbackAttempts.length === 2
      && fallbackAttempts[0]?.mode === 'continuable' && fallbackAttempts[0]?.delivery === 'queue'
      && fallbackAttempts[1]?.mode === 'continuable' && fallbackAttempts[1]?.delivery === undefined
      && !fallbackAttempts.some((row) => row?.mode === 'queue'),
    'sequence [' + fallbackAttempts.map(shapeOf).join(', ') + ']');
  h.emit('subagent/end', { id: child.subagentId });
  h.settings.followupMode = 'steer';
}

// 11) 宿主改写文案时靠结构化 details.issues 兜底继续探测：code 仍是
//     gateway/bad-request，但 message 已被改写（不再以 "invalid payload for
//     subagent.prompt" 开头）——前缀判定失效。旧实现（整句相等，以及本轮修掉的三元
//     "message 是字符串就看前缀、否则看 issues"）在这里都会放弃回退、把带 delivery
//     的形状第一次被拒就当失败；OR 兜底必须仍然回退到第二项并成功投递。
{
  h.settings.stages = allStages(0);
  h.settings.followupMode = 'queue';
  const child = await dispatch('subagent_impl');
  h.children.set(child.subagentId, { activity: 'idle' });
  const beforeAttempts = h.calls.prompt;
  h.calls.rejectDelivery = true;
  h.calls.rewriteBadPayloadMessage = true;
  let result;
  try {
    result = await followup(child.subagentId, 'rewritten host message');
  } catch (error) {
    result = { threw: String(error?.message ?? error) };
  } finally {
    h.calls.rejectDelivery = false;
    h.calls.rewriteBadPayloadMessage = false;
  }
  const retryAttempts = h.calls.promptPayloads.slice(beforeAttempts);
  check('宿主改写文案但带 details.issues：结构化兜底仍触发回退（前缀判定失效不影响）',
    retryAttempts.length === 2
      && retryAttempts[0]?.mode === 'continuable' && retryAttempts[0]?.delivery === 'queue'
      && retryAttempts[1]?.mode === 'continuable' && retryAttempts[1]?.delivery === undefined,
    'sequence [' + retryAttempts.map(shapeOf).join(', ') + '] result ' + JSON.stringify(result));
  check('文案改写场景回退后同样返回宿主回执 messageId', result?.messageId === 'msg-1', JSON.stringify(result));
  check('回退成功后队列里落的是不带 delivery 的 continuable 载荷',
    h.queued[h.queued.length - 1]?.mode === 'continuable'
      && h.queued[h.queued.length - 1]?.delivery === undefined,
    JSON.stringify(h.queued[h.queued.length - 1] ?? null));
  h.emit('subagent/end', { id: child.subagentId });
  h.settings.followupMode = 'steer';
}

// ════════════════════════════════════════════════════════════════════════════
// 运行并发上限 + 压缩后复用 + 别名稳定（机制回归基线，0.4.0 起无创建总量上限）
// ════════════════════════════════════════════════════════════════════════════
// 与上面的墙钟场景刻意隔离：并发账本按父会话隔离，因此每个新场景都用独立 parentId
// 的假 ctx（账本互不可见），childId 也全局唯一。

const stageKeys = ['plan', 'impl', 'review'];
const capStages = (maxConcurrency) => ({
  plan: { budgetMinutes: 0 },
  impl: { budgetMinutes: 0, maxConcurrency },
  review: { budgetMinutes: 0 },
});
async function newHarness(parentId, stages) {
  const harness = createHarness(parentId);
  await plugin.apply(harness.ctx, { preset: 'code-pipeline' });
  harness.emit('agent/created', { agent: harness.parent });
  harness.settings.stages = stages ?? capStages(0);
  return harness;
}
const runStage = (harness, toolName, args = {}) => harness.tools.get(toolName).execute(
  { prompt: 'do the thing', files: '-', ...args },
  { agent: harness.parent, signal: new AbortController().signal },
);
const runFollowup = (harness, child, message, compact) => harness.tools.get('pipeline_followup').execute(
  compact === true ? { child, message, files: '-', compact: true } : { child, message, files: '-' },
  { agent: harness.parent, signal: new AbortController().signal },
);
const attempt = async (harness, toolName, args = {}) => {
  try {
    return { ok: true, result: await runStage(harness, toolName, args) };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
};
// 直接调任意工具（结构化 I/O 测试用：pipeline_submit / pipeline_result 不属于阶段工具）。
const attemptTool = async (tool, args, agent) => {
  try {
    return { ok: true, result: await tool.execute(args, { agent, signal: new AbortController().signal }) };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
};
const attemptFollowup = async (harness, child, message, compact) => {
  try {
    return { ok: true, result: await runFollowup(harness, child, message, compact) };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
};

// ── A. 运行并发闸门（上限 = 同时运行数；0.4.0 起没有「已创建总量」上限）─────────
{
  const cap = await newHarness('parent-cap-1', capStages(1));
  const first = await attempt(cap, 'subagent_impl', { description: 'cap test one' });
  const firstId = first.result?.subagentId;
  check(
    'A1 运行上限=1：第 1 个同阶段派发成功并返回 durable subagentId',
    first.ok === true && first.result?.kind === 'continuable' && typeof firstId === 'string',
    JSON.stringify(first).slice(0, 200),
  );
  const second = await attempt(cap, 'subagent_impl', { description: 'cap test two' });
  check('A1 运行上限=1：第 1 个仍在跑时第 2 个同阶段派发必抛（是硬闸门，不是劝说）', second.ok === false, JSON.stringify(second).slice(0, 200));
  check('A1 宿主的创建入口 startContinuable 只被调用 1 次（证明是代码拦下的）', cap.calls.start === 1, 'start ' + cap.calls.start);
  check(
    'A1 第 2 次派发被运行上限闸门拦下（stage concurrency limit reached）',
    /stage concurrency limit reached/i.test(second.message ?? ''),
    (second.message ?? '').slice(0, 160),
  );
  check(
    'A1 运行上限拒绝文案明确「不是阶段失败、不要停任务」且不带 UNAVAILABLE 指引横幅',
    (second.message ?? '').includes('NOT a stage failure')
      && !(second.message ?? '').includes('Pipeline stage UNAVAILABLE'),
    (second.message ?? '').slice(0, 200),
  );
  check(
    'A2 运行上限文案把「等名额释放后在后续步骤派发新孩子」写成出路，且不再出现创建闸门的跨工作流复用段',
    (second.message ?? '').includes('fresh child')
      && (second.message ?? '').includes('pipeline_followup')
      && !(second.message ?? '').includes('CROSS-WORKSTREAM REUSE HAS A PRICE'),
    (second.message ?? '').slice(0, 320),
  );

  // 结束第 1 个后运行名额释放：第 3 次派发**成功**（证明没有「已创建总量」上限）。
  cap.emit('subagent/end', { id: firstId });
  cap.children.set(firstId, { activity: 'idle', label: 'impl/cap test one' });
  const third = await attempt(cap, 'subagent_impl', { description: 'cap test three' });
  check(
    'A3 子代理结束后运行名额释放：第 3 次派发成功（证明没有「已创建总量」闸门）',
    third.ok === true,
    JSON.stringify(third).slice(0, 240),
  );
  check('A3 宿主创建入口被真实调用第 2 次（第 3 次真的创建了）', cap.calls.start === 2, 'start ' + cap.calls.start);
}

// A4 上限 0 = 不限制（零回归）
{
  const zero = await newHarness('parent-cap-0', capStages(0));
  const results = [];
  for (let i = 0; i < 3; i += 1) results.push(await attempt(zero, 'subagent_impl', { description: 'unlimited ' + i }));
  check('A4 maxConcurrency=0：连派 3 个同阶段子代理全部成功', results.every((row) => row.ok === true), JSON.stringify(results.map((row) => row.ok)));
  check('A4 上限 0 = 不限制：宿主创建入口被调用 3 次', zero.calls.start === 3, 'start ' + zero.calls.start);
}

// ── A8 宿主「同时存活 continuable 子代理」容量拒绝（dsh 0.1.6-alpha.2 新增）──────
// 宿主为每个 root 共享一个 ActivationPool（subagent.maxActiveSubagents，默认 8），
// 名额用尽时 startContinuable 抛裸 SubagentError(ACTIVATION_LIMIT_REACHED)、冷启动
// 投递被映射成 RemoteError('subagent/delivery-unavailable')。两者都是**瞬时容量
// 拒绝**：文案必须像运行/创建上限那样叮嘱「等名额释放后复用或重试」，绝不能带
// UNAVAILABLE 指引（那会让主代理终止整个任务）。
{
  const hostCap = await newHarness('parent-host-cap', capStages(0));
  const activationError = new Error('subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents');
  activationError.code = 'ACTIVATION_LIMIT_REACHED';
  hostCap.calls.startFailure = activationError;
  const refused = await attempt(hostCap, 'subagent_impl', { description: 'host capacity' });
  check('A8 宿主 ACTIVATION_LIMIT_REACHED：派发被拒（不是静默放行）', refused.ok === false, JSON.stringify(refused).slice(0, 200));
  check(
    'A8 文案是「宿主容量耗尽」而不是阶段不可用（没有 UNAVAILABLE 指引横幅）',
    (refused.message ?? '').includes("HOST's live-subagent capacity is exhausted")
      && !(refused.message ?? '').includes('Pipeline stage UNAVAILABLE')
      && !(refused.message ?? '').includes('STOP and report to the user'),
    (refused.message ?? '').slice(0, 240),
  );
  check(
    'A8 文案给出复用/等待出路（pipeline_followup + LATER step）',
    (refused.message ?? '').includes('pipeline_followup') && (refused.message ?? '').includes('LATER step'),
    (refused.message ?? '').slice(0, 400),
  );

  // 对照组：与容量无关的创建失败仍然是阶段不可用（不能被这次改动误伤）。
  hostCap.calls.startFailure = new Error('unrelated subagent store explosion');
  const broken = await attempt(hostCap, 'subagent_impl', { description: 'other failure' });
  check(
    'A8 非容量错误仍按阶段不可用处理（保留 UNAVAILABLE 指引）',
    (broken.message ?? '').includes('Pipeline stage UNAVAILABLE') && (broken.message ?? '').includes('STOP and report to the user'),
    (broken.message ?? '').slice(0, 200),
  );
  hostCap.calls.startFailure = null;
}

// A9 冷启动复用撞上宿主容量：queue 投递路径的 RemoteError('subagent/delivery-unavailable')
{
  const cold = await newHarness('parent-host-cap-followup', capStages(0));
  const dispatched = await attempt(cold, 'subagent_impl', { description: 'cold child' });
  const childId = dispatched.result?.subagentId;
  // 冷下来：settle 后宿主行改 idle，唤醒它就需要一个新的存活名额。
  cold.emit('subagent/end', { id: childId });
  cold.children.set(childId, { activity: 'idle', label: 'impl/cold child' });
  const deliveryError = new Error('subagent follow-up is temporarily unavailable');
  deliveryError.code = 'subagent/delivery-unavailable';
  cold.calls.promptFailure = deliveryError;
  cold.settings.followupMode = 'queue';
  const refused = await attemptFollowup(cold, childId, 'more work');
  check('A9 冷启动被容量拒绝：pipeline_followup 抛错且什么都没投递', refused.ok === false && cold.queued.length === 0, JSON.stringify(refused).slice(0, 200));
  check(
    'A9 文案说清「孩子完好、什么都没投递、等名额释放后重试」，且不带 UNAVAILABLE 指引',
    (refused.message ?? '').includes("HOST's live-subagent capacity is exhausted")
      && (refused.message ?? '').includes('NOTHING was delivered')
      && !(refused.message ?? '').includes('Pipeline stage UNAVAILABLE'),
    (refused.message ?? '').slice(0, 260),
  );

  // 对照组：非容量类投递失败仍是原来的 delivery failed 文案。
  const otherError = new Error('subagent not-resumable');
  otherError.code = 'subagent/not-resumable';
  cold.calls.promptFailure = otherError;
  const other = await attemptFollowup(cold, childId, 'more work');
  check('A9 非容量投递失败仍报 pipeline_followup delivery failed', (other.message ?? '').includes('pipeline_followup delivery failed'), (other.message ?? '').slice(0, 160));
  cold.calls.promptFailure = null;
}

// A5 并发竞态：同一个程序里 Promise.all 三个（cap=1）→ 同步预留只放行 1 个
{
  const race = await newHarness('parent-cap-race', capStages(1));
  const settled = await Promise.all([
    attempt(race, 'subagent_impl', { description: 'race a' }),
    attempt(race, 'subagent_impl', { description: 'race b' }),
    attempt(race, 'subagent_impl', { description: 'race c' }),
  ]);
  const passed = settled.filter((row) => row.ok === true);
  const refused = settled.filter((row) => row.ok === false);
  check('A5 并发竞态（cap=1、Promise.all 三个）：只放行 1 个', passed.length === 1, JSON.stringify(settled.map((row) => row.ok)));
  check('A5 并发竞态：宿主创建入口只被调用 1 次（同步预留生效）', race.calls.start === 1, 'start ' + race.calls.start);
  check(
    'A5 被拒的两个都是运行上限拒绝（没有创建总量闸门），不是别的失败',
    refused.length === 2 && refused.every((row) => /stage concurrency limit reached/i.test(row.message ?? '')),
    JSON.stringify(refused.map((row) => (row.message ?? '').slice(0, 90))),
  );
}

// A6 重启持久面：宿主 listChildren 里的运行行参与并发计数（label 前缀 / live stageKey）
{
  const persist = await newHarness('parent-persist', capStages(1));
  persist.children.set('orphan-impl-1', { activity: 'running', label: 'impl/orphan from a previous process' });
  const blocked = await attempt(persist, 'subagent_impl', { description: 'after restart' });
  check(
    'A6 台账里没有、仅靠宿主持久行的 <stage>/ 前缀 label，运行中的它就让 impl 判定已达运行上限并被拒',
    blocked.ok === false && /stage concurrency limit reached/i.test(blocked.message ?? ''),
    JSON.stringify(blocked).slice(0, 220),
  );
  check('A6 该路径没有调用宿主创建入口', persist.calls.start === 0, 'start ' + persist.calls.start);
  persist.children.set('orphan-impl-1', { activity: 'idle', label: 'impl/orphan from a previous process' });
  const afterIdle = await attempt(persist, 'subagent_impl', { description: 'slot freed' });
  check('A6 持久行 idle 后不再计运行数（新派发成功）', afterIdle.ok === true, JSON.stringify(afterIdle).slice(0, 200));
  // 对照：无阶段前缀的行不归属任何阶段 —— plan 阶段照常派发。
  persist.children.set('orphan-nolabel-1', { activity: 'running', label: 'unrelated child' });
  const planOk = await attempt(persist, 'subagent_plan', { description: 'plan still works' });
  check('A6 对照：无阶段前缀的持久行不参与阶段计数（plan 照常派发成功）', planOk.ok === true, JSON.stringify(planOk).slice(0, 180));

  // 归属优先级第二级：活 agent 的 options.stageKey（label 无前缀也认）
  const warm = await newHarness('parent-warm', capStages(1));
  warm.childAgents.set('warm-impl-1', { id: 'warm-impl-1', options: { stageKey: 'impl' } });
  warm.children.set('warm-impl-1', { activity: 'running', label: 'no stage prefix here' });
  const warmBlocked = await attempt(warm, 'subagent_impl', { description: 'stageKey attribution' });
  check(
    'A6 归属优先级：活 agent 的 options.stageKey 也能识别阶段（运行中的它照样计数）',
    warmBlocked.ok === false && /stage concurrency limit reached/i.test(warmBlocked.message ?? ''),
    JSON.stringify(warmBlocked).slice(0, 220),
  );
  check('A6 stageKey 归属路径同样没有调用宿主创建入口', warm.calls.start === 0, 'start ' + warm.calls.start);
}

// ── B. 压缩后复用（compact: true）：顺序硬约束 + 失败路径一律不投递 ─────────────
{
  const cp = await newHarness('parent-compact', capStages(0));
  const child = await runStage(cp, 'subagent_impl', { description: 'compact target' });
  const childId = child.subagentId;
  const live = { id: childId, options: { stageKey: 'impl' } };
  cp.childAgents.set(childId, live);
  cp.presets.serviceFor = (agent, serviceName) => {
    cp.calls.serviceForArgs.push({ agent, serviceName });
    return serviceName === 'compaction' ? cp.compaction : undefined;
  };
  const orderIndex = (name) => cp.calls.order.indexOf(name);

  // B7 成功路径
  cp.compaction = {
    compactNow: async (childAgent, signal) => {
      cp.calls.order.push('compactNow');
      cp.calls.compactNowArgs.push({ childAgent, signal });
      return { summary: 'compacted' };
    },
  };
  cp.calls.order.length = 0;
  const beforeCompact = cp.steers.length;
  const compacted = await attemptFollowup(cp, childId, 'reuse with compaction', true);
  check(
    'B7 compact:true 成功路径：compacted 置 true 且消息真的投递了',
    compacted.ok === true && compacted.result?.compacted === true && cp.steers.length === beforeCompact + 1,
    JSON.stringify(compacted).slice(0, 240),
  );
  check(
    'B7 压缩服务走 agentPresets.serviceFor(child, "compaction")（preset realm 私有实例）',
    cp.calls.serviceForArgs.some((row) => row.serviceName === 'compaction' && row.agent === live),
    JSON.stringify(cp.calls.serviceForArgs.map((row) => row.serviceName)),
  );
  check(
    'B7 compactNow 的第一个实参就是目标子代理对象，第二个是 AbortSignal',
    cp.calls.compactNowArgs[0]?.childAgent === live && cp.calls.compactNowArgs[0]?.signal instanceof AbortSignal,
    String(cp.calls.compactNowArgs[0]?.childAgent?.id),
  );
  check(
    'B7 顺序硬约束：compactNow 早于投递（sendMessage）',
    orderIndex('compactNow') >= 0 && orderIndex('sendMessage') >= 0 && orderIndex('compactNow') < orderIndex('sendMessage'),
    JSON.stringify(cp.calls.order),
  );
  check(
    'B7 恰好一次压缩 + 恰好一次投递（没有重复投递）',
    cp.calls.order.filter((name) => name === 'compactNow').length === 1 && cp.calls.order.filter((name) => name === 'sendMessage').length === 1,
    JSON.stringify(cp.calls.order),
  );

  // B8 compactNow 返回 null：没有可压区间，不算失败，投递照常，compacted 不置 true
  cp.compaction = { compactNow: async () => { cp.calls.order.push('compactNow'); return null; } };
  cp.calls.order.length = 0;
  const beforeNull = cp.steers.length;
  const nullResult = await attemptFollowup(cp, childId, 'null compaction', true);
  check(
    'B8 compactNow 返回 null：不抛错、compacted 不置 true',
    nullResult.ok === true && nullResult.result?.compacted === undefined,
    JSON.stringify(nullResult).slice(0, 240),
  );
  check(
    'B8 compactNow 返回 null：投递照常发生',
    cp.steers.length === beforeNull + 1 && cp.calls.order.includes('sendMessage'),
    JSON.stringify(cp.calls.order),
  );

  // B9 压缩失败（ManualCompactionError 的 busy / summary）：抛错 + 一次都没投递
  for (const code of ['busy', 'summary']) {
    cp.compaction = {
      compactNow: async () => {
        const error = new Error('manual compaction refused: ' + code);
        error.code = code;
        throw error;
      },
    };
    const beforeSends = cp.calls.sendMessageOptions.length;
    const beforePrompts = cp.calls.prompt;
    const failed = await attemptFollowup(cp, childId, 'compaction fails ' + code, true);
    check(
      'B9 compactNow 抛 ' + code + '：抛错且文案含失败码与「什么都没投递」',
      failed.ok === false && (failed.message ?? '').includes(code) && (failed.message ?? '').includes('Nothing was delivered to the child'),
      JSON.stringify(failed).slice(0, 260),
    );
    check(
      'B9 compactNow 抛 ' + code + '：投递一次都没发生（steer 与 queue 两条通道都没动）',
      cp.calls.sendMessageOptions.length === beforeSends && cp.calls.prompt === beforePrompts,
      'sendMessage +' + (cp.calls.sendMessageOptions.length - beforeSends) + ' / prompt +' + (cp.calls.prompt - beforePrompts),
    );
  }

  // B10 服务寻址失败：serviceFor 返回 undefined / 返回没有 compactNow 的对象
  const beforeNoService = cp.calls.sendMessageOptions.length;
  cp.presets.serviceFor = () => undefined;
  const noService = await attemptFollowup(cp, childId, 'no compaction service', true);
  check(
    'B10 serviceFor 返回 undefined：明确错误（compactNow 不可达）且未投递',
    noService.ok === false && (noService.message ?? '').includes('compactNow')
      && (noService.message ?? '').includes('compact: false')
      && (noService.message ?? '').includes('Nothing was delivered'),
    JSON.stringify(noService).slice(0, 260),
  );
  check('B10 serviceFor 返回 undefined：投递次数不变', cp.calls.sendMessageOptions.length === beforeNoService);
  cp.presets.serviceFor = (agent, serviceName) => (serviceName === 'compaction' ? {} : undefined);
  const emptyService = await attemptFollowup(cp, childId, 'empty compaction service', true);
  check(
    'B10 serviceFor 返回没有 compactNow 的对象：同样明确拒绝且未投递',
    emptyService.ok === false && (emptyService.message ?? '').includes('compactNow')
      && cp.calls.sendMessageOptions.length === beforeNoService,
    JSON.stringify(emptyService).slice(0, 260),
  );

  // B11 目标子代理不在 agents.get 里（冷子代理）：明确错误 + 未投递
  const cold = await runStage(cp, 'subagent_impl', { description: 'cold child' });
  cp.presets.serviceFor = (agent, serviceName) => (serviceName === 'compaction' ? cp.compaction : undefined);
  cp.compaction = { compactNow: async () => { cp.calls.order.push('compactNow'); return {}; } };
  cp.calls.order.length = 0;
  const beforeCold = cp.calls.sendMessageOptions.length;
  const coldResult = await attemptFollowup(cp, cold.subagentId, 'compact a cold child', true);
  check(
    'B11 冷子代理（agents.get 拿不到）无法压缩：明确错误 + 未投递',
    coldResult.ok === false
      && (coldResult.message ?? '').includes('cold subagent')
      && (coldResult.message ?? '').includes('Nothing was delivered')
      && cp.calls.sendMessageOptions.length === beforeCold,
    JSON.stringify(coldResult).slice(0, 260),
  );
  check('B11 冷子代理的错误提示：改走不带 compact 的投递、不承诺重试', (coldResult.message ?? '').includes('compact: false'));
  check('B11 冷子代理路径根本没有调用 compactNow', !cp.calls.order.includes('compactNow'), JSON.stringify(cp.calls.order));
}

// ── C. 别名解析按 seq 稳定：rearmStageBudget 改写 entry.at 之后不漂移 ──────────
{
  const al = await newHarness('parent-alias', capStages(0));
  const implA = await runStage(al, 'subagent_impl', { description: 'alias first' });
  const implB = await runStage(al, 'subagent_impl', { description: 'alias second' });
  const baseline = await attemptFollowup(al, 'impl', 'baseline alias resolution');
  check(
    'C12 前置：两个 impl 都在台账里，child:"impl" 指向最近派发的那个（seq 最大）',
    baseline.ok === true && baseline.result?.childId === implB.subagentId,
    JSON.stringify(baseline).slice(0, 200) + ' expected ' + implB.subagentId,
  );
  al.emit('subagent/end', { id: implA.subagentId });
  al.children.set(implA.subagentId, { activity: 'idle', label: 'impl/alias first' });
  advance(10 * MINUTE); // 让 rearm 后的 entry.at 明确晚于 implB 的派发时刻
  const rearmed = await attemptFollowup(al, implA.subagentId, 'round 2 on the first impl');
  check(
    'C12 前置：精确 id 续跑已停下的 impl 触发墙钟重新起算（entry.at 被改写）',
    rearmed.ok === true && rearmed.result?.wallClockRearmed === true && rearmed.result?.childId === implA.subagentId,
    JSON.stringify(rearmed).slice(0, 200),
  );
  const byAlias = await attemptFollowup(al, 'impl', 'alias after rearm');
  check(
    'C12 rearm 改写 at 之后 child:"impl" 仍指向同一子代理（不漂移到被 rearm 的那个）',
    byAlias.ok === true && byAlias.result?.childId === implB.subagentId,
    JSON.stringify(byAlias).slice(0, 200) + ' expected ' + implB.subagentId + ' (implA=' + implA.subagentId + ')',
  );
  const byLatest = await attemptFollowup(al, 'latest', 'latest after rearm');
  check(
    'C12 child:"latest" 同样按 seq 取最近派发（不受 rearm 影响）',
    byLatest.ok === true && byLatest.result?.childId === implB.subagentId,
    JSON.stringify(byLatest).slice(0, 200) + ' expected ' + implB.subagentId,
  );
  check(
    'C12 被 rearm 的子代理自身仍可用精确 id 命中（别名与精确 id 两条路都在）',
    (byAlias.result?.childId !== implA.subagentId) && (byLatest.result?.childId !== implA.subagentId),
  );
}

// ── D. status 新字段 + 阶段描述指引（补充证据）────────────────────────────────
{
  const stages = await statusOf();
  check(
    'D13 status 每阶段含 created（number）',
    stageKeys.every((key) => typeof stages[key]?.created === 'number'),
    JSON.stringify(stageKeys.map((key) => [key, stages[key]?.created])),
  );
  check(
    'D13 status 每阶段含 available（数组，元素带 id / label / activity）',
    stageKeys.every((key) => Array.isArray(stages[key]?.available)
      && stages[key].available.every((row) => typeof row.id === 'string' && row.id.length > 0
        && typeof row.label === 'string' && row.label.length > 0
        && (row.activity === 'running' || row.activity === 'inactive'))),
    JSON.stringify(stages.impl?.available?.slice(0, 3) ?? null),
  );
  check(
    'D13 created 与 available.length 一致（created 就是可复用清单的长度）',
    stageKeys.every((key) => stages[key]?.created === stages[key]?.available?.length),
    JSON.stringify(stageKeys.map((key) => [stages[key]?.created, stages[key]?.available?.length])),
  );
  check(
    'D13 available 列出本进程派发过的阶段子代理，label 带 <stage>/ 前缀',
    stageKeys.every((key) => (stages[key]?.available ?? []).some((row) => row.label.startsWith(key + '/'))),
    JSON.stringify(stageKeys.map((key) => (stages[key]?.available ?? []).map((row) => row.label).slice(0, 3))),
  );
  check(
    'D15 三条阶段描述都写明「没有创建总量上限、新工作流派新孩子」',
    stageKeys.every((key) => {
      const text = String(h.tools.get('subagent_' + key)?.description ?? '');
      return text.includes('CONCURRENCY:') && text.includes('NO cap on how many children may be CREATED in total') && text.includes('pipeline_followup');
    }),
    JSON.stringify(stageKeys.map((key) => String(h.tools.get('subagent_' + key)?.description ?? '').includes('CONCURRENCY:'))),
  );
  check(
    'D15 三条阶段描述都不再出现创建闸门措辞',
    stageKeys.every((key) => !String(h.tools.get('subagent_' + key)?.description ?? '').includes('CREATION CAP')),
  );
}

// ── E. 预设内容契约（0.2.2）：压缩出厂默认 + 扇出分级 + 冷子代理边界 + 评审增量轮 ──
// 预设既是「策略文本」又是设置页的写入目标，所以它的回归只能落在内容契约上：解析真实
// YAML、钉住压缩行的**出厂默认值**与宿主加载期不变式，并确认四处策略锚点仍在 persona 里。
{
  const presetPath = join(root, 'preset', 'code-pipeline', 'agent.cordis.yml');
  const presetText = readFileSync(presetPath, 'utf8');
  let preset;
  let parseError;
  try {
    preset = parse(presetText);
  } catch (error) {
    parseError = String(error?.message ?? error);
  }
  check('E1 预设文件可被 yaml 解析（E2–E8 依赖解析结果）', parseError === undefined, parseError);
  const rows = Array.isArray(preset) ? preset : [];
  const groupRows = rows.find((row) => row?.id === 'compaction')?.config;
  const basic = (Array.isArray(groupRows) ? groupRows : []).find((row) => row?.id === 'compaction-basic')?.config ?? {};
  check(
    'E2 compaction-basic 的出厂默认 = thresholdRatio 0.5 / retainRatio 0.1（设置页「压缩触发比例」可覆盖）',
    basic.thresholdRatio === 0.5 && basic.retainRatio === 0.1,
    JSON.stringify(basic),
  );
  check(
    'E3 宿主加载期不变式：retainRatio < thresholdRatio（0.1 < 0.5）',
    typeof basic.retainRatio === 'number' && typeof basic.thresholdRatio === 'number'
      && basic.retainRatio < basic.thresholdRatio,
    JSON.stringify(basic),
  );
  check(
    'E8 预设只写比例、绝不写 retainTokens（宿主拒绝两种保留形式并存）',
    !presetText.includes('retainTokens'),
  );
  const persona = String(rows.find((row) => row?.id === 'persona')?.config?.prefix ?? '');
  check(
    'E4 分档改为 T0/T1/T2 + 默认最小档 + 惰性升级（旧的 Right-size 措辞已消失）',
    persona.includes('T0 — you do it in the main session. No stage at all.')
      && persona.includes('T1 — you plan, the stages execute and verify.')
      && persona.includes('T2 — the full build flow below.')
      && persona.includes('Escalate lazily, and only upward.')
      && !persona.includes('Right-size the pipeline before you dispatch anything'),
  );
  check(
    'E5 并行写降级为例外（读/评审仍默认并行）',
    persona.includes('parallel WRITES are the exception')
      && persona.includes('Keep WRITES single-threaded by default')
      && !persona.includes('Parallel dispatch is the default choice, not a last resort'),
  );
  check(
    'E11 评审裁决策略锚点（机械白名单 + 拒绝理由留痕 + 无 blocker 即收尾）',
    persona.includes('Triage the review before you fix anything')
      && persona.includes('AND confidence >= 0.8')
      && persona.includes('AND onChangedLines == true')
      && persona.includes('intent-misalignment')
      && persona.includes('The exit condition is "nothing must be fixed", not "the reviewer is satisfied".'),
  );
  // E12 的锚点在**阶段子代理的 persona**（lib/index.js 的 PERSONAS.review）里，不在预设主 persona 里：
  // 反吹毛求疵的规则由 reviewer 自己执行，主代理只按白名单过滤（E11）。
  const pluginSource = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  check(
    'E12 reviewer 契约锚点（无 failureScenario 不得 blocking；docs/style 永不 blocking；verdict 机械判定）',
    pluginSource.includes('If you cannot state a concrete')
      && pluginSource.includes('findings are NEVER blocking')
      && pluginSource.includes('NEVER withhold an approve verdict over a non-blocking finding'),
  );
  check(
    'E13 收敛锚点（封闭复验 + 伪 bug 循环即停 + 3 轮是保险丝）',
    persona.includes('Do not open new findings.')
      && persona.includes('pseudo-bug-fix cycle')
      && persona.includes('fuse, not a target'),
  );
  check(
    'E14 宿主存活容量上限写进 persona（0.1.6-alpha.2 的 persona 缺口）',
    persona.includes('subagent.maxActiveSubagents')
      && persona.includes('TRANSIENT CAPACITY REJECTION'),
  );
  check('E6 冷子代理锚点在 persona 里（A cold child cannot be compacted）', persona.includes('A cold child cannot be compacted'));
  check(
    'E7 评审第 2 轮只送增量：新锚点在、旧的 FULL NEW diff 措辞已消失',
    persona.includes("only the hunks that changed since that reviewer's last verdict")
      && !persona.includes('**the FULL NEW diff** captured at this moment'),
  );
  check(
    'E9 冷子代理边界改后的第 3 条锚点在 persona 里（唤醒也救不了）',
    persona.includes('there is no way to compact a settled child, and waking it does not help'),
  );
  check(
    'E10 评审快照协议锚点在 persona 里（dsh-pipeline-snap + 不写进工作区）',
    persona.includes('dsh-pipeline-snap') && persona.includes('Never write the snapshots inside the workspace'),
  );
}

// ── F. 压缩触发比例对账器（reconcileCompactionRow，纯函数，可离线单测）──────────
// 设置页的值要写进**已安装**的预设组合，全靠这个函数：它必须只改 compaction-basic
// 那一行、覆盖三种用户安装态、幂等，且行外一个字节都不动（行尾符、注释、persona 块标量）。
{
  const { reconcileCompactionRow, compactionRatios } = plugin;
  const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const bodies = (text) => linesOf(text).map((line) => line.replace(/\r?\n$|\r$/, ''));
  // fixture：CRLF + 注释 + persona 块标量 + 前后各一行，一起验证「行外原样」。
  const fixture = (rowLines) => [
    '# top comment (must survive byte-for-byte)',
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: |',
    '      multi-line persona text',
    '      stays byte-identical',
    '- id: compaction',
    '  name: cordis:group',
    '  config:',
    ...rowLines,
    '    - id: command-compact',
    "      name: '@deepseek-ai/dsh-command-compact'",
    '- id: present',
    "  name: '@deepseek-ai/dsh-tool-present'",
    '',
  ].join('\r\n');

  // F1 Case A：行内没有 config:（用户当前的安装态）→ 紧跟 name: 插入 config: 块。
  const caseA = fixture([
    '    - id: compaction-basic',
    "      name: '@deepseek-ai/dsh-compaction-basic'",
  ]);
  const a = reconcileCompactionRow(caseA, compactionRatios(0.5));
  const aLines = bodies(a.text);
  const aName = aLines.indexOf("      name: '@deepseek-ai/dsh-compaction-basic'");
  check(
    'F1 对账器 Case A：没有 config: 的行在 name: 之后补出 config: 块（thresholdRatio / retainRatio）',
    a.found === true && a.changed === true && aName !== -1
      && aLines[aName + 1] === '      config:'
      && aLines[aName + 2] === '        thresholdRatio: 0.5'
      && aLines[aName + 3] === '        retainRatio: 0.1'
      && aLines[aName + 4] === '    - id: command-compact',
    JSON.stringify(aLines.slice(aName, aName + 5)),
  );

  // F2 Case B：已有阈值 / 保留比例 → 就地替换数值，结构不变。
  const caseB = fixture([
    '    - id: compaction-basic',
    "      name: '@deepseek-ai/dsh-compaction-basic'",
    '      config:',
    '        thresholdRatio: 0.8',
    '        retainRatio: 0.16',
  ]);
  const b = reconcileCompactionRow(caseB, compactionRatios(0.5));
  const bLines = bodies(b.text);
  check(
    'F2 对账器 Case B：已有的 thresholdRatio / retainRatio 就地改成 0.5 / 0.1（不增行）',
    b.changed === true
      && bLines.includes('        thresholdRatio: 0.5')
      && bLines.includes('        retainRatio: 0.1')
      && !bLines.includes('        thresholdRatio: 0.8')
      && bLines.length === bodies(caseB).length,
    JSON.stringify(bLines.filter((line) => line.includes('Ratio'))),
  );

  // F3 Case C：老副本里的 retainTokens: 40000 → retainRatio，两种保留形式绝不同时出现。
  const caseC = fixture([
    '    - id: compaction-basic',
    "      name: '@deepseek-ai/dsh-compaction-basic'",
    '      config:',
    '        thresholdRatio: 0.2',
    '        retainTokens: 40000',
  ]);
  const c = reconcileCompactionRow(caseC, compactionRatios(0.5));
  const cLines = bodies(c.text);
  check(
    'F3 对账器 Case C：retainTokens 行被 retainRatio 顶掉（结果里绝不并存两种保留形式）',
    c.changed === true && !c.text.includes('retainTokens')
      && cLines.includes('        retainRatio: 0.1')
      && cLines.includes('        thresholdRatio: 0.5'),
    JSON.stringify(cLines.filter((line) => line.includes('Ratio') || line.includes('Tokens'))),
  );

  // F4 幂等：对自己的输出再跑一次，changed === false 且文本逐字节相同。
  const again = reconcileCompactionRow(a.text, compactionRatios(0.5));
  check(
    'F4 对账器幂等：对自身输出再跑一次 changed=false、文本逐字节不变',
    again.found === true && again.changed === false && again.text === a.text,
  );

  // F5 派生：保留恒为阈值的 1/5，且严格小于阈值（区间两端 0.05 / 0.8 都成立）。
  const low = compactionRatios(0.05);
  const high = compactionRatios(0.8);
  check(
    'F5 派生 retainRatio = thresholdRatio / 5 且严格小于阈值（0.05 与 0.8 两端都成立）',
    low.thresholdRatio === 0.05 && low.retainRatio === Number((0.05 / 5).toFixed(4)) && low.retainRatio < low.thresholdRatio
      && high.thresholdRatio === 0.8 && high.retainRatio === Number((0.8 / 5).toFixed(4)) && high.retainRatio < high.thresholdRatio
      && compactionRatios(0.5).retainRatio === 0.1,
    JSON.stringify({ low, high }),
  );

  // F6 字节保持：Case B 不改行数，行外每一行（含行尾符）必须逐行相同。
  const bBefore = bodies(caseB);
  const bAfter = bodies(b.text);
  const rowStart = bBefore.indexOf('    - id: compaction-basic');
  const rowEnd = bBefore.indexOf('    - id: command-compact');
  check(
    'F6 对账器只动 compaction-basic 行：行外所有行（含 CRLF 行尾）逐行相同',
    rowStart !== -1 && rowEnd !== -1 && bAfter.length === bBefore.length
      && bBefore.slice(0, rowStart).join('\n') === bAfter.slice(0, rowStart).join('\n')
      && bBefore.slice(rowEnd).join('\n') === bAfter.slice(rowEnd).join('\n')
      && b.text.includes('\r\n') && !b.text.replace(/\r\n/g, '').includes('\n'),
  );

  // F8 行尾注释：`config: # 注释` 仍是块风格（先剥注释再判定），不得误判为行内值。
  const caseD = fixture([
    '    - id: compaction-basic',
    "      name: '@deepseek-ai/dsh-compaction-basic'",
    '      config: # 压缩配置',
    '        retainTokens: 40000',
  ]);
  const d = reconcileCompactionRow(caseD, compactionRatios(0.5));
  check(
    'F8 行尾注释的块风格 config:（先剥注释再判定）：注释保留、retainTokens 被顶成 retainRatio',
    d.found === true && d.changed === true && d.unsupported === undefined
      && d.text.includes('config: # 压缩配置')
      && !d.text.includes('retainTokens')
      && bodies(d.text).includes('        thresholdRatio: 0.5')
      && bodies(d.text).includes('        retainRatio: 0.1'),
    JSON.stringify(bodies(d.text).filter((line) => line.includes('config') || line.includes('Ratio') || line.includes('Tokens'))),
  );

  // F7 找不到该行：no-op 且明确报 not found，绝不改写文本。
  const missing = fixture([
    '    - id: command-compact',
    "      name: '@deepseek-ai/dsh-command-compact'",
  ]);
  const notFound = reconcileCompactionRow(missing, compactionRatios(0.5));
  check(
    'F7 对账器找不到 compaction-basic 行：found=false / changed=false / 文本原样返回',
    notFound.found === false && notFound.changed === false && notFound.text === missing,
  );
}

// ── G. 设置 → 已安装预设组合的写入链（installSection → setSource → 对账 → 写盘）──────
// F 只测纯函数；这里用假 settings（installSection 直接调 setSource）+ 各自的临时 DSH_HOME
// 覆盖真正会写盘的那条路：0.3 → 0.3/0.06；组合缺失只告警不创建；没有该行只告警不改写；
// 行内（flow）config: 与「锚点行没有行尾符」两种形状不得写出不可解析的字节（Issue 1/2）。
{
  const originalHome = process.env.DSH_HOME;
  const installedPath = (home) => join(home, '.agent-presets', 'code-pipeline', 'agent.cordis.yml');
  const readIfAny = (home) => (existsSync(installedPath(home)) ? readFileSync(installedPath(home), 'utf8') : undefined);
  const bareHome = () => mkdtempSync(join(tmpdir(), 'dsh-code-pipeline-chain-'));
  const writeHome = (text) => {
    const home = bareHome();
    mkdirSync(join(home, '.agent-presets', 'code-pipeline'), { recursive: true });
    writeFileSync(installedPath(home), text, 'utf8');
    return home;
  };
  // 走真实接线：apply 里的 installSection 会（同步）调用 setSource，从而触发对账写盘。
  const applyAt = async (home, parentId, settings) => {
    process.env.DSH_HOME = home;
    const harness = createHarness(parentId);
    Object.assign(harness.settings, settings);
    await plugin.apply(harness.ctx, { preset: 'code-pipeline' });
    return harness;
  };
  const settle = async (predicate) => {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return true;
      await tick(10);
    }
    return predicate();
  };
  const parses = (text) => {
    try {
      parse(text);
      return true;
    } catch {
      return false;
    }
  };

  // G1 设置 0.3 → 已安装组合真的被写成 0.3 / 0.06（走 await writeFile 那条路）。
  {
    const home = bareHome();
    await applyAt(home, 'parent-chain-write', { compactionThresholdRatio: 0.3 });
    await settle(() => (readIfAny(home) ?? '').includes('thresholdRatio: 0.3'));
    const text = readIfAny(home) ?? '';
    check(
      'G1 设置 compactionThresholdRatio=0.3 → 已安装组合被写成 thresholdRatio 0.3 / retainRatio 0.06',
      text.includes('thresholdRatio: 0.3') && text.includes('retainRatio: 0.06') && !text.includes('retainTokens'),
      (text.match(/thresholdRatio: \S+|retainRatio: \S+/g) ?? []).join(' | '),
    );
  }

  // G2 组合文件缺失：只告警，绝不创建（安装是 ensurePresetInstalled 的职责，这里它是 incomplete）。
  {
    const home = bareHome();
    mkdirSync(join(home, '.agent-presets', 'code-pipeline'), { recursive: true });
    const harness = await applyAt(home, 'parent-chain-missing', { compactionThresholdRatio: 0.3 });
    await tick(30);
    check(
      'G2 已安装组合缺失：只告警、不创建文件',
      !existsSync(installedPath(home))
        && harness.warnings.some((line) => line.includes('installed preset composition missing')),
      JSON.stringify({ created: existsSync(installedPath(home)), warnings: harness.warnings.slice(-2) }),
    );
  }

  // G3 组合里没有 compaction-basic 行：只告警，文件逐字节不变。
  {
    const noRow = [
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '- id: present',
      "  name: '@deepseek-ai/dsh-tool-present'",
      '',
    ].join('\n');
    const home = writeHome(noRow);
    const harness = await applyAt(home, 'parent-chain-norow', { compactionThresholdRatio: 0.3 });
    await tick(30);
    check(
      'G3 组合里没有 compaction-basic 行：只告警、文件逐字节不变',
      readIfAny(home) === noRow
        && harness.warnings.some((line) => line.includes('has no "- id: compaction-basic" row')),
      JSON.stringify(harness.warnings.slice(-1)),
    );
  }

  // G4 Issue 1：行内（flow）config: 必须 no-op——追加第二个 config: 键会让整份预设无法挂载。
  {
    const inlineRow = [
      '- id: compaction',
      '  name: cordis:group',
      '  config:',
      '    - id: compaction-basic',
      "      name: '@deepseek-ai/dsh-compaction-basic'",
      '      config: { thresholdRatio: 0.5, retainRatio: 0.1 }',
      '    - id: command-compact',
      "      name: '@deepseek-ai/dsh-command-compact'",
      '',
    ].join('\n');
    const home = writeHome(inlineRow);
    const harness = await applyAt(home, 'parent-chain-inline', { compactionThresholdRatio: 0.3 });
    await tick(30);
    const text = readIfAny(home) ?? '';
    check(
      'G4 行内（flow）config: → no-op：不追加第二个 config: 键、文件逐字节不变且仍可解析',
      text === inlineRow && parses(text)
        && !text.includes('thresholdRatio: 0.3')
        && harness.warnings.some((line) => line.includes('inline (flow)')),
      JSON.stringify({ unchanged: text === inlineRow, parses: parses(text), warnings: harness.warnings.slice(-1) }),
    );
  }

  // G5 Issue 2：锚点行（这里是最后一行）没有行尾符——新块必须另起一行，写出的字节必须可解析。
  {
    const lastRowNoEol = [
      '- id: compaction',
      '  name: cordis:group',
      '  config:',
      '    - id: compaction-basic',
      "      name: '@deepseek-ai/dsh-compaction-basic'",
    ].join('\n');
    const home = writeHome(lastRowNoEol);
    await applyAt(home, 'parent-chain-lasteol', { compactionThresholdRatio: 0.3 });
    await settle(() => (readIfAny(home) ?? '').includes('thresholdRatio: 0.3'));
    const text = readIfAny(home) ?? '';
    check(
      'G5 锚点行没有行尾符（Issue 2）：新块另起一行、写出的字节仍可被解析',
      parses(text)
        && text.includes("      name: '@deepseek-ai/dsh-compaction-basic'\n      config:\n        thresholdRatio: 0.3\n        retainRatio: 0.06"),
      JSON.stringify(text.slice(-140)),
    );
  }

  process.env.DSH_HOME = originalHome;
}

// ════════════════════════════════════════════════════════════════════════════
// P1–P6：重启后寻址 / label 阶段前缀 / 枚举瞬时失败 / status N+1 / 运行上限文案
// ════════════════════════════════════════════════════════════════════════════
// 与前面所有场景同样按 parentId 隔离（模块级账本按父会话分键），每个 harness 实例
// 各自持有一份可控的宿主持久面（harness.host）。

const capFor = (caps) => ({
  plan: { budgetMinutes: 0, ...(caps.plan === undefined ? {} : { maxConcurrency: caps.plan }) },
  impl: { budgetMinutes: 0, ...(caps.impl === undefined ? {} : { maxConcurrency: caps.impl }) },
  review: { budgetMinutes: 0, ...(caps.review === undefined ? {} : { maxConcurrency: caps.review }) },
});
/** 宿主持久行（listChildren 的形状：只有 id / label / activity）。 */
const persistRows = (rows) => rows.map(([id, label, activity = 'idle']) => ({ kind: 'child', id, activity, label }));
const statusOfHarness = async (harness) => {
  const { res, captured } = captureResponse();
  await harness.routes.get('/dsh-code-pipeline/status')({}, res);
  return JSON.parse(captured.body).stages;
};


// ── F1. 无阶段归属的旧子代理绝不参与任何阶段的并发计数 ────────────────────────
{
  const f1 = await newHarness('parent-f1', capFor({ plan: 1, impl: 1, review: 1 }));
  f1.host.rows = persistRows([
    ['legacy-1', 'W1 infra scaffold', 'running'],
    ['legacy-2', 'review A', 'running'],
    ['legacy-3', 'plan frontend scaffold', 'running'],
  ]);
  const allowed = await attempt(f1, 'subagent_impl', { description: 'fresh work beside the legacy children' });
  check(
    'F1 无归属的旧子代理不计入任何阶段运行数：cap=1 仍能新派',
    allowed.ok === true,
    JSON.stringify(allowed).slice(0, 260),
  );
  const noAddr = await attemptFollowup(f1, 'legacy-1', 'continue the legacy child');
  check(
    'F1 边界保持不变：无归属的旧子代理仍不可寻址（本次不做该增强，属已知边界）',
    noAddr.ok === false && /no stage subagent matches/i.test(noAddr.message ?? ''),
    JSON.stringify(noAddr).slice(0, 260),
  );
}

// ── P1. 重启后：持久面的运行行参与并发计数 + 精确 id 仍可寻址 ──────────────────
{
  const p1 = await newHarness('parent-p1', capFor({ impl: 1 }));
  p1.host.rows = persistRows([['persisted-impl-1', 'impl/pre-restart work', 'running']]);
  const blocked = await attempt(p1, 'subagent_impl', { description: 'new work after restart' });
  check(
    'P1 重启后运行上限仍生效（空台账 + 持久面已有 1 个 impl 在跑 → 新派发被拒）',
    blocked.ok === false && /stage concurrency limit reached/i.test(blocked.message ?? ''),
    JSON.stringify(blocked).slice(0, 240),
  );
  check('P1 被拒时没有发生创建（宿主创建入口 0 次）', p1.calls.start === 0, 'start ' + p1.calls.start);
  const recovered = await attemptFollowup(p1, 'persisted-impl-1', 'continue the pre-restart work');
  check('P1 精确 id 复用成功（重启后台账为空也能从持久面恢复寻址）',
    recovered.ok === true, JSON.stringify(recovered).slice(0, 260));
  check(
    'P1 消息真的投递到了那个持久面子代理（投递实参 = 该 id）',
    p1.steers.length === 1 && p1.steers[0].childId === 'persisted-impl-1'
      && p1.steers[0].text.startsWith('continue the pre-restart work'),
    JSON.stringify(p1.steers),
  );
  check(
    'P1 回执：recovered=true、stage 由持久面补齐为 impl、childId 命中该行',
    recovered.result?.recovered === true && recovered.result?.stage === 'impl'
      && recovered.result?.childId === 'persisted-impl-1',
    JSON.stringify(recovered.result),
  );
  check(
    'P1 回执不谎报 wallClockRearmed（持久面命中无台账条目 → 本轮没有墙钟）',
    recovered.result?.wallClockRearmed === undefined,
    JSON.stringify(recovered.result),
  );
}

// P1.5 持久面内的阶段别名 / latest / 唯一前缀 / 未命中
{
  const p1b = await newHarness('parent-p1b', capFor({}));
  p1b.host.rows = persistRows([
    ['persisted-impl-a', 'impl/first durable impl'],
    ['persisted-review-a', 'review/durable audit'],
    ['persisted-impl-b', 'impl/second durable impl'],
  ]);
  const byAlias = await attemptFollowup(p1b, 'review', 'round 2 of the durable review');
  check(
    'P1 持久面里的阶段别名可寻址（child:"review"）',
    byAlias.ok === true && byAlias.result?.childId === 'persisted-review-a'
      && byAlias.result?.recovered === true && byAlias.result?.stage === 'review',
    JSON.stringify(byAlias).slice(0, 240),
  );
  const byLatest = await attemptFollowup(p1b, 'latest', 'latest durable target');
  check(
    'P1 持久面里的 latest = 宿主列表最后一行（createdAt 升序 = 最近创建）',
    byLatest.ok === true && byLatest.result?.childId === 'persisted-impl-b' && byLatest.result?.recovered === true,
    JSON.stringify(byLatest).slice(0, 240),
  );
  const byPrefix = await attemptFollowup(p1b, 'persisted-rev', 'addressed by unique prefix');
  check(
    'P1 持久面里的唯一前缀也能命中',
    byPrefix.ok === true && byPrefix.result?.childId === 'persisted-review-a',
    JSON.stringify(byPrefix).slice(0, 240),
  );
  check(
    'P1 三次持久面命中都真的投递到了对应 id',
    p1b.steers.map((row) => row.childId).join(',') === 'persisted-review-a,persisted-impl-b,persisted-review-a',
    JSON.stringify(p1b.steers.map((row) => row.childId)),
  );
  const noMatch = await attemptFollowup(p1b, 'persisted-plan-zzz', 'nothing matches this');
  check(
    'P1 持久面里也没有的 id → 仍报 no match（不得误命中）',
    noMatch.ok === false && /no stage subagent matches/.test(noMatch.message ?? ''),
    JSON.stringify(noMatch).slice(0, 240),
  );
  check(
    'P1 no match 时一次都没有投递',
    p1b.steers.length === 3 && p1b.calls.sendMessageOptions.length === 3,
    'steers ' + p1b.steers.length + ' / sendMessage ' + p1b.calls.sendMessageOptions.length,
  );
}

// ── P2. stageLabel 只认「当前阶段」前缀：别的阶段前缀不得穿透阶段归属 ─────────────
{
  const p2 = await newHarness('parent-p2', capStages(0));
  const dispatchedChild = await runStage(p2, 'subagent_impl', { description: 'plan/auth refactor' });
  const durableRows = await p2.subagents.listChildren(p2.parentId);
  const durableLabel = durableRows.find((row) => row.id === dispatchedChild.subagentId)?.label;
  check(
    'P2 impl 派发传 description "plan/auth refactor" → durable label 仍以 impl/ 开头',
    durableLabel === 'impl/plan/auth refactor',
    String(durableLabel),
  );
  // 「重启」harness：只有这条 durable label 的运行中持久行（id 不在台账里）
  const p2r = await newHarness('parent-p2r', capFor({ impl: 1, plan: 1 }));
  p2r.host.rows = persistRows([['persisted-p2-1', durableLabel, 'running']]);
  const implBlocked = await attempt(p2r, 'subagent_impl', { description: 'impl after restart' });
  check(
    'P2 重启后该运行中的持久行计入 impl（impl 到运行上限被拒）',
    implBlocked.ok === false && /stage concurrency limit reached/i.test(implBlocked.message ?? ''),
    JSON.stringify(implBlocked).slice(0, 260),
  );
  const planOk = await attempt(p2r, 'subagent_plan', { description: 'plan after restart' });
  check('P2 同一个子代理不被计进 plan（plan 不被误拒）', planOk.ok === true, JSON.stringify(planOk).slice(0, 200));
  check('P2 只有 plan 真的被创建（宿主创建入口 1 次，impl 一次都没有）', p2r.calls.start === 1, 'start ' + p2r.calls.start);
  check(
    'P2 plan 自己的 durable label 仍是 plan/ 前缀（两个阶段的 label 不互相污染）',
    p2r.children.get(planOk.result?.subagentId)?.label === 'plan/plan after restart',
    String(p2r.children.get(planOk.result?.subagentId)?.label),
  );
}

// ── P3. 枚举失败/缺失：运行闸门退回本插件账本，绝不卡死或误放行 ─────────────────
{
  // P3.1 枚举抛错 + 空账本 → 按 0 放行（不再有创建闸门的「无法核实」保守拒绝）
  const p3 = await newHarness('parent-p3', capFor({ impl: 1 }));
  p3.host.fail = true;
  const firstWhileFailing = await attempt(p3, 'subagent_impl', { description: 'enumeration failing' });
  check(
    'P3 枚举抛错 + 空账本 + limit=1 → 按账本判定放行',
    firstWhileFailing.ok === true && p3.calls.start === 1,
    JSON.stringify(firstWhileFailing).slice(0, 260) + ' start ' + p3.calls.start,
  );
  const secondWhileFailing = await attempt(p3, 'subagent_impl', { description: 'second while failing' });
  check(
    'P3 枚举抛错但账本有 1 个在跑 → 第 2 个仍被运行上限拦住（读不到不等于没有）',
    secondWhileFailing.ok === false && /stage concurrency limit reached/i.test(secondWhileFailing.message ?? ''),
    JSON.stringify(secondWhileFailing).slice(0, 260),
  );
  p3.host.fail = false;

  // P3.2 枚举成功时，持久面的运行行参与并发计数
  const p3b = await newHarness('parent-p3b', capFor({ impl: 1 }));
  p3b.host.rows = persistRows([['persisted-hw-1', 'impl/high-water row', 'running']]);
  const seesDurable = await attempt(p3b, 'subagent_impl', { description: 'sees the durable row' });
  check(
    'P3 枚举成功时持久面的运行行被计入（新派发被拒）',
    seesDurable.ok === false && /stage concurrency limit reached/i.test(seesDurable.message ?? ''),
    JSON.stringify(seesDurable).slice(0, 220),
  );
  check('P3 该拒绝没有发生创建', p3b.calls.start === 0, 'start ' + p3b.calls.start);

  // P3.3 宿主根本没有 listChildren（永久形状差异）→ 退回台账，不卡死
  const p3d = await newHarness('parent-p3d', capFor({ impl: 1 }));
  delete p3d.subagents.listChildren;
  const noListing = await attempt(p3d, 'subagent_impl', { description: 'host has no listing' });
  check(
    'P3 宿主没有 listChildren（永久形状差异）→ 按台账判定，不被卡死',
    noListing.ok === true,
    JSON.stringify(noListing).slice(0, 240),
  );
  const noListingSecond = await attempt(p3d, 'subagent_impl', { description: 'second with no listing' });
  check(
    'P3 没有 listChildren 时台账仍是权威：第 2 个被运行上限拒绝',
    noListingSecond.ok === false && /stage concurrency limit reached/i.test(noListingSecond.message ?? ''),
    JSON.stringify(noListingSecond).slice(0, 260),
  );
  p3d.emit('subagent/end', { id: noListing.result.subagentId });
  p3d.children.set(noListing.result.subagentId, { activity: 'idle' });
  const noListingThird = await attempt(p3d, 'subagent_impl', { description: 'third with no listing' });
  check(
    'P3 没有 listChildren 时运行名额释放后第 3 个成功（没有创建总量闸门）',
    noListingThird.ok === true && p3d.calls.start === 2,
    JSON.stringify(noListingThird).slice(0, 260) + ' start ' + p3d.calls.start,
  );
}

// ── P4. status 不再对全部 root 做 N+1：只扫组合了本预设的 root ──────────────────
{
  const p4 = await newHarness('parent-p4', capFor({}));
  const foreign = p4.addForeignRoot('foreign-root-p4');
  const rowsByParent = {
    'parent-p4': persistRows([['p4-impl-1', 'impl/in-preset row']]),
    'foreign-root-p4': persistRows([['p4-foreign-impl-1', 'impl/foreign row']]),
  };
  p4.host.rowsFor = (id) => rowsByParent[id] ?? [];
  check(
    'P4 前置：非本预设的 root 确实在 roots() 里，且 composedPreset 与它不同',
    p4.agentsService.roots().length === 2
      && p4.presets.composedPreset(foreign.ctx) === 'standard'
      && p4.presets.composedPreset(p4.parent.ctx) === 'code-pipeline',
  );
  const stages = await statusOfHarness(p4);
  const scanned = [...new Set(p4.host.calls)];
  check('P4 status 仍会扫本预设 root 的持久面（持久面不漏）', p4.host.calls.includes('parent-p4'), JSON.stringify(scanned));
  check(
    'P4 status 不对非本预设的 root 调 listChildren（消除 N+1 的持久 Session-store 读）',
    !p4.host.calls.includes('foreign-root-p4'),
    JSON.stringify(scanned),
  );
  check(
    'P4 本预设 root 的持久行出现在 available 里',
    (stages.impl?.available ?? []).some((row) => row.id === 'p4-impl-1'),
    JSON.stringify(stages.impl?.available),
  );
  check(
    'P4 非本预设 root 的行没有混进 available',
    !(stages.impl?.available ?? []).some((row) => row.id === 'p4-foreign-impl-1'),
    JSON.stringify(stages.impl?.available),
  );
}

// ── P5. 运行上限文案不再说谎：running 与 starting 分开报 ────────────────────────
{
  // P5.1 正常并发拒绝（确有 1 个在跑）
  const p5 = await newHarness('parent-p5', capFor({ impl: 1 }));
  const holder = await attempt(p5, 'subagent_impl', { description: 'occupies the slot' });
  const busy = await attempt(p5, 'subagent_impl', { description: 'second while running' });
  check(
    'P5 正常并发拒绝：前置成立（第 1 个在跑）且第 2 个被拒',
    holder.ok === true && busy.ok === false,
    JSON.stringify([holder.ok, busy.ok]),
  );
  check('P5 正常并发拒绝：文案报出 running 数（N running）', /\b1 running\b/.test(busy.message ?? ''), (busy.message ?? '').slice(0, 200));
  check(
    'P5 正常并发拒绝：仍声明「不是阶段失败」并给复用出路',
    (busy.message ?? '').includes('NOT a stage failure') && (busy.message ?? '').includes('pipeline_followup'),
    (busy.message ?? '').slice(0, 200),
  );
  check(
    'P5 确有在跑时仍引导等 settled notice（在跑的子代理会真的 settle）',
    (busy.message ?? '').includes('Wait for a settled notice'),
    (busy.message ?? '').slice(0, 240),
  );
  check('P5 旧措辞 "are already running" 在并发拒绝文案里不再出现', !(busy.message ?? '').includes('are already running'));

  // P5.2 「0 在跑、1 个创建在途」：用挂起的 listChildren 把第 1 个调用卡在预留窗口
  const p5b = await newHarness('parent-p5b', capFor({ impl: 1 }));
  let releaseHold;
  p5b.host.hold = new Promise((resolve) => { releaseHold = resolve; });
  const parked = runStage(p5b, 'subagent_impl', { description: 'parked in flight' }).then(
    (value) => ({ ok: true, result: value }),
    (error) => ({ ok: false, message: String(error?.message ?? error) }),
  );
  // 等到第 1 个调用**真的**进入预约后的 listChildren 探测（假宿主在 await hold 之前记账）：
  // 固定 sleep 在负载高的机器上可能抢跑，这里轮询到确定性的窗口再发第 2 个。
  for (let waited = 0; waited < 200 && p5b.host.calls.length === 0; waited += 1) await tick(5);
  const starting = await attempt(p5b, 'subagent_impl', { description: 'second while starting' });
  releaseHold();
  p5b.host.hold = null;
  const parkedResult = await parked;
  check(
    'P5 前置：第 1 个调用确实卡在「已预留、尚未创建」窗口（它最终成功）',
    parkedResult.ok === true && p5b.calls.start === 1,
    JSON.stringify(parkedResult).slice(0, 220) + ' start ' + p5b.calls.start,
  );
  check(
    'P5 「0 在跑、1 个创建在途」：文案报 starting（dispatch in flight）而不是谎报 running',
    starting.ok === false && /1 starting \(dispatch in flight\)/.test(starting.message ?? '')
      && !/\d+ running\b/.test(starting.message ?? ''),
    (starting.message ?? '').slice(0, 260),
  );
  check(
    'P5 该文案不再教模型「等 settle 通知」（settle 不会腾出这种名额）',
    !(starting.message ?? '').includes('Wait for a settled notice')
      && (starting.message ?? '').includes('will NOT free one')
      && (starting.message ?? '').includes('LATER step'),
    (starting.message ?? '').slice(0, 340),
  );
  check(
    'P5 该文案仍是策略拒绝：不是阶段失败、带复用出路',
    (starting.message ?? '').includes('NOT a stage failure') && (starting.message ?? '').includes('pipeline_followup'),
    (starting.message ?? '').slice(0, 240),
  );
}

// ── P6. 顺手项：跨父会话精确 id 不得命中；description 参数说明 ──────────────────
{
  const owner = await newHarness('parent-p6-owner', capStages(0));
  const foreignChild = await runStage(owner, 'subagent_impl', { description: 'owned by another session' });
  const other = await newHarness('parent-p6-other', capStages(0));
  const beforeSend = other.calls.sendMessageOptions.length;
  const cross = await attemptFollowup(other, foreignChild.subagentId, 'steal this child');
  check(
    'P6 跨父会话精确 id 被拒（不得把消息投给别的会话的子代理）',
    cross.ok === false && /no stage subagent matches/.test(cross.message ?? ''),
    JSON.stringify(cross).slice(0, 240),
  );
  check(
    'P6 跨父会话精确 id：一次都没有投递',
    other.steers.length === 0 && other.calls.sendMessageOptions.length === beforeSend,
    'steers ' + other.steers.length + ' / sendMessage ' + (other.calls.sendMessageOptions.length - beforeSend),
  );
  check(
    'P6 前置：那个 id 确实属于另一个父会话（本会话的台账与持久面都为空）',
    owner.children.has(foreignChild.subagentId) && other.children.size === 0,
  );
  check(
    'P6 description 参数说明仍在（子代理显示名，非对话内容）',
    String(h.tools.get('subagent_impl')?.parameters?.properties?.description?.description ?? '')
      .includes("label shown as this subagent's name"),
    String(h.tools.get('subagent_impl')?.parameters?.properties?.description?.description ?? '').slice(0, 80),
  );
}


// ── H. 结构化 I/O（阶段回执 envelope / pipeline_result / 解析后语义校验）────────
// 阶段子代理把结论作为结构化对象交回来：最终回复里的一个 json 围栏，插件在
// subagent/end 解析并做**语义校验**，主代理用 pipeline_result 读回。
// （0.3.1 曾用注入的 pipeline_submit 做"调用点校验"，因宿主 tools.restrict 只认全局
//  注册的工具名，导致 plan/review 的派发全部抛 unknown global tool 而失败；H3 就是
//  那次的回归防线：只读白名单里不得再出现插件私有工具名。）
{
  const FENCE = String.fromCharCode(96, 96, 96);
  const pluginSource = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  const roStart = pluginSource.indexOf('const READ_ONLY_TOOLS');
  const roBlock = pluginSource.slice(roStart, pluginSource.indexOf('];', roStart));
  check(
    'H3 只读白名单只含宿主全局工具（不得再出现 pipeline_submit 这类插件私有名）',
    roStart > 0 && !roBlock.includes('pipeline_submit') && !roBlock.includes('subagent_'),
    roBlock.replace(/\s+/g, ' ').slice(0, 220),
  );
  check('H1 主代理侧注册了 pipeline_result（阶段工具之外的第 5 个）', typeof h.tools.get('pipeline_result')?.execute === 'function');

  const iso = await newHarness('parent-iso-1', capStages(0));
  const dImpl = await attempt(iso, 'subagent_impl', { description: 'iso work' });
  const empty = await attemptTool(iso.tools.get('pipeline_result'), { child: 'impl' }, iso.parent);
  check(
    'H2 没有回执时 pipeline_result 如实返回 parsed:false + reason（不编造）',
    empty.ok === true && empty.result?.parsed === false && typeof empty.result?.reason === 'string',
    JSON.stringify(empty).slice(0, 180),
  );

  const emitEnd = (harness, childId, obj) => harness.emit('subagent/end', {
    id: childId,
    lastAssistantMessage: [{ type: 'text', text: ['work done', '', FENCE + 'json', JSON.stringify(obj), FENCE].join('\n') }],
  });
  const readImpl = (harness) => attemptTool(harness.tools.get('pipeline_result'), { child: 'impl' }, harness.parent);

  emitEnd(iso, dImpl.result?.subagentId, { kind: 'impl', summary: 'via fence', files: [{ path: 'a.ts', change: 'edited' }] });
  const okRead = await readImpl(iso);
  check(
    'H4 合法 envelope：parsed=true / source=parsed / value 完整 / 无 validationProblems',
    okRead.result?.parsed === true && okRead.result?.source === 'parsed' && okRead.result?.value?.summary === 'via fence'
      && okRead.result?.validationProblems === undefined,
    JSON.stringify(okRead).slice(0, 220),
  );

  // review 的三条硬约束在解析后仍然执行（reviewer persona 的承诺 -> 插件校验）。
  const dReview = await attempt(iso, 'subagent_review', { description: 'iso review', diff: '@@ -1 +1 @@\\n-a\\n+b' });
  const reviewId = dReview.result?.subagentId;
  const readReview = () => attemptTool(iso.tools.get('pipeline_result'), { child: 'review' }, iso.parent);
  const problemsOf = (result) => Array.isArray(result?.validationProblems) ? result.validationProblems.join(' ') : '';

  emitEnd(iso, reviewId, { kind: 'review', verdict: 'request_changes', issues: [{ id: 'R1', severity: 'high', blocking: true, category: 'correctness', problem: 'x' }] });
  let rr = await readReview();
  check('H5 blocking 却没有 failureScenario → 记入 validationProblems（不阻塞，交编排者）', rr.result?.parsed === true && problemsOf(rr.result).includes('failureScenario'), JSON.stringify(rr.result?.validationProblems));

  iso.emit('subagent/start', { id: reviewId });
  emitEnd(iso, reviewId, { kind: 'review', verdict: 'request_changes', issues: [{ id: 'R2', severity: 'high', blocking: true, category: 'docs', problem: 'doc gap', failureScenario: 'x', onChangedLines: true }] });
  rr = await readReview();
  check('H5 docs 类问题标 blocking → 记入 validationProblems', problemsOf(rr.result).includes('docs/style'), JSON.stringify(rr.result?.validationProblems));

  iso.emit('subagent/start', { id: reviewId });
  emitEnd(iso, reviewId, { kind: 'review', verdict: 'approve', issues: [{ id: 'R3', severity: 'critical', blocking: true, category: 'correctness', problem: 'x', failureScenario: 'y', onChangedLines: true }] });
  rr = await readReview();
  check('H5 有 blocking 却报 approve → 记入 verdict 不一致', problemsOf(rr.result).includes('request_changes'), JSON.stringify(rr.result?.validationProblems));

  iso.emit('subagent/start', { id: reviewId });
  emitEnd(iso, reviewId, { kind: 'review', verdict: 'request_changes', blockingCount: 1, issues: [{ id: 'R4', severity: 'high', blocking: true, category: 'correctness', problem: 'null deref', failureScenario: 'empty list', onChangedLines: true }, { id: 'R5', severity: 'low', blocking: false, category: 'docs', problem: 'typo' }] });
  rr = await readReview();
  check('H5 合法 review envelope：解析成功且无 validationProblems', rr.result?.parsed === true && rr.result?.validationProblems === undefined && rr.result?.value?.verdict === 'request_changes', JSON.stringify(rr).slice(0, 200));

  // 无关的 json（没有 kind）不得被误当成"提交了非法回执"。
  const iso2 = await newHarness('parent-iso-2', capStages(0));
  const dProse = await attempt(iso2, 'subagent_impl', { description: 'prose only' });
  iso2.emit('subagent/end', { id: dProse.result?.subagentId, lastAssistantMessage: [{ type: 'text', text: 'see the sample\n' + FENCE + 'json\n{"foo":1}\n' + FENCE }] });
  const notEnv = await attemptTool(iso2.tools.get('pipeline_result'), { child: 'impl' }, iso2.parent);
  check('H6 有 json 但不是 envelope（无 kind）→ parsed:false，不误判为非法回执', notEnv.result?.parsed === false && String(notEnv.result?.reason).includes('no stage envelope'), JSON.stringify(notEnv.result).slice(0, 200));
  iso2.emit('subagent/start', { id: dProse.result?.subagentId });
  iso2.emit('subagent/end', { id: dProse.result?.subagentId, lastAssistantMessage: [{ type: 'text', text: 'just prose, no fence' }] });
  const noFence = await attemptTool(iso2.tools.get('pipeline_result'), { child: 'impl' }, iso2.parent);
  check('H6 没有围栏时 parsed:false + reason（解析失败不阻塞、不编造）', noFence.result?.parsed === false && typeof noFence.result?.reason === 'string', JSON.stringify(noFence.result).slice(0, 160));

  // 新一轮激活作废上一轮回执：复用被唤醒的评审子代理必须给出新 verdict。
  const iso3 = await newHarness('parent-iso-3', capStages(0));
  const d3 = await attempt(iso3, 'subagent_impl', { description: 'rounds' });
  const id3 = d3.result?.subagentId;
  const endWith = (summary) => iso3.emit('subagent/end', { id: id3, lastAssistantMessage: [{ type: 'text', text: FENCE + 'json\n' + JSON.stringify({ kind: 'impl', summary }) + '\n' + FENCE }] });
  const read3 = () => attemptTool(iso3.tools.get('pipeline_result'), { child: 'impl' }, iso3.parent);
  endWith('round 1');
  const round1 = await read3();
  iso3.emit('subagent/start', { id: id3 });
  const cleared = await read3();
  endWith('round 2');
  const round2 = await read3();
  check(
    'H7 新一轮激活作废上一轮回执，且能读到新回执（不返回陈旧 verdict）',
    round1.result?.value?.summary === 'round 1' && cleared.result?.parsed === false && round2.result?.value?.summary === 'round 2',
    JSON.stringify({ r1: round1.result?.value?.summary, cleared: cleared.result?.parsed, r2: round2.result?.value?.summary }),
  );

  // 结构化投递：主代理把 triage 后的 issue 数组原样交给 impl，不必手抄。
  const iso4 = await newHarness('parent-iso-4', capStages(0));
  const dFollow = await attempt(iso4, 'subagent_impl', { description: 'structured followup' });
  const delivered = await attemptTool(
    iso4.tools.get('pipeline_followup'),
    { child: dFollow.result?.subagentId, files: 'packages/plugin-api/src/engine.ts', issues: [{ id: 'R9', severity: 'high', blocking: true, category: 'correctness', problem: 'boom', failureScenario: 'empty input', suggestedFix: 'guard the empty case' }] },
    iso4.parent,
  );
  const steered = iso4.steers[iso4.steers.length - 1]?.text ?? '';
  check('H8 pipeline_followup 接受 issues[]（无需 message）并渲染进投递文本', delivered.ok === true && steered.includes('TRIAGED ISSUES') && steered.includes('[R9]') && steered.includes('boom'), steered.slice(0, 220));
  check('H8 渲染带 failureScenario / suggestedFix，主代理无需手抄', steered.includes('failure scenario: empty input') && steered.includes('suggested fix: guard the empty case'), steered.slice(0, 260));
  check('H9 followup 的 files 渲染成与阶段派发同一段「一个程序先读完」硬指令', steered.includes('ONE run_code program') && steered.includes('packages/plugin-api/src/engine.ts'), steered.slice(0, 260));
  check('H9 impl 子代理的 persona 带批量纪律（BATCH THE LOOP）', String(iso4.calls.startPersonas.at(-1) ?? '').includes('BATCH THE LOOP'), String(iso4.calls.startPersonas.at(-1) ?? '').slice(0, 120));
  const noFiles = await attemptTool(iso4.tools.get('pipeline_followup'), { child: dFollow.result?.subagentId, message: 'no files here' }, iso4.parent);
  check('H9 缺 files 的 followup 被拒且错误点名 files', noFiles.ok === false && String(noFiles.message).includes('"files" is required'), String(noFiles.message).slice(0, 200));
  const both = await attemptTool(iso4.tools.get('pipeline_followup'), { child: dFollow.result?.subagentId, message: 'Round 2: fix only these.', files: '-', issues: [{ id: 'R10', severity: 'high', blocking: true, category: 'correctness', problem: 'x', failureScenario: 'y', onChangedLines: true }] }, iso4.parent);
  check('H8 message 与 issues 可并存（message 作为指令正文在前）', both.ok === true && String(iso4.steers[iso4.steers.length - 1]?.text ?? '').startsWith('Round 2: fix only these.'), String(iso4.steers[iso4.steers.length - 1]?.text ?? '').slice(0, 160));
}


// ── I. 读卫生：同一文件跨步骤重复读时的 plugin 提醒（tools/post-execute）────────
{
  const hi = await newHarness('read-hygiene', capStages(0));
  const postExecute = (hi.handlers.get('tools/post-execute') ?? []).at(-1);
  const downstream = async () => ({ kind: 'accept' });
  const reader = { id: 'read-hygiene-agent' };
  // 嵌套 read（run_code 内部）：rootCallId 指外层调用，callId 是自己的 → 提醒攒到程序结束。
  const nested = (programId, name, args, result = {}) => postExecute({ agent: reader, rootCallId: programId, callId: programId + ':ptc:1', name, arguments: args }, result, downstream);
  // root 调用（外层 run_code 收尾，或主会话里的顶层调用）：rootCallId 与 callId 相同。
  const root = (id, name, args) => postExecute({ agent: reader, rootCallId: id, callId: id, name, arguments: args }, {}, downstream);
  const texts = (out) => (out?.additionalContexts ?? []).map((message) => String(message.content?.[0]?.text ?? ''));
  const rootRun = (programId) => root(programId, 'run_code', {});
  check('I1 读卫生监听器已注册', typeof postExecute === 'function');
  // 同一 run_code 程序里的两次读 = 我们要鼓励的批量化，不提醒。
  await nested('prog-batch', 'read', { file_path: '/tmp/rh0.js', offset: 1, limit: 100 });
  await nested('prog-batch', 'read', { file_path: '/tmp/rh0.js', offset: 101, limit: 100 });
  check('I2 同一程序内的重复读不提醒（那正是批量化）', texts(await rootRun('prog-batch')).length === 0);
  // 跨步骤、且被另一个文件的读隔开 —— 0.3.3 漏掉的正是这种。
  await nested('prog-1', 'read', { file_path: '/tmp/rh.js', offset: 1, limit: 100 });
  await nested('prog-2', 'read', { file_path: '/tmp/other.js', offset: 1, limit: 100 });
  await nested('prog-3', 'read', { file_path: '/tmp/rh.js', offset: 101, limit: 100 });
  const chunked = await rootRun('prog-3');
  check(
    'I3 跨步骤同文件重复读 → 提醒（被其它文件隔开也算；程序结束才发）',
    chunked?.additionalContexts?.length === 1
      && chunked.additionalContexts[0].source?.kind === 'plugin'
      && chunked.additionalContexts[0].role === 'user'
      && String(chunked.additionalContexts[0].content?.[0]?.text ?? '').includes('read-hygiene'),
    JSON.stringify(chunked?.additionalContexts ?? []).slice(0, 200),
  );
  await nested('prog-4', 'read', { file_path: '/tmp/rh.js', offset: 201, limit: 100 });
  check('I4 同一文件只提醒一次', texts(await rootRun('prog-4')).length === 0);
  // 满窗、不重叠 = 文件超过工具上限时的被迫分块，不提醒。
  await nested('prog-5', 'read', { file_path: '/tmp/rh2.js', offset: 1, limit: 2000 });
  await nested('prog-6', 'read', { file_path: '/tmp/rh2.js', offset: 2001, limit: 2000 });
  check('I5 满窗且不重叠的被迫分块不提醒', texts(await rootRun('prog-6')).length === 0);
  // 整文件重读（窗口重叠）→ 提醒。
  await nested('prog-7', 'read', { file_path: '/tmp/rh3.js', offset: 1, limit: 3000 });
  await nested('prog-8', 'read', { file_path: '/tmp/rh3.js', offset: 1, limit: 2000 });
  check('I6 整文件重读（窗口重叠）→ 提醒', (await rootRun('prog-8'))?.additionalContexts?.length === 1);
  await nested('prog-9', 'grep', { pattern: 'x' });
  check('I7 非 read 工具不触发', texts(await rootRun('prog-9')).length === 0);
  // 0.3.7 的两个真实事故：失败的 read 被当成「已经读过」，以及一次程序里刷出 23 条提醒。
  await nested('prog-f1', 'read', { file_path: '/tmp/rh-fail.js', offset: 1, limit: 2500 }, { isError: true });
  await nested('prog-f2', 'read', { file_path: '/tmp/rh-fail.js', offset: 1, limit: 2000 });
  const afterFail = texts(await rootRun('prog-f2'));
  check('I8 失败的 read 不计入历史（limit 超限后重试不触发假警报）', afterFail.length === 0, JSON.stringify(afterFail).slice(0, 200));
  for (let index = 0; index < 23; index += 1) await nested('prog-seed', 'read', { file_path: '/tmp/bulk-' + index + '.js', offset: 1, limit: 2000 });
  for (let index = 0; index < 23; index += 1) await nested('prog-storm', 'read', { file_path: '/tmp/bulk-' + index + '.js', offset: 1, limit: 2000 });
  const storm = await rootRun('prog-storm');
  check(
    'I9 一次程序重读 23 个文件 → 只发一条汇总（不是 23 条 user 消息）',
    storm?.additionalContexts?.length === 1 && String(storm.additionalContexts[0].content?.[0]?.text ?? '').includes('re-read 23 file(s)'),
    JSON.stringify(texts(storm).map((text) => text.slice(0, 120))),
  );
  check('I9 汇总里最多列 8 个路径，其余折成计数（不让提醒本身变成洪水）', String(storm?.additionalContexts?.[0]?.content?.[0]?.text ?? '').includes('more)'), String(storm?.additionalContexts?.[0]?.content?.[0]?.text ?? '').slice(0, 200));
  // 主会话的 root 级 read（没有 run_code 包裹）仍然当场发单文件提醒。
  await root('root-r1', 'read', { file_path: '/tmp/root.js', offset: 1, limit: 100 });
  const rootNotice = await root('root-r2', 'read', { file_path: '/tmp/root.js', offset: 50, limit: 100 });
  check(
    'I10 root 级 read（主会话）当场发单文件提醒，措辞仍是 This is read #N',
    rootNotice?.additionalContexts?.length === 1 && String(rootNotice.additionalContexts[0].content?.[0]?.text ?? '').includes('This is read #2'),
    JSON.stringify(texts(rootNotice)),
  );
}

// ── J. files 清单：入参 schema + 派发时的「先批量读完」硬指令 ──────────────────
{
  const { readFileSync } = await import('node:fs');
  const hj = await newHarness('files-plumbing', capStages(0));
  const planDef = hj.tools.get('subagent_plan');
  check('J1 subagent_plan 的入参 schema 暴露 files 字段', 'files' in (planDef?.parameters?.properties ?? {}), Object.keys(planDef?.parameters?.properties ?? {}).join(','));
  const dispatch = await attempt(hj, 'subagent_plan', { prompt: 'Plan the change.', files: 'packages/plugin-api/src/context.ts\napps/desktop/src/shared/ipc-contract.ts' });
  check('J2 带 files 的派发成功', dispatch.ok === true, JSON.stringify(dispatch).slice(0, 160));
  let childPrompt = String(hj.calls.startPrompts.at(-1) ?? '');
  if (!childPrompt.includes('**files**')) {
    const m = childPrompt.match(/written to temp file: (\S+)/);
    if (m) { try { childPrompt = readFileSync(m[1], 'utf8'); } catch {} }
  }
  check(
    'J3 files 渲染成「一个程序先读完」硬指令 + 原样清单',
    childPrompt.includes('ONE run_code program')
      && childPrompt.includes('packages/plugin-api/src/context.ts')
      && childPrompt.includes('apps/desktop/src/shared/ipc-contract.ts'),
    childPrompt.slice(Math.max(0, childPrompt.indexOf('**files**')), childPrompt.indexOf('**files**') + 240),
  );
  // 0.3.7：清单渲染里带上两个真实踩过的坑（read 的 limit 上限、undefined 值键）。
  check(
    'J4 files 指令带上两个已知坑：read 的 limit 上限 与 undefined 值键',
    childPrompt.includes('OMITTING `limit`') && childPrompt.includes('non-lossless JSON'),
    childPrompt.slice(-240),
  );
}

// ── K. files 必填：缺省拒绝、显式 "-" 允许 ──────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const hk = await newHarness('files-required', capStages(0));
  const missing = await attemptTool(hk.tools.get('subagent_plan'), { prompt: 'Plan the change.' }, hk.parent);
  check('K1 缺 files → 派发被拒且错误点名 files', missing.ok === false && String(missing.message).includes('\"files\" is required'), String(missing.message).slice(0, 170));
  const declaredNone = await attempt(hk, 'subagent_plan', { prompt: 'Plan the change.', files: '-' });
  let kPrompt = String(hk.calls.startPrompts.at(-1) ?? '');
  if (!kPrompt.includes('**files**')) {
    const m = kPrompt.match(/written to temp file: (\S+)/);
    if (m) { try { kPrompt = readFileSync(m[1], 'utf8'); } catch {} }
  }
  check('K2 files "-" → 允许，且子代理收到「自己做侦察」指令', declaredNone.ok === true && kPrompt.includes('NO candidate list'), JSON.stringify({ ok: declaredNone.ok, snippet: kPrompt.slice(0, 130) }));
}

// ── M. 0.4.0：plan 不再携带并行预算（新工作流一律新派，plan 不必迁就并发上限）──
{
  const { readFileSync } = await import('node:fs');
  const promptOf = (harness) => {
    let text = String(harness.calls.startPrompts.at(-1) ?? '');
    if (!text.includes('**files**')) {
      const m = text.match(/written to temp file: (\S+)/);
      if (m) { try { text = readFileSync(m[1], 'utf8'); } catch {} }
    }
    return text;
  };
  const planner = await newHarness('plan-no-budget', capStages(2));
  await attempt(planner, 'subagent_plan', { description: 'no budget' });
  const planPrompt = promptOf(planner);
  check(
    'M1 plan 派发不再携带 parallelismBudget（仍带 files 清单指令）',
    !planPrompt.includes('parallelismBudget') && planPrompt.includes('**files**'),
    planPrompt.slice(0, 220),
  );
  const implementer = await newHarness('impl-no-budget', capStages(1));
  await attempt(implementer, 'subagent_impl', { description: 'no budget' });
  check('M2 impl 派发也没有 parallelismBudget', !promptOf(implementer).includes('parallelismBudget'), promptOf(implementer).slice(0, 160));
}

check(
  '假 ctx 全程按宿主契约校验实参形状（startContinuable / prompt / sendMessage 均带 signal）',
  h.calls.startSignals.length > 0
    && h.calls.promptSignals.length > 0
    && h.calls.sendMessageOptions.length > 0,
  JSON.stringify({ start: h.calls.startSignals.length, prompt: h.calls.promptSignals.length, sendMessage: h.calls.sendMessageOptions.length }),
);

console.log('');
console.log(checks + ' checks, ' + failures.length + ' failure(s)');
if (failures.length > 0) {
  for (const failure of failures) console.log('  - ' + failure);
  process.exitCode = 1;
}
