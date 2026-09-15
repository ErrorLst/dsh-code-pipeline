// @dsh-external/dsh-code-pipeline — 假 ctx 集成冒烟：每阶段墙钟预算（0.1.16）
//
// 覆盖：预算到点 -> 中断 + queue 收尾投递；80% 软警告（only once / 只在运行中）；预算 0 不误伤；
//       子代理自行 settle 不误伤；收尾宽限用尽 -> 第二次中断（硬停）；宿主缺 interrupt /
//       父代理缺失时只告警；status 端点新字段；阶段工具 description 的墙钟与 workstreams 文案。
//
// 运行：node test/watchdog.smoke.mjs（或 npm test）
// 依赖：@deepseek-ai/schemastery 必须可解析（pnpm install，或本地开发时链接宿主副本）。

import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
function createHarness() {
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
  const calls = { prompt: 0, promptPayloads: [], promptSignals: [], startSignals: [], sendMessageOptions: [], rejectDelivery: false, rejectKnownShapes: false, rewriteBadPayloadMessage: false };
  let childSeq = 0;

  const toolsRegistry = { register: (def) => tools.set(def.name, def) };
  const parent = {
    id: 'parent-1',
    ctx: {
      get: (name) => name === 'tools'
        ? toolsRegistry
        : name === 'agentPresets'
          ? { composedPreset: () => 'code-pipeline' }
          : undefined,
    },
  };

  const webServer = { register: ({ path, handler }) => routes.set(path, handler) };
  const agentsService = {
    roots: () => [parent],
    isOwnedBy: () => false,
    get: (id) => (id === parent.id ? parent : undefined),
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
      childSeq += 1;
      const childId = 'child-' + childSeq;
      children.set(childId, { activity: 'running' });
      return { childId, messageId: 'msg-0' };
    },
    listChildren: async () => [...children.entries()].map(([id, row]) => ({ kind: 'child', id, activity: row.activity })),
    interrupt: (id, authority) => {
      interrupts.push({ id, authority });
      const row = children.get(id);
      if (row) row.activity = 'idle';
    },
    prompt: async (payload, signal) => {
      calls.prompt += 1;
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
          ? { composedPreset: () => 'code-pipeline' }
          : name === 'webServer'
            ? webServer
            : undefined,
    inject: (_deps, cb) => cb({ settings: { installSection: (_t, _n, _s, _c, hook) => hook.setSource(() => settings) } }),
  };

  return {
    ctx, parent, settings, tools, routes, warnings, interrupts, queued, steers, children,
    agentsService, subagents, calls,
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

check('三个阶段工具 + pipeline_followup 已注册', h.tools.size === 4, 'got ' + h.tools.size);
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
