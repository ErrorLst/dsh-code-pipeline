// @dsh-external/dsh-code-pipeline — browser half.
//
// Registered through the client-modules system: this bundle is served at
// `/plugins/@dsh-external/dsh-code-pipeline/client.js`, executed once to
// register a factory under `window.__ModuleLoader__`, and materialized
// lazily. The factory returns the Cordis client plugin (`inject` + `apply`),
// which registers one piece of UI:
//
//   settings.section — "代码流水线" card in the settings page. It edits the
//   "code-pipeline" settings namespace (per-stage provider / model / enabled /
//   reasoningEffort / maxConcurrency / budgetMinutes, plus followupMode and
//   compactionThresholdRatio) through the settingsScope
//   service; the host plugin's stage tools read the namespace at every call, so
//   saving takes effect immediately — the next subagent dispatch uses the new
//   model, the new concurrency cap and the new wall-clock budget, no dsh restart
//   needed.
//
// Provider list + models are fetched from the host endpoint
// GET /dsh-code-pipeline/options (dsh host plugin). When the endpoint or a
// model list is unavailable, the fields degrade to free-text input.
// Live per-stage concurrency (running / pending / limit) plus wall-clock facts
// (budget / longest running / timed-out count) come from
// GET /dsh-code-pipeline/status and are polled every 5s while the card is open.
//
// maxConcurrency 是双层语义（宿主 lib/index.js 一侧执行，本卡片只负责如实展示）：
//   (1) 同时运行的子代理上限；(2) 同一父会话内该阶段「已创建（含已结束）」子代理的
//   总量上限。到达「已创建」总量上限后，新的阶段派发会被宿主直接拒绝，错误里给出可
//   复用的子代理清单 —— 出路是用 pipeline_followup 复用已有子代理（不带 `compact` 地投递、
//   接受干扰；`compact: true` 对已 settle 的子代理不可用——唤醒也救不了），而不是等待
//   一个跑完后再派新的。0 = 不限制。
// status.stages[key].created（已创建数）与 status.stages[key].available（可复用子
// 代理数组，元素 { id, label, activity }）由宿主并行开发：两者都可能缺失，缺失时
// 静默降级（不显示该半句、不渲染 undefined）。

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-code-pipeline",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const STAGE_ROWS = [
      { key: "plan", label: "规划 Plan", hint: "只读研究并产出实施计划。只用于规划——不审查、不审计、不审批代码（deepseek-official / deepseek-flash 默认）" },
      { key: "impl", label: "实现 Impl", hint: "完整工具面，按计划修改工作区（deepseek-official / deepseek-flash 默认）" },
      { key: "review", label: "评审 Review", hint: "只读审计变更集，返回 APPROVED / CHANGES REQUIRED。只用于审查——不做规划、不做设计（deepseek-official / deepseek-flash 默认）" },
    ];

    // 只声明真正使用的服务：connection / remote 从未用到，多余声明会让宿主
    // 客户端服务一旦缺失/改名就整块设置卡片静默不激活。
    const inject = ["slots", "settingsScope"];

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

    // 压缩触发比例的客户端兜底默认值（与宿主 SettingsSchema 的默认同值：0.5 =
    // 约 50 万 token 触发，保留量自动取阈值的 1/5）。宿主把它写进已安装的预设
    // 组合，所以改动的生效时机是「之后挂载的代理」——描述里写清这一点。
    const COMPACTION_THRESHOLD_FALLBACK = 0.5;
    const COMPACTION_THRESHOLD_MIN = 0.05;
    const COMPACTION_THRESHOLD_MAX = 0.8;
    const COMPACTION_THRESHOLD_HINT =
      "上下文达到该比例（相对模型窗口）时自动压缩历史，保留量自动取阈值的 1/5。默认 0.5 ≈ 50 万 token（实测 446 个会话中仅 18 个会触发）；调低会更省上下文重发成本，但更快丢掉细节记忆并放弃前缀缓存。改动写入预设组合，对新派发的阶段子代理和新会话生效（当前主会话需重选一次预设或重启 dsh）。";

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
      const concurrencyStatus =
        "当前运行 " + liveRunning + (livePending > 0 ? "（启动中 " + livePending + "）" : "")
        + " / 上限 " + (limit > 0 ? limit : "不限制")
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
        : "可复用子代理（优先 pipeline_followup 复用，勿新派）："
          + reusableLabels.slice(0, reusableHintMax).join("、")
          + (reusableLabels.length > reusableHintMax ? " 等 " + reusableLabels.length + " 个" : "");

      // 墙钟预算：0 = 不限制；状态里的「最早已运行 / 已超时」来自 /dsh-code-pipeline/status
      // （端点不可用时只显示配置值，不报错）。
      const budgetMinutes = Number.isFinite(stage.budgetMinutes) ? Math.max(0, Math.trunc(stage.budgetMinutes)) : 0;
      const liveTimedOut = Number.isFinite(status?.timedOut) ? status.timedOut : 0;
      const liveLongestMs = Number.isFinite(status?.longestRunningMs) ? status.longestRunningMs : 0;
      const wallClockStatus =
        "墙钟预算 " + (budgetMinutes > 0 ? budgetMinutes + " 分钟" : "不限制")
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
        React.createElement("p", { style: STAGE_HINT_STYLE }, row.hint),
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
          React.createElement("label", { style: LABEL_STYLE }, "按该模型实际支持列出（如 deepseek：off/low/high/max；GLM-5.3：low/high/max）；留空 = 继承 provider 路由级默认"),
        ),
        React.createElement(
          "div",
          { style: ROW_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "最大并发子代理数（含已创建）"),
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
          React.createElement("label", { style: LABEL_STYLE }, "同一父会话内该阶段同时运行的子代理上限，同时也是该阶段「已创建（含已结束）」子代理的总量上限。到达已创建总量上限后，新的阶段派发会被拒绝；请用 pipeline_followup 复用已有子代理（有干扰时可先压缩再复用）。0 = 不限制。仍受宿主每个 run_code 程序最多 10 个并行子调用的上限约束。"),
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
          React.createElement("label", { style: LABEL_STYLE }, "该阶段单次派发的最长运行时间；0 = 不限制。预算用到 80% 时先给运行中的子代理插一条「开始收尾」警告；到 100% 则中断该子代理（只结束当前回合，Activation 与 inbox 保留，之后仍可用 pipeline_followup 续跑），并自动排队一条收尾报告指令，让它汇报「已完成 / 半成品 / 未完成 / 风险 / 建议」，供主代理决定续跑、拆分还是停止。只对之后的派发生效；续跑（pipeline_followup）一个已停下的子代理会重新起算预算，给运行中的子代理插话不重置。"),
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

      useEffect(() => {
        setStages(mergeStageDefaults(value.stages));
        setFollowupMode(value.followupMode ?? "steer");
        setCompactionThresholdRatio(value.compactionThresholdRatio ?? COMPACTION_THRESHOLD_FALLBACK);
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
        setSaved(true);
      }, [controller, stages, followupMode, compactionThresholdRatio]);

      const writable = (snapshot ?? {}).writable !== false;

      return React.createElement(
        "div",
        { style: CARD_STYLE },
        React.createElement("h3", { style: TITLE_STYLE }, "代码流水线"),
        React.createElement(
          "p",
          { style: INTRO_STYLE },
          "配置各阶段子代理的模型、并发上限与墙钟预算；保存后对下一次阶段派发生效，无需重启；阶段关闭后其工具调用会直接报错。最大并发按 (父会话 × 阶段) 计「同时运行」与「已创建总量」两层，调低只拦后续派发、不中断在跑的子代理。墙钟预算 = 单次派发的最长运行时间；超时自动中断并索取收尾报告，供主代理决定续跑 / 拆分 / 停止。",
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
          React.createElement("label", { style: LABEL_STYLE }, COMPACTION_THRESHOLD_HINT),
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
            "插入：运行中的子代理在下一个模型步骤就收到消息（不排队）；排队：当前回合结束后按顺序处理。",
          ),
        ),
        optionsError
          ? React.createElement("p", { style: STATUS_STYLE }, "提示：无法获取 provider/模型列表（端点不可用），相应字段已禁用；可先保存当前值，稍后重试。")
          : null,
        React.createElement("button", { style: BUTTON_STYLE, onClick: save, disabled: !writable }, "保存"),
        saved ? React.createElement("p", { style: STATUS_STYLE }, "已保存（对下一次阶段派发生效）") : null,
      );
    }

    function apply(ctx) {
      const controller = ctx.settingsScope.bind({ namespace: "code-pipeline" });
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
