// @dsh-external/dsh-code-pipeline — 假 ctx 集成冒烟：每阶段墙钟预算（0.1.15）
//
// 覆盖：预算到点 -> 中断 + queue 收尾投递；预算 0 不误伤；子代理自行 settle 不误伤；
//       收尾宽限用尽 -> 第二次中断（硬停）；宿主缺 interrupt / 父代理缺失时只告警；
//       status 端点新字段；阶段工具 description 带 WALL-CLOCK BUDGET。
//
// 运行：node test/watchdog.smoke.mjs
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
    sendMessage: async () => 'msg-2',
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
    ctx, parent, settings, tools, routes, warnings, interrupts, queued, children,
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

const dispatch = (toolName, args = {}) => h.tools.get(toolName).execute(
  { prompt: 'do the thing', ...args },
  { agent: h.parent, signal: new AbortController().signal },
);
const statusOf = async () => {
  const { res, captured } = captureResponse();
  await h.routes.get('/dsh-code-pipeline/status')({}, res);
  return JSON.parse(captured.body).stages;
};

// 1) 默认预算 0：再久也不动手
{
  const before = h.interrupts.length;
  const result = await dispatch('subagent_impl');
  advance(2 * 60 * 60 * 1000);
  sweep();
  await tick();
  check('预算 0（默认）不触发中断', h.interrupts.length === before && result.kind === 'continuable');
}

// 2) 预算 1 分钟：中断 + queue 收尾投递 + status 字段
{
  h.settings.stages = { plan: { budgetMinutes: 1 }, impl: { budgetMinutes: 1 }, review: { budgetMinutes: 1 } };
  const before = h.interrupts.length;
  const result = await dispatch('subagent_impl');
  advance(61 * 1000);
  sweep();
  await tick(30);
  const interrupt = h.interrupts[before];
  check('预算到点触发一次中断', h.interrupts.length === before + 1, 'got ' + (h.interrupts.length - before));
  check('中断目标是刚派发的子代理', interrupt?.id === result.subagentId, String(interrupt?.id));
  check(
    '中断授权用派发时的父代理（ancestor）',
    interrupt?.authority?.kind === 'ancestor' && interrupt?.authority?.agent === h.parent,
  );
  check(
    '收尾指令经 queue 通道投递',
    h.queued.length === 1 && h.queued[0].delivery === 'queue' && h.queued[0].mode === 'continuable',
    JSON.stringify(h.queued[0]?.delivery),
  );
  const text = String(h.queued[0]?.content?.[0]?.text ?? '');
  check('收尾指令要求只报告、不改工作区', text.includes('wall-clock budget') && text.includes('do NOT edit files'), text.slice(0, 60));
  const stages = await statusOf();
  check(
    'status 报出 budgetMinutes / timedOut / longestRunningMs',
    stages.impl?.budgetMinutes === 1 && stages.impl?.timedOut === 1 && stages.impl?.longestRunningMs >= 60000,
    JSON.stringify(stages.impl),
  );

  // 3) 收尾宽限用尽 -> 第二次中断（硬停）
  h.children.set(result.subagentId, { activity: 'running' });
  advance(4 * 60 * 1000);
  const beforeGrace = h.interrupts.length;
  sweep();
  await tick(30);
  check('收尾宽限用尽触发第二次中断', h.interrupts.length === beforeGrace + 1, 'got ' + (h.interrupts.length - beforeGrace));
  check('硬停有告警', h.warnings.some((line) => line.includes('hard stop')));
  h.children.set(result.subagentId, { activity: 'idle' });
}

// 4) 子代理自行 settle：不误伤
{
  const before = h.interrupts.length;
  const result = await dispatch('subagent_impl');
  h.emit('subagent/end', { id: result.subagentId });
  h.children.set(result.subagentId, { activity: 'idle' });
  advance(10 * 60 * 1000);
  sweep();
  await tick();
  check('自行 settle 的子代理不被中断', h.interrupts.length === before);
}

// 5) 宿主缺 subagents.interrupt：只告警，不抛
{
  const original = h.subagents.interrupt;
  delete h.subagents.interrupt;
  const before = h.warnings.length;
  await dispatch('subagent_review');
  advance(61 * 1000);
  sweep();
  await tick(30);
  check('宿主缺 interrupt 时只告警', h.warnings.slice(before).some((line) => line.includes('subagents.interrupt is unavailable')));
  h.subagents.interrupt = original;
}

// 6) 父代理缺失：只告警，不抛
{
  const original = h.agentsService.get;
  h.agentsService.get = () => undefined;
  const before = h.warnings.length;
  await dispatch('subagent_plan');
  advance(61 * 1000);
  sweep();
  await tick(30);
  check('父代理不在时只告警', h.warnings.slice(before).some((line) => line.includes('is no longer live')));
  h.agentsService.get = original;
}

console.log('');
console.log(checks + ' checks, ' + failures.length + ' failure(s)');
if (failures.length > 0) {
  for (const failure of failures) console.log('  - ' + failure);
  process.exitCode = 1;
}
