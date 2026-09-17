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
  const calls = { prompt: 0, promptPayloads: [], promptSignals: [], startSignals: [], sendMessageOptions: [], rejectDelivery: false, rejectKnownShapes: false, rewriteBadPayloadMessage: false,
    // 创建上限 / 压缩顺序断言的记账：
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
    ctx, parent, settings, tools, routes, warnings, interrupts, queued, steers, children,
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
  { prompt: 'do the thing', ...args },
  { agent: h.parent, signal: new AbortController().signal },
);
const statusOf = async () => {
  const { res, captured } = captureResponse();
  await h.routes.get('/dsh-code-pipeline/status')({}, res);
  return JSON.parse(captured.body).stages;
};
const allStages = (minutes) => ({ plan: { budgetMinutes: minutes }, impl: { budgetMinutes: minutes }, review: { budgetMinutes: minutes } });
const followup = (child, message) => h.tools.get('pipeline_followup').execute(
  { child, message },
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
  const run = (child, message) => followup.execute({ child, message }, { agent: h.parent, signal: new AbortController().signal });

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
      && payload?.content?.[0]?.text === 'queued requirement change',
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
// 创建数量硬上限 + 压缩后复用 + 别名稳定（机制回归基线）
// ════════════════════════════════════════════════════════════════════════════
// 与上面的墙钟场景刻意隔离：创建数量台账是模块级、按父会话隔离、且**只增不减**的，
// 因此每个新场景都用独立 parentId 的假 ctx（台账互不可见），childId 也全局唯一。

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
  { prompt: 'do the thing', ...args },
  { agent: harness.parent, signal: new AbortController().signal },
);
const runFollowup = (harness, child, message, compact) => harness.tools.get('pipeline_followup').execute(
  compact === true ? { child, message, compact: true } : { child, message },
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

// ── A. 创建数量硬闸门（上限复用 maxConcurrency；数的是「已创建」而不是「在跑」）──
{
  const cap = await newHarness('parent-cap-1', capStages(1));
  const first = await attempt(cap, 'subagent_impl', { description: 'cap test one' });
  const firstId = first.result?.subagentId;
  const firstLabel = 'impl/cap test one';
  check(
    'A1 创建上限=1：第 1 个同阶段派发成功并返回 durable subagentId',
    first.ok === true && first.result?.kind === 'continuable' && typeof firstId === 'string',
    JSON.stringify(first).slice(0, 200),
  );
  const second = await attempt(cap, 'subagent_impl', { description: 'cap test two' });
  check('A1 创建上限=1：第 2 个同阶段派发必抛（是硬闸门，不是劝说）', second.ok === false, JSON.stringify(second).slice(0, 200));
  check('A1 宿主的创建入口 startContinuable 只被调用 1 次（证明是代码拦下的）', cap.calls.start === 1, 'start ' + cap.calls.start);
  // 第 2 次派发时第 1 个还在跑：先撞上的是「运行上限」闸门（两道闸门同级，先运行后创建）。
  // 它同样是策略拒绝而不是阶段不可用，且必须带复用出路（否则主代理会终止整个任务）。
  check(
    'A1 第 2 次派发被运行上限闸门拦下（stage concurrency limit reached，实际措辞）',
    /stage concurrency limit reached/i.test(second.message ?? ''),
    (second.message ?? '').slice(0, 160),
  );
  check(
    'A1 运行上限拒绝文案明确「不是阶段失败、不要停任务」且不带 UNAVAILABLE 指引横幅',
    (second.message ?? '').includes('NOT a stage failure')
      && !(second.message ?? '').includes('Pipeline stage UNAVAILABLE'),
    (second.message ?? '').slice(0, 200),
  );

  // 结束第 1 个（subagent/end 撤销运行账本 + 宿主行改 inactive，running 归零）后仍被拒：
  // 这一次运行闸门放行，撞上的是**创建上限**闸门 —— 它数的才是「已创建」。
  cap.emit('subagent/end', { id: firstId });
  cap.children.set(firstId, { activity: 'idle', label: firstLabel });
  const third = await attempt(cap, 'subagent_impl', { description: 'cap test three' });
  const creationMessage = third.message ?? '';
  check(
    'A3 子代理结束、running 归零后第 3 次派发仍被拒（数的是「已创建」而不是「在跑」）',
    third.ok === false,
    JSON.stringify(third).slice(0, 200),
  );
  check(
    'A3 这次撞上的是创建上限闸门（实际措辞：stage CREATION limit reached）',
    /stage CREATION limit reached/i.test(creationMessage),
    creationMessage.slice(0, 160),
  );
  check('A3 创建上限文案说明「等 settle 不腾名额、只有复用才行」', creationMessage.includes('does NOT free a slot'), creationMessage.slice(0, 300));
  check('A3 宿主的创建入口依旧只被调用 1 次（第 3 次没有真的创建）', cap.calls.start === 1, 'start ' + cap.calls.start);

  // A2 文案契约：作用在「创建上限」那条错误上 —— 只有它携带可复用清单与复用出路。
  check('A2 创建上限文案带第 1 个子代理的 id', creationMessage.includes(firstId), firstId);
  check('A2 创建上限文案带它的 label（含阶段前缀）', creationMessage.includes(firstLabel), firstLabel);
  check('A2 创建上限文案给出 pipeline_followup 复用出路', creationMessage.includes('pipeline_followup'));
  check(
    'A2 创建上限文案不再把 compact: true 当出路，而是「压缩不掉 → 接受干扰 / 有名额才新派」',
    creationMessage.includes('you cannot compact it away')
      && creationMessage.includes('only while this session still has a creation slot')
      && !creationMessage.includes('compact: true'),
    creationMessage.slice(0, 320),
  );
  check(
    'A2 创建上限文案列出的可复用清单带 id + label + 活动状态',
    creationMessage.includes(firstId + '  "' + firstLabel + '"') && (creationMessage.includes('[running]') || creationMessage.includes('[inactive]')),
    creationMessage.slice(0, 400),
  );
  check(
    'A2 创建上限文案不带 UNAVAILABLE 指引横幅（UNAVAILABLE 只以「不要报它」的否定形式出现）',
    !creationMessage.includes('Pipeline stage UNAVAILABLE') && !creationMessage.includes('STOP and report to the user'),
    creationMessage.slice(0, 160),
  );
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
    'A5 被拒的两个都是阶段上限拒绝（运行上限或创建上限），不是别的失败',
    refused.length === 2 && refused.every((row) => /concurrency limit reached|CREATION limit reached/.test(row.message ?? '')),
    JSON.stringify(refused.map((row) => (row.message ?? '').slice(0, 90))),
  );
}

// A6 重启持久面：只靠宿主 listChildren 里带阶段前缀 label 的行也能判定已达上限
{
  const persist = await newHarness('parent-persist', capStages(1));
  persist.children.set('orphan-impl-1', { activity: 'inactive', label: 'impl/orphan from a previous process' });
  const blocked = await attempt(persist, 'subagent_impl', { description: 'after restart' });
  check(
    'A6 台账里没有、仅靠宿主持久行的 <stage>/ 前缀 label 就让 impl 判定已达上限并被拒',
    blocked.ok === false && /stage CREATION limit reached/i.test(blocked.message ?? ''),
    JSON.stringify(blocked).slice(0, 220),
  );
  check('A6 拒绝文案把这条持久行列为可复用（id + 持久 label）',
    (blocked.message ?? '').includes('orphan-impl-1') && (blocked.message ?? '').includes('impl/orphan from a previous process'));
  check('A6 该路径没有调用宿主创建入口', persist.calls.start === 0, 'start ' + persist.calls.start);
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
    'A6 归属优先级：活 agent 的 options.stageKey 也能识别阶段（label 无前缀照样计数）',
    warmBlocked.ok === false && (warmBlocked.message ?? '').includes('warm-impl-1'),
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
    'D15 三条阶段描述都写明创建上限 + compact 对已 settle 子代理不可用 + pipeline_followup',
    stageKeys.every((key) => {
      const text = String(h.tools.get('subagent_' + key)?.description ?? '');
      return text.includes('CREATION CAP') && text.includes('compact: true cannot be applied to a settled (cold) child') && text.includes('pipeline_followup');
    }),
    JSON.stringify(stageKeys.map((key) => String(h.tools.get('subagent_' + key)?.description ?? '').includes('CREATION CAP'))),
  );
  check(
    'D15 三条阶段描述都说明「settle 不腾创建名额」',
    stageKeys.every((key) => String(h.tools.get('subagent_' + key)?.description ?? '').includes('does NOT free a creation slot')),
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
// 与前面所有场景同样按 parentId 隔离（模块级台账 + createdObservation 高水位都是
// 按父会话分键的），每个 harness 实例各自持有一份可控的宿主持久面（harness.host）。

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
/** 从「创建上限拒绝」文案里抽出可复用清单的 id（走文案而不是硬编码常量）。 */
const listedIds = (message) => [...String(message ?? '').matchAll(/- (\S+)\s+"[^"]*"\s+\[(?:running|inactive)\]/g)].map((match) => match[1]);

// ── F1. 无阶段归属的旧子代理（0.2.0 之前创建：label 无 `<stage>/` 前缀、非 live、台账空）──
// 修前 `mergeStageRows` 只在 `row.stage !== undefined` 时才比较阶段，于是归属 undefined 的行会
// **漏进每一个阶段桶**：用户实测 10 个旧子代理把 plan 桶顶到 limit 之上（他只创建过 1 个规划
// 子代理就被拒），同时它们又进不了可复用清单（`resolveFollowupTarget` 只认有归属的行）
// ⇒ 既不能复用也不能新建 = 阶段卡死。修复后它们必须被**排除在所有阶段桶之外**。
{
  const f1 = await newHarness('parent-f1', capFor({ plan: 1, impl: 1, review: 1 }));
  f1.host.rows = persistRows([
    ['legacy-1', 'W1 infra scaffold'],
    ['legacy-2', 'review A'],
    ['legacy-3', 'plan frontend scaffold'],
  ]);
  // 注意：不能用 status 断言——它是跨父会话的**全局聚合**，会被同进程其它 harness 的子代理污染。
  // 这里用行为式断言，天然按父会话隔离。
  const allowed = await attempt(f1, 'subagent_impl', { description: 'fresh work beside the legacy children' });
  check(
    'F1 无归属的旧子代理不计入创建数：cap=1 仍能新派第一个（修前会被这 3 行误判成「已创建 3」而拒）',
    allowed.ok === true,
    JSON.stringify(allowed).slice(0, 260),
  );
  // 必须先让第 1 个结束（同 A3）：否则拦下第 2 次派发的是**运行**闸门——它和第 1 个
  // 是否被「创建」计数毫无关系，断言就失去了对"计数是 1 而不是 1+3"的鉴别力（停掉创建
  // 计数台账它照样绿）。结束之后运行闸门放行，撞上的才是**创建**闸门，而它的文案自带
  // 可复用清单，能同时钉住"这个真实子代理确实被计数"。
  const firstId = allowed.result?.subagentId;
  f1.emit('subagent/end', { id: firstId });
  const second = await attempt(f1, 'subagent_impl', { description: 'second impl for the same parent' });
  check(
    'F1 但真实创建仍被计数：第 1 个结束后第 2 个 impl 仍被创建闸门拒绝（证明计数是 1 而不是 1+3）',
    second.ok === false
      && /stage CREATION limit reached/i.test(second.message ?? '')
      && (second.message ?? '').includes(String(firstId)),
    JSON.stringify(second).slice(0, 260),
  );
  const noAddr = await attemptFollowup(f1, 'legacy-1', 'continue the legacy child');
  check(
    'F1 边界保持不变：无归属的旧子代理仍不可寻址（本次不做该增强，属已知边界）',
    noAddr.ok === false && /no stage subagent matches/i.test(noAddr.message ?? ''),
    JSON.stringify(noAddr).slice(0, 260),
  );
}

// ── P1. 重启后寻址：上限看得见 + 寻址也看得见（修前：不能复用也不能新建 = 阶段卡死）──
{
  const p1 = await newHarness('parent-p1', capFor({ impl: 1 }));
  p1.host.rows = persistRows([['persisted-impl-1', 'impl/pre-restart work']]);
  const blocked = await attempt(p1, 'subagent_impl', { description: 'new work after restart' });
  check(
    'P1 重启后创建上限仍生效（空台账 + 持久面已有 1 个 impl → 新派发被拒）',
    blocked.ok === false && /stage CREATION limit reached/i.test(blocked.message ?? ''),
    JSON.stringify(blocked).slice(0, 240),
  );
  check('P1 被拒时没有发生创建（宿主创建入口 0 次）', p1.calls.start === 0, 'start ' + p1.calls.start);
  const listed = listedIds(blocked.message);
  check('P1 拒绝文案给出的可复用 id 就是持久面那一行', listed.includes('persisted-impl-1'), JSON.stringify(listed));
  // 端到端一环：把拒绝文案里给出的 id 原样拿去做 followup —— 修前这里报 no stage subagent matches。
  const recovered = await attemptFollowup(p1, listed[0], 'continue the pre-restart work');
  check('P1 用拒绝文案里的 id 复用成功（修前：no match → 既不能复用也不能新建 = 卡死）',
    recovered.ok === true, JSON.stringify(recovered).slice(0, 260));
  check(
    'P1 消息真的投递到了那个持久面子代理（投递实参 = 该 id）',
    p1.steers.length === 1 && p1.steers[0].childId === 'persisted-impl-1'
      && p1.steers[0].text === 'continue the pre-restart work',
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
  // 「重启」harness：只有这条 durable label 的持久行（id 用持久面合成 id，不在台账里）
  const p2r = await newHarness('parent-p2r', capFor({ impl: 1, plan: 1 }));
  p2r.host.rows = persistRows([['persisted-p2-1', durableLabel]]);
  const implBlocked = await attempt(p2r, 'subagent_impl', { description: 'impl after restart' });
  check(
    'P2 重启后该子代理计入 impl（impl 到顶被拒，文案列出它）',
    implBlocked.ok === false && /stage CREATION limit reached/i.test(implBlocked.message ?? '')
      && (implBlocked.message ?? '').includes('persisted-p2-1'),
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

// ── P3. 枚举瞬时失败：不得按「持久面为空」放行；区分瞬时失败与宿主没有该能力 ─────────
{
  // P3.1 枚举抛错 + 空台账 + limit=1 → 必须被拒
  const p3 = await newHarness('parent-p3', capFor({ impl: 1 }));
  p3.host.fail = true;
  const unverifiable = await attempt(p3, 'subagent_impl', { description: 'enumeration failing' });
  check(
    'P3 枚举瞬时抛错 + 空台账 + limit=1 → 派发被拒（不得整体旁路创建上限）',
    unverifiable.ok === false && /CANNOT BE VERIFIED/.test(unverifiable.message ?? ''),
    JSON.stringify(unverifiable).slice(0, 280),
  );
  check(
    'P3 该文案声明是瞬时失败 / 可重试，且不带 UNAVAILABLE 指引横幅',
    (unverifiable.message ?? '').includes('TRANSIENT')
      && (unverifiable.message ?? '').includes('Retry this dispatch in a LATER step')
      && !(unverifiable.message ?? '').includes('Pipeline stage UNAVAILABLE')
      && !(unverifiable.message ?? '').includes('STOP and report to the user'),
    (unverifiable.message ?? '').slice(0, 240),
  );
  check('P3 被拒时没有发生创建', p3.calls.start === 0, 'start ' + p3.calls.start);
  // P3.2 枚举恢复 → 重试成功（拒绝是瞬时的，不是永久卡死）
  p3.host.fail = false;
  const retried = await attempt(p3, 'subagent_impl', { description: 'enumeration recovered' });
  check(
    'P3 枚举恢复后重试成功（瞬时拒绝，不是永久卡死）',
    retried.ok === true && p3.calls.start === 1,
    JSON.stringify(retried).slice(0, 220) + ' start ' + p3.calls.start,
  );

  // P3.3 高水位：成功观测一次后枚举抛错 → 仍被拒，且用那次观测的清单兜底
  const p3b = await newHarness('parent-p3b', capFor({ impl: 1 }));
  p3b.host.rows = persistRows([['persisted-hw-1', 'impl/high-water row']]);
  const beforeOutage = await attempt(p3b, 'subagent_impl', { description: 'records the observation' });
  check(
    'P3 高水位前置：先成功枚举一次并被拒（清单来自持久面）',
    beforeOutage.ok === false && (beforeOutage.message ?? '').includes('persisted-hw-1'),
    JSON.stringify(beforeOutage).slice(0, 220),
  );
  const probeCallsBefore = p3b.host.calls.length;
  p3b.host.fail = true;
  const afterOutage = await attempt(p3b, 'subagent_impl', { description: 'enumeration now failing' });
  check(
    'P3 随后枚举抛错 → 仍被拒（读不到不等于没有）',
    afterOutage.ok === false && /stage CREATION limit reached/i.test(afterOutage.message ?? ''),
    JSON.stringify(afterOutage).slice(0, 240),
  );
  check(
    'P3 拒绝文案用高水位那次观测的清单兜底（列出持久面 id + label）',
    (afterOutage.message ?? '').includes('persisted-hw-1') && (afterOutage.message ?? '').includes('impl/high-water row'),
    (afterOutage.message ?? '').slice(0, 240),
  );
  check(
    'P3 高水位让判定在同步阶段就完成（只多一次运行闸门探测，创建闸门不再依赖持久面）',
    p3b.host.calls.length - probeCallsBefore === 1,
    'listing calls +' + (p3b.host.calls.length - probeCallsBefore),
  );
  check('P3 高水位路径同样没有创建', p3b.calls.start === 0, 'start ' + p3b.calls.start);

  // P3.3b 高水位已知且仍在上限内 → 枚举失败时放行（不因瞬时失败过度拒绝 / 永久卡死）
  const p3c = await newHarness('parent-p3c', capFor({ impl: 2 }));
  p3c.host.rows = persistRows([['persisted-hw-2', 'impl/one known child']]);
  const knownOne = await attempt(p3c, 'subagent_impl', { description: 'records a known count of 1' });
  check('P3 高水位已知（1）且上限 2：先成功派发一次以记录观测', knownOne.ok === true, JSON.stringify(knownOne).slice(0, 200));
  p3c.host.fail = true;
  const duringOutage = await attempt(p3c, 'subagent_impl', { description: 'second while listing fails' });
  check(
    'P3 高水位已知且仍在上限内 → 枚举失败时放行（瞬时失败不得变成永久卡死）',
    duringOutage.ok === true && p3c.calls.start === 2,
    JSON.stringify(duringOutage).slice(0, 240) + ' start ' + p3c.calls.start,
  );

  // P3.4 宿主根本没有 listChildren（永久形状差异，非瞬时）→ 不得被「无法核实」卡死
  const p3d = await newHarness('parent-p3d', capFor({ impl: 1 }));
  delete p3d.subagents.listChildren;
  const noListing = await attempt(p3d, 'subagent_impl', { description: 'host has no listing' });
  check(
    'P3 宿主没有 listChildren（永久形状差异）→ 按台账判定，不被「无法核实」卡死',
    noListing.ok === true,
    JSON.stringify(noListing).slice(0, 240),
  );
  const noListingSecond = await attempt(p3d, 'subagent_impl', { description: 'second with no listing' });
  check(
    'P3 没有 listChildren 时台账仍是权威：第 2 个被拒（不得因为读不到就放行）',
    noListingSecond.ok === false && /stage (concurrency|CREATION) limit reached/i.test(noListingSecond.message ?? ''),
    JSON.stringify(noListingSecond).slice(0, 260),
  );
  p3d.emit('subagent/end', { id: noListing.result.subagentId });
  p3d.children.set(noListing.result.subagentId, { activity: 'idle' });
  const noListingThird = await attempt(p3d, 'subagent_impl', { description: 'third with no listing' });
  check(
    'P3 没有 listChildren 时创建上限也按台账生效（settle、running 归零后仍被拒）',
    noListingThird.ok === false && /stage CREATION limit reached/i.test(noListingThird.message ?? ''),
    JSON.stringify(noListingThird).slice(0, 260),
  );
  check('P3 没有 listChildren 的两次拒绝都没有发生创建', p3d.calls.start === 1, 'start ' + p3d.calls.start);
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


// ── H. 结构化 I/O（阶段回执 envelope / pipeline_submit / pipeline_result）────────
// 阶段子代理把结论作为结构化对象交回来：优先走 pipeline_submit（调用点 schema + 语义
// 校验，不合格当场打回），否则由插件在 subagent/end 解析最终回复里的 json 围栏。
// 主代理用 pipeline_result 读回，triage 白名单因此在程序里可跑。
{
  check('H1 主代理侧注册了 pipeline_result（阶段工具之外的第 5 个）', typeof h.tools.get('pipeline_result')?.execute === 'function');

  const iso = await newHarness('parent-iso-1', capStages(0));
  const dImpl = await attempt(iso, 'subagent_impl', { description: 'iso work' });
  const implId = dImpl.result?.subagentId;
  const empty = await attemptTool(iso.tools.get('pipeline_result'), { child: 'impl' }, iso.parent);
  check(
    'H2 没有回执时 pipeline_result 如实返回 parsed:false + reason（不编造）',
    empty.ok === true && empty.result?.parsed === false && typeof empty.result?.reason === 'string',
    JSON.stringify(empty).slice(0, 180),
  );

  const child = iso.addStageChild(implId, 'impl');
  iso.emit('agent/created', { agent: child.agent });
  const submit = child.tools.get('pipeline_submit');
  check('H3 阶段子代理被注入 pipeline_submit（识别依据 = agent.options.stageKey）', typeof submit?.execute === 'function');
  check(
    'H3 impl envelope 的 schema 强制 kind + summary',
    Array.isArray(submit?.parameters?.properties?.envelope?.required)
      && submit.parameters.properties.envelope.required.includes('kind')
      && submit.parameters.properties.envelope.required.includes('summary'),
    JSON.stringify(submit?.parameters?.properties?.envelope?.required),
  );
  const okEnvelope = await attemptTool(submit, { envelope: { kind: 'impl', summary: 'did the thing', files: [{ path: 'a.ts', change: 'edited' }] } }, child.agent);
  check('H4 pipeline_submit 接受合法 envelope 并回执 ok', okEnvelope.ok === true && okEnvelope.result?.ok === true && okEnvelope.result?.kind === 'impl', JSON.stringify(okEnvelope).slice(0, 180));
  const read = await attemptTool(iso.tools.get('pipeline_result'), { child: 'impl' }, iso.parent);
  check(
    'H4 pipeline_result 读回结构化回执（source=submit，value 完整）',
    read.ok === true && read.result?.parsed === true && read.result?.source === 'submit' && read.result?.value?.summary === 'did the thing',
    JSON.stringify(read).slice(0, 220),
  );

  // reviewer 的硬约束在调用点变成机制：写不出触发场景 / docs-style / 不在改动行上 /
  // verdict 与 findings 不一致的 envelope 直接被拒，子代理当轮就能改。
  const dReview = await attempt(iso, 'subagent_review', { description: 'iso review', diff: '@@ -1 +1 @@\\n-a\\n+b' });
  const reviewChild = iso.addStageChild(dReview.result?.subagentId, 'review');
  iso.emit('agent/created', { agent: reviewChild.agent });
  const rsubmit = reviewChild.tools.get('pipeline_submit');
  check('H5 review 子代理也拿到 pipeline_submit（只读白名单放行了它）', typeof rsubmit?.execute === 'function');

  const noScenario = await attemptTool(rsubmit, { envelope: { kind: 'review', verdict: 'request_changes', issues: [{ id: 'R1', severity: 'high', blocking: true, category: 'correctness', problem: 'x' }] } }, reviewChild.agent);
  check('H5 blocking 但写不出 failureScenario → 调用点拒绝', noScenario.ok === false && String(noScenario.message).includes('failureScenario'), String(noScenario.message).slice(0, 200));
  const docsBlocking = await attemptTool(rsubmit, { envelope: { kind: 'review', verdict: 'request_changes', issues: [{ id: 'R2', severity: 'high', blocking: true, category: 'docs', problem: 'doc gap', failureScenario: 'x', onChangedLines: true }] } }, reviewChild.agent);
  check('H5 docs 类问题不得 blocking → 调用点拒绝', docsBlocking.ok === false && String(docsBlocking.message).includes('docs/style'), String(docsBlocking.message).slice(0, 200));
  const offDiff = await attemptTool(rsubmit, { envelope: { kind: 'review', verdict: 'request_changes', issues: [{ id: 'R3', severity: 'critical', blocking: true, category: 'correctness', problem: 'x', failureScenario: 'y', onChangedLines: false }] } }, reviewChild.agent);
  check('H5 不在改动行上的问题不得 blocking → 调用点拒绝', offDiff.ok === false && String(offDiff.message).includes('off the changed lines'), String(offDiff.message).slice(0, 200));
  const badVerdict = await attemptTool(rsubmit, { envelope: { kind: 'review', verdict: 'approve', issues: [{ id: 'R4', severity: 'critical', blocking: true, category: 'correctness', problem: 'x', failureScenario: 'y', onChangedLines: true }] } }, reviewChild.agent);
  check('H5 有 blocking 却报 approve → verdict 与 findings 不一致，调用点拒绝', badVerdict.ok === false && String(badVerdict.message).includes('request_changes'), String(badVerdict.message).slice(0, 200));
  const goodReview = await attemptTool(rsubmit, { envelope: { kind: 'review', verdict: 'request_changes', blockingCount: 1, issues: [{ id: 'R5', severity: 'high', blocking: true, category: 'correctness', problem: 'null deref', failureScenario: 'empty list reaches the branch', onChangedLines: true }, { id: 'R6', severity: 'low', blocking: false, category: 'docs', problem: 'typo' }] } }, reviewChild.agent);
  check('H5 合法 review envelope（1 blocking + 1 non-blocking）被接受', goodReview.ok === true && goodReview.result?.ok === true, String(goodReview.message).slice(0, 180));

  // 兜底通道：没有 pipeline_submit 的子代理（旧 descriptor / 工具不可用）从最终回复解析。
  const FENCE = String.fromCharCode(96, 96, 96);
  const iso2 = await newHarness('parent-iso-2', capStages(0));
  const dFallback = await attempt(iso2, 'subagent_impl', { description: 'fallback work' });
  const fenced = ['did it', '', FENCE + 'json', JSON.stringify({ kind: 'impl', summary: 'via fence' }), FENCE].join('\n');
  iso2.emit('subagent/end', { id: dFallback.result?.subagentId, lastAssistantMessage: [{ type: 'text', text: fenced }] });
  const parsedRead = await attemptTool(iso2.tools.get('pipeline_result'), { child: 'impl' }, iso2.parent);
  check(
    'H6 兜底：从最终回复的 json 围栏解析成结构化回执（source=parsed）',
    parsedRead.result?.parsed === true && parsedRead.result?.source === 'parsed' && parsedRead.result?.value?.summary === 'via fence',
    JSON.stringify(parsedRead).slice(0, 220),
  );
  const dProse = await attempt(iso2, 'subagent_impl', { description: 'prose only' });
  iso2.emit('subagent/end', { id: dProse.result?.subagentId, lastAssistantMessage: [{ type: 'text', text: 'just prose, no fence' }] });
  const proseRead = await attemptTool(iso2.tools.get('pipeline_result'), { child: 'impl' }, iso2.parent);
  check('H6 没有围栏时 parsed:false + reason（解析失败不阻塞、不编造）', proseRead.result?.parsed === false && typeof proseRead.result?.reason === 'string', JSON.stringify(proseRead).slice(0, 180));
  iso2.emit('subagent/start', { id: dFallback.result?.subagentId });
  const clearedRead = await attemptTool(iso2.tools.get('pipeline_result'), { child: 'impl' }, iso2.parent);
  check('H6 新一轮激活（subagent/start）作废上一轮回执，避免被唤醒时读到陈旧 verdict', clearedRead.result?.parsed === false, JSON.stringify(clearedRead).slice(0, 180));

  // 结构化投递：主代理把 triage 后的 issue 数组原样交给 impl，不必手抄。
  const iso3 = await newHarness('parent-iso-3', capStages(0));
  const dFollow = await attempt(iso3, 'subagent_impl', { description: 'structured followup' });
  const delivered = await attemptTool(
    iso3.tools.get('pipeline_followup'),
    { child: dFollow.result?.subagentId, issues: [{ id: 'R9', severity: 'high', blocking: true, category: 'correctness', problem: 'boom', failureScenario: 'empty input', suggestedFix: 'guard the empty case' }] },
    iso3.parent,
  );
  const steered = iso3.steers[iso3.steers.length - 1]?.text ?? '';
  check('H7 pipeline_followup 接受 issues[]（无需 message）并渲染进投递文本', delivered.ok === true && steered.includes('TRIAGED ISSUES') && steered.includes('[R9]') && steered.includes('boom'), steered.slice(0, 220));
  check('H7 渲染带 failureScenario / suggestedFix，主代理无需手抄', steered.includes('failure scenario: empty input') && steered.includes('suggested fix: guard the empty case'), steered.slice(0, 260));
  const both = await attemptTool(iso3.tools.get('pipeline_followup'), { child: dFollow.result?.subagentId, message: 'Round 2: fix only these.', issues: [{ id: 'R10', severity: 'high', blocking: true, category: 'correctness', problem: 'x', failureScenario: 'y', onChangedLines: true }] }, iso3.parent);
  check('H7 message 与 issues 可并存（message 作为指令正文在前）', both.ok === true && String(iso3.steers[iso3.steers.length - 1]?.text ?? '').startsWith('Round 2: fix only these.'), String(iso3.steers[iso3.steers.length - 1]?.text ?? '').slice(0, 160));
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
