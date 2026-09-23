// @dsh-external/dsh-code-pipeline — browser half.
//
// Served at /plugins/@dsh-external/dsh-code-pipeline/client.js through the
// client-modules system: registers a factory under window.__ModuleLoader__,
// materialized lazily. The factory returns the Cordis client plugin
// (inject + apply), which registers ONE piece of UI:
//
//   settings.section — the "代码流水线" card. It edits the plugin Config's
//   volatile fields (configForms entry id "dsh-code-pipeline"): per-stage
//   enabled / provider / model / reasoningEffort / maxConcurrency /
//   budgetMinutes, plus followupMode, compactionThresholdRatio and
//   readWidenMinLines. The host tools read those fields on every call, so
//   saving takes effect on the next dispatch — no dsh restart needed.
//
// Provider/model lists come from GET /dsh-code-pipeline/options; when it (or a
// model list) is unavailable the fields are DISABLED with a hint — never
// free-text. Live facts come from GET /dsh-code-pipeline/status, polled every
// 5s while the card is open: per-stage running/pending/limit (same per-session
// scope as the limit), wall-clock status, created/available children, and the
// host self-check (host.checks / host.injection). Every optional status field
// degrades silently when the host omits it — never render undefined.
//
// Copy discipline: the always-visible hint of every field stays ONE short line
// (the M smoke block enforces ≤80 chars); longer rationale lives behind the
// native <details> collapse in HelpText. Do not repeat the same explanation in
// the intro, the field hint and the stage hints — one place only.

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-code-pipeline",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const STAGE_ROWS = [
      { key: "plan", label: "规划 Plan", hint: "只读研究并产出实施计划。", detail: "只用于规划——不审查、不审计、不审批代码。" },
      { key: "impl", label: "实现 Impl", hint: "按计划修改工作区（完整工具面）。", detail: "只用于实现。同一工作流的后续轮次（评审问题、改需求、墙钟续跑）用 pipeline_followup 续用同一个子代理，不新派。" },
      { key: "review", label: "评审 Review", hint: "只读审计变更集并给出结论。", detail: "只用于审查——不做规划、不做设计。结论是结构化 envelope（verdict + 分级 findings）。" },
    ];

    // 只声明真正使用的服务：connection / remote 从未用到，多余声明会让宿主
    // 客户端服务一旦缺失/改名就整块设置卡片静默不激活。
    // dsh 0.1.7：settings 域服务是 configForms（SettingsScope 已移除）；它由
    // @deepseek-ai/dsh-client-ui-settings 提供，已在 dsh.client.inject 声明。
    const inject = ["slots", "configForms"];

    // 思考等级兜底选项：仅当所选模型没有 resolveModelInfo 的 reasoning 信息时
    // 使用（两个适配器已知支持面的交集：off 仅 deepseek 有、medium 双方都没有）；
    // 正常情况下选项来自模型自身的 reasoning.efforts，绝不手输。
    const FALLBACK_EFFORT_OPTIONS = [
      { value: "", label: "继承 provider 默认（留空）" },
      { value: "low", label: "low" },
      { value: "high", label: "high" },
      { value: "max", label: "max" },
    ];

    // 客户端兜底默认值：即使 namesace 尚未解析出 stages（或解析失败），
    // 页面也始终显示完整的三阶段卡片，而不是空白。所有阶段默认
    // deepseek-official / deepseek-flash（宿主 0.1.5-rc.1 起的默认模型）；
    // 思考等级留空 = 继承路由默认。与宿主 lib/index.js 的 DEFAULT_STAGES 同值。
    const CLIENT_DEFAULT_STAGES = {
      plan: { enabled: true, provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "", maxConcurrency: 0, budgetMinutes: 0 },
      impl: { enabled: true, provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "", maxConcurrency: 0, budgetMinutes: 0 },
      review: { enabled: true, provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "", maxConcurrency: 0, budgetMinutes: 0 },
    };

    function mergeStageDefaults(stages) {
      const out = {};
      for (const row of STAGE_ROWS) {
        out[row.key] = { ...CLIENT_DEFAULT_STAGES[row.key], ...(stages?.[row.key] ?? {}) };
      }
      return out;
    }

    // 子代理消息投递方式（pipeline_followup）：steer = 固定插入（运行中
    // 最近步骤即收到）；queue = 固定排队（当前回合结束后按顺序处理）。
    const FOLLOWUP_MODES = [
      { value: "steer", label: "固定插入（推荐）" },
      { value: "queue", label: "固定排队" },
    ];

    // 压缩触发比例的客户端兜底默认值（与插件 Config 同默认；0.5 = 相对模型窗口的
    // 50%，保留量取阈值的 1/5）。写入 profile 的预设声明，生效时机是「之后挂载的代理」。
    const COMPACTION_THRESHOLD_FALLBACK = 0.5;
    const COMPACTION_THRESHOLD_MIN = 0.05;
    const COMPACTION_THRESHOLD_MAX = 0.8;
    const COMPACTION_THRESHOLD_HINT = "上下文达到该比例时自动压缩历史；0.05–0.8，默认 0.5。";
    const COMPACTION_THRESHOLD_DETAIL =
      "比例相对模型窗口；保留量自动取阈值的 1/5。写入预设声明，对新会话与新派发的阶段子代理生效（当前主会话需重选一次预设或重启 dsh）。调低会更省上下文重发成本，但更快丢掉细节记忆并放弃前缀缓存。";

    // read 读取窗口下限（readWidenMinLines）的客户端兜底：与插件 Config 同默认（200）。
    const READ_WIDEN_FALLBACK = 200;
    const READ_WIDEN_MIN = 0;
    const READ_WIDEN_MAX = 2000;
    const READ_WIDEN_HINT = "低于该值的 read 请求会被自动拓宽到该值；0 = 关闭。";
    const READ_WIDEN_DETAIL =
      "默认 200；2000 = 一律整窗（等价于省略 limit）。超过 2000 的会被治愈为 2000，不再整批失败。嵌套 read 的结果只进 run_code 程序、不进模型历史，所以拓宽本身是零 token 成本的——它消除的是「一个文件几十行几十行地翻、每多一步重发整个上下文」的分页模式。改动立即对后续 read 生效。";

    const CARD_STYLE = {
      maxWidth: "720px",
      color: "var(--dsw-alias-label-primary)",
      display: "flex",
      flexDirection: "column",
      gap: "14px",
    };
    const TITLE_STYLE = { margin: 0, fontSize: "16px", fontWeight: 500, lineHeight: "24px" };
    const INTRO_STYLE = {
      margin: 0,
      fontSize: "14px",
      lineHeight: "22px",
      color: "var(--dsw-alias-label-tertiary)",
    };
    const STAGE_STYLE = {
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "10px",
      padding: "12px 14px",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      background: "var(--dsw-specific-input-major, rgba(127,127,127,0.04))",
    };
    const STAGE_HEADER_STYLE = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
    };
    const STAGE_TITLE_STYLE = { margin: 0, fontSize: "14px", fontWeight: 600 };
    const STAGE_HINT_STYLE = { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" };
    const ROW_STYLE = { display: "flex", flexDirection: "column", gap: "4px" };
    const LABEL_STYLE = { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" };
    const INPUT_STYLE = {
      boxSizing: "border-box",
      width: "100%",
      height: "34px",
      padding: "0 10px",
      fontSize: "13px",
      fontFamily: "inherit",
      color: "var(--dsw-alias-label-primary)",
      background: "var(--dsw-specific-input-major, rgba(127,127,127,0.06))",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "8px",
      outline: "none",
    };
    const BUTTON_STYLE = {
      boxSizing: "border-box",
      alignSelf: "flex-start",
      height: "34px",
      padding: "0 16px",
      fontSize: "13px",
      cursor: "pointer",
      border: "none",
      borderRadius: "18px",
      background: "var(--dsw-alias-button-primary-fill)",
      color: "var(--dsw-alias-label-primary-foreground)",
    };
    const STATUS_STYLE = {
      margin: 0,
      fontSize: "12px",
      lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary)",
    };

    // 文案纪律：常显一行、细则折叠。设置卡片曾经每个字段挂一大段说明，而且同一段并发解释
    // 在 intro / 字段 / 阶段提示里重复三次，扫一眼读不完。HelpText 让常显提示保持一行，把
    // 长理由放进原生 <details>（零新依赖）。
    function HelpText({ text, detail, style }) {
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "2px" } },
        React.createElement("label", { style: style ?? LABEL_STYLE }, text),
        detail === undefined || detail === null
          ? null
          : React.createElement(
              "details",
              { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" } },
              React.createElement("summary", { style: { cursor: "pointer" } }, "说明"),
              React.createElement("div", { style: { marginTop: "4px", lineHeight: "18px" } }, detail),
            ),
      );
    }

    function StageCard({ row, stage, options, status, onChange }) {
      if (stage === undefined) return null;
      const providers = (options.providers ?? []).filter((p) => p.id);
      const knownProvider = providers.find((p) => p.id === stage.provider);
      const models = knownProvider?.models?.filter((m) => m.id) ?? [];

      const set = (field, next) => onChange({ ...stage, [field]: next });

      // 切换 provider 时,模型自动重置为新的 provider 的第一个模型 ——
      // 避免下拉框里残留上一个 provider 的模型值。
      const onProviderChange = (e) => {
        const next = e.target.value;
        const firstModel =
          providers.find((p) => p.id === next)?.models?.find((m) => m.id)?.id ?? "";
        onChange({ ...stage, provider: next, model: firstModel, reasoningEffort: "" });
      };

      // 换模型时检查思考等级是否仍被该模型支持(不同模型的 efforts 不同,
      // 例如 deepseek 支持 off/low/high/max,glm-5.3 只支持 low/high/max);
      // 不支持则重置为"继承默认",避免保存后调用被 UNSUPPORTED_REASONING_EFFORT 拒绝。
      const onModelChange = (e) => {
        const next = e.target.value;
        const info = models.find((m) => m.id === next);
        const supported = info?.reasoning?.efforts?.some((effort) => effort.id === stage.reasoningEffort);
        const nextStage = { ...stage, model: next };
        if (stage.reasoningEffort && !supported) nextStage.reasoningEffort = "";
        onChange(nextStage);
      };

      // 思考等级选项:优先取所选模型自身的 reasoning.efforts(模型实际支持面),
      // 信息缺失时使用兜底交集 [low, high, max]。
      const selectedModelInfo = models.find((m) => m.id === stage.model);
      const modelEfforts = selectedModelInfo?.reasoning?.efforts?.filter((e) => e.id) ?? [];
      const effortOptions = modelEfforts.length > 0
        ? [
            { value: "", label: "继承 provider 默认（留空）" },
            ...modelEfforts.map((e) => ({ value: e.id, label: e.name || e.id })),
          ]
        : FALLBACK_EFFORT_OPTIONS;

      // Provider / 模型一律用原生下拉,任何情况都不手输：
      // 列表缺失时字段禁用并给出提示,而不是退化为文本框。
      const providerDisabled = providers.length === 0;
      const providerControl = React.createElement(
        "select",
        {
          style: INPUT_STYLE,
          value: stage.provider ?? "",
          disabled: providerDisabled,
          onChange: onProviderChange,
        },
        React.createElement(
          "option",
          { value: "" },
          providerDisabled ? "-- provider 列表不可用（禁用）--" : "-- 选择 provider --",
        ),
        ...(knownProvider === undefined && stage.provider
          ? [React.createElement("option", { value: stage.provider }, stage.provider)]
          : []),
        ...providers.map((p) =>
          React.createElement("option", { key: p.id, value: p.id }, p.displayName || p.id)),
      );

      // 并发上限：0 = 不限制；状态行来自 /dsh-code-pipeline/status（端点不可用时
      // 只显示上限，不报错）。
      const limit = Number.isFinite(stage.maxConcurrency) ? Math.max(0, Math.trunc(stage.maxConcurrency)) : 0;
      const liveRunning = Number.isFinite(status?.running) ? status.running : 0;
      const livePending = Number.isFinite(status?.pending) ? status.pending : 0;
      // 新口径的「已创建（含已结束）总量」：读 status.created。宿主字段可能尚未上线，
      // 缺失 / 非数字时省略这半句，绝不渲染 undefined / NaN。
      const liveCreated = Number.isFinite(status?.created) ? Math.max(0, Math.trunc(status.created)) : null;
      const liveSessions = Number.isFinite(status?.sessions) ? status.sessions : 0;
      const liveTotalRunning = Number.isFinite(status?.totalRunning) ? status.totalRunning : null;
      const liveTotalPending = Number.isFinite(status?.totalPending) ? status.totalPending : null;
      const concurrencyStatus =
        "运行 " + liveRunning + (livePending > 0 ? "（启动中 " + livePending + "）" : "")
        + " / 上限 " + (limit > 0 ? limit : "不限制")
        + (liveSessions > 1 || (liveTotalRunning !== null && liveTotalRunning !== liveRunning)
          ? "；共 " + liveSessions + " 个会话在跑"
            + (liveTotalRunning === null ? "" : "（合计 " + liveTotalRunning + " 个运行"
              + (liveTotalPending !== null && liveTotalPending > 0 ? " + " + liveTotalPending + " 个启动中" : "")
              + "）")
          : "")
        + (liveCreated === null ? "" : " / 已创建 " + liveCreated);
      // 可复用子代理清单：读 status.available（元素 { id, label, activity }）。字段
      // 缺失 / 非数组 / 空数组时静默跳过；列表截断，避免撑爆设置卡片。
      const reusableHintMax = 5;
      const reusableLabels = (Array.isArray(status?.available) ? status.available : [])
        .map((entry) =>
          typeof entry === "string"
            ? entry
            : (typeof entry?.label === "string" && entry.label
                ? entry.label
                : (typeof entry?.id === "string" ? entry.id : "")))
        .filter((label) => typeof label === "string" && label !== "");
      const reusableHint = reusableLabels.length === 0
        ? ""
        : "已创建："
          + reusableLabels.slice(0, reusableHintMax).join("、")
          + (reusableLabels.length > reusableHintMax ? " 等 " + reusableLabels.length + " 个" : "");

      // 墙钟预算：0 = 不限制；状态里的「最早已运行 / 已超时」来自 /dsh-code-pipeline/status
      // （端点不可用时只显示配置值，不报错）。
      const budgetMinutes = Number.isFinite(stage.budgetMinutes) ? Math.max(0, Math.trunc(stage.budgetMinutes)) : 0;
      const liveTimedOut = Number.isFinite(status?.timedOut) ? status.timedOut : 0;
      const liveLongestMs = Number.isFinite(status?.longestRunningMs) ? status.longestRunningMs : 0;
      const wallClockStatus =
        "预算 " + (budgetMinutes > 0 ? budgetMinutes + " 分钟" : "不限制")
        + (liveLongestMs > 0 ? "；最早已运行 " + Math.max(1, Math.round(liveLongestMs / 60000)) + " 分钟" : "")
        + (liveTimedOut > 0 ? "；" + liveTimedOut + " 个已超时（中断 / 收尾中）" : "");

      const modelDisabled = models.length === 0;
      const modelControl = React.createElement(
        "select",
        {
          style: INPUT_STYLE,
          value: stage.model ?? "",
          disabled: modelDisabled,
          onChange: onModelChange,
        },
        React.createElement(
          "option",
          { value: "" },
          modelDisabled ? "-- 模型列表不可用（禁用）--" : "-- 选择模型 --",
        ),
        ...models.map((m) =>
          React.createElement("option", { key: m.id, value: m.id }, m.name || m.id)),
      );

      return React.createElement(
        "section",
        { style: STAGE_STYLE },
        React.createElement(
          "div",
          { style: STAGE_HEADER_STYLE },
          React.createElement("input", {
            type: "checkbox",
            checked: stage.enabled !== false,
            onChange: (e) => set("enabled", e.target.checked),
          }),
          React.createElement("h4", { style: STAGE_TITLE_STYLE }, row.label),
        ),
        React.createElement(HelpText, { text: row.hint, detail: row.detail, style: STAGE_HINT_STYLE }),
        React.createElement(
          "div",
          { style: ROW_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "Provider 路由"),
          providerControl,
        ),
        React.createElement(
          "div",
          { style: ROW_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "模型"),
          modelControl,
        ),
        React.createElement(
          "div",
          { style: ROW_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "思考等级"),
          React.createElement(
            "select",
            {
              style: INPUT_STYLE,
              value: stage.reasoningEffort ?? "",
              onChange: (e) => set("reasoningEffort", e.target.value),
            },
            ...effortOptions.map((option) =>
              React.createElement("option", { key: option.value, value: option.value }, option.label)),
          ),
          React.createElement(HelpText, {
            text: "留空 = 继承 provider 路由级默认。",
            detail: "选项按所选模型实际支持面列出（如 deepseek：off/low/high/max；GLM-5.3：low/high/max）。换 provider / 模型时不支持的等级会自动重置为「继承默认」。",
          }),
        ),
        React.createElement(
          "div",
          { style: ROW_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "最大并发子代理数（同时运行）"),
          React.createElement("input", {
            type: "number",
            min: 0,
            max: 64,
            step: 1,
            style: INPUT_STYLE,
            value: limit,
            onChange: (e) => {
              const raw = e.target.value;
              const parsed = raw === "" ? 0 : Number.parseInt(raw, 10);
              set("maxConcurrency", Number.isFinite(parsed) ? Math.min(64, Math.max(0, parsed)) : 0);
            },
          }),
          React.createElement(HelpText, {
            text: "同一父会话内该阶段同时在跑的上限；0 = 不限制。",
            detail: "按会话独立判定，多个会话各自计数、互不占用名额。没有「已创建总量」上限：新工作流一律新派自己的子代理，只有同一工作流的后续轮次才用 pipeline_followup 续用（不创建新子代理）。到上限时新派发会被拒——这是瞬时策略拒绝，不是阶段不可用，等有子代理结束、名额释放后在后续步骤重派即可。仍受宿主每个 run_code 程序最多 10 个并行子调用、以及每会话同时存活子代理上限的约束。",
          }),
          React.createElement("label", { style: LABEL_STYLE }, concurrencyStatus),
          reusableHint ? React.createElement("label", { style: LABEL_STYLE }, reusableHint) : null,
        ),
        React.createElement(
          "div",
          { style: ROW_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "墙钟预算（分钟）"),
          React.createElement("input", {
            type: "number",
            min: 0,
            max: 1440,
            step: 1,
            style: INPUT_STYLE,
            value: budgetMinutes,
            onChange: (e) => {
              const raw = e.target.value;
              const parsed = raw === "" ? 0 : Number.parseInt(raw, 10);
              set("budgetMinutes", Number.isFinite(parsed) ? Math.min(1440, Math.max(0, parsed)) : 0);
            },
          }),
          React.createElement(HelpText, {
            text: "单次派发的最长运行时间；0 = 不限制。",
            detail: "预算用到 80% 时先给运行中的子代理插一条「开始收尾」提醒；到 100% 中断它的当前回合（只结束回合，之后仍可用 pipeline_followup 续跑同一个子代理），并自动排队一份收尾报告（已完成 / 半成品 / 未完成 / 风险），供主代理决定续跑、拆分还是停止。只对之后的派发生效；续跑一个已停下的子代理会重新起算预算，给运行中的子代理插话不重置。",
          }),
          React.createElement("label", { style: LABEL_STYLE }, wallClockStatus),
        ),
      );
    }

    function PipelineSection(props) {
      // Slot renderers receive the file face via `inject()`; the settings
      // controller is provided by the registration's `inject` face.
      const { controller } = props;
      if (controller === void 0) return null;

      const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
      // 注意:官方 SettingsScope 的 store 订阅回调可能以无参形式通知(raf flush
      // 模式),直接把 setSnapshot 传给 subscribe 会让 snapshot 变成 undefined
      // 并在渲染时崩溃(TypeError: reading 'value')。这里显式取快照,并保留
      // (snapshot ?? {}) 防御。
      useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);

      const value = (snapshot ?? {}).value ?? {};
      const [stages, setStages] = useState(() => mergeStageDefaults(value.stages));
      const [options, setOptions] = useState({ providers: [] });
      const [saved, setSaved] = useState(false);
      const [optionsError, setOptionsError] = useState(false);
      const [status, setStatus] = useState({});
      const [followupMode, setFollowupMode] = useState(value.followupMode ?? "steer");
      const [compactionThresholdRatio, setCompactionThresholdRatio] = useState(value.compactionThresholdRatio ?? COMPACTION_THRESHOLD_FALLBACK);
      const [readWidenMinLines, setReadWidenMinLines] = useState(value.readWidenMinLines ?? READ_WIDEN_FALLBACK);

      useEffect(() => {
        setStages(mergeStageDefaults(value.stages));
        setFollowupMode(value.followupMode ?? "steer");
        setCompactionThresholdRatio(value.compactionThresholdRatio ?? COMPACTION_THRESHOLD_FALLBACK);
        setReadWidenMinLines(value.readWidenMinLines ?? READ_WIDEN_FALLBACK);
        setSaved(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [snapshot.revision]);

      useEffect(() => {
        let cancelled = false;
        fetch("/dsh-code-pipeline/options", { signal: AbortSignal.timeout(5000) })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
          .then((data) => {
            if (cancelled) return;
            setOptions(data && Array.isArray(data.providers) ? data : { providers: [] });
            setOptionsError(false);
          })
          .catch(() => {
            if (cancelled) return;
            setOptions({ providers: [] });
            setOptionsError(true);
          });
        return () => {
          cancelled = true;
        };
      }, []);

      // 并发状态轮询：显示各阶段当前运行 / 启动中的子代理数（端点不可用时
      // 静默降级为空对象，卡片仍显示配置的上限）。
      useEffect(() => {
        let cancelled = false;
        const load = () => {
          fetch("/dsh-code-pipeline/status", { signal: AbortSignal.timeout(5000) })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
            .then((data) => {
              if (!cancelled) setStatus(data && data.stages ? data.stages : {});
            })
            .catch(() => {
              if (!cancelled) setStatus({});
            });
        };
        load();
        const timer = setInterval(load, 5000);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, []);

      const setStage = useCallback((key, next) => {
        setStages((current) => ({ ...current, [key]: next }));
      }, []);

      const save = useCallback(async () => {
        await controller.set("stages", stages);
        await controller.set("followupMode", followupMode);
        await controller.set("compactionThresholdRatio", compactionThresholdRatio);
        await controller.set("readWidenMinLines", readWidenMinLines);
        setSaved(true);
      }, [controller, stages, followupMode, compactionThresholdRatio, readWidenMinLines]);

      const writable = (snapshot ?? {}).writable !== false;

      return React.createElement(
        "div",
        { style: CARD_STYLE },
        React.createElement("h3", { style: TITLE_STYLE }, "代码流水线"),
        React.createElement(
          "p",
          { style: INTRO_STYLE },
          "配置各阶段子代理的模型、并发上限与墙钟预算；保存后对下一次阶段派发生效，无需重启。",
        ),
        ...STAGE_ROWS.map((row) =>
          React.createElement(StageCard, {
            key: row.key,
            row,
            stage: stages[row.key],
            options,
            status: status[row.key],
            onChange: (next) => setStage(row.key, next),
          }),
        ),
        React.createElement(
          "div",
          { style: ROW_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "压缩触发比例"),
          React.createElement("input", {
            type: "number",
            min: COMPACTION_THRESHOLD_MIN,
            max: COMPACTION_THRESHOLD_MAX,
            step: 0.05,
            style: INPUT_STYLE,
            value: compactionThresholdRatio,
            disabled: !writable,
            onChange: (e) => {
              const raw = e.target.value;
              const parsed = raw === "" ? COMPACTION_THRESHOLD_FALLBACK : Number.parseFloat(raw);
              setCompactionThresholdRatio(Number.isFinite(parsed)
                ? Math.min(COMPACTION_THRESHOLD_MAX, Math.max(COMPACTION_THRESHOLD_MIN, parsed))
                : COMPACTION_THRESHOLD_FALLBACK);
            },
          }),
          React.createElement(HelpText, { text: COMPACTION_THRESHOLD_HINT, detail: COMPACTION_THRESHOLD_DETAIL }),
        ),
        React.createElement(
          "div",
          { style: ROW_STYLE },
          React.createElement(
            "label",
            { style: LABEL_STYLE },
            "子代理消息投递（pipeline_followup 的默认方式）",
          ),
          React.createElement(
            "select",
            {
              style: INPUT_STYLE,
              value: followupMode,
              disabled: !writable,
              onChange: (e) => setFollowupMode(e.target.value),
            },
            ...FOLLOWUP_MODES.map((option) =>
              React.createElement("option", { key: option.value, value: option.value }, option.label)),
          ),
          React.createElement(
            "label",
            { style: LABEL_STYLE },
            "插入：运行中的子代理在下一个模型步骤就收到；排队：当前回合结束后按顺序处理。",
          ),
        ),
        React.createElement(
          "div",
          { style: ROW_STYLE },
          React.createElement(
            "label",
            { style: LABEL_STYLE },
            "read 读取窗口下限（行）",
          ),
          React.createElement("input", {
            type: "number",
            min: READ_WIDEN_MIN,
            max: READ_WIDEN_MAX,
            step: 50,
            style: INPUT_STYLE,
            value: readWidenMinLines,
            disabled: !writable,
            onChange: (e) => {
              const raw = e.target.value;
              const parsed = raw === "" ? READ_WIDEN_FALLBACK : Number.parseInt(raw, 10);
              setReadWidenMinLines(Number.isFinite(parsed)
                ? Math.min(READ_WIDEN_MAX, Math.max(READ_WIDEN_MIN, parsed))
                : READ_WIDEN_FALLBACK);
            },
          }),
          React.createElement(HelpText, { text: READ_WIDEN_HINT, detail: READ_WIDEN_DETAIL }),
        ),
        optionsError
          ? React.createElement("p", { style: STATUS_STYLE }, "提示：无法获取 provider/模型列表（端点不可用），相应字段已禁用；可先保存当前值，稍后重试。")
          : null,
        React.createElement("button", { style: BUTTON_STYLE, onClick: save, disabled: !writable }, "保存"),
        saved ? React.createElement("p", { style: STATUS_STYLE }, "已保存（对下一次阶段派发生效）") : null,
      );
    }

    function apply(ctx) {
      // 配置表单按 Host 插件条目 id 寻址（bundle insert id = "dsh-code-pipeline"）。
      const controller = ctx.configForms.get("dsh-code-pipeline");
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "code-pipeline",
            order: 45,
            label: () => "代码流水线",
            inject: () => ({ controller }),
          },
          PipelineSection,
        ),
      );
    }

    return { inject, apply };
  },
});
