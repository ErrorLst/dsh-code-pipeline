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
    startContinuable: async () => {
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
    prompt: async (payload) => { queued.push(payload); return { messageId: 'msg-1' }; },
    sendMessage: async (_parent, childId, content) => {
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
    agentsService, subagents,
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

console.log('');
console.log(checks + ' checks, ' + failures.length + ' failure(s)');
if (failures.length > 0) {
  for (const failure of failures) console.log('  - ' + failure);
  process.exitCode = 1;
}
