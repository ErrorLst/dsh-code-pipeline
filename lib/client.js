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
//   reasoningEffort / maxConcurrency) through the settingsScope service; the
//   host plugin's stage tools read the namespace at every call, so saving takes
//   effect immediately — the next subagent dispatch uses the new model and the
//   new concurrency cap, no dsh restart needed.
//
// Provider list + models are fetched from the host endpoint
// GET /dsh-code-pipeline/options (dsh host plugin). When the endpoint or a
// model list is unavailable, the fields degrade to free-text input.
// Live per-stage concurrency (running / pending / limit) comes from
// GET /dsh-code-pipeline/status and is polled every 5s while the card is open.

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-code-pipeline",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const STAGE_ROWS = [
      { key: "plan", label: "规划 Plan", hint: "只读研究并产出实施计划。只用于规划——不审查、不审计、不审批代码（deepseek-official / deepseek-v4-flash 默认）" },
      { key: "impl", label: "实现 Impl", hint: "完整工具面，按计划修改工作区（deepseek-official / deepseek-v4-flash 默认）" },
      { key: "review", label: "评审 Review", hint: "只读审计变更集，返回 APPROVED / CHANGES REQUIRED。只用于审查——不做规划、不做设计（deepseek-official / deepseek-v4-flash 默认）" },
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
    // deepseek-official / deepseek-v4-flash；思考等级留空 = 继承路由默认。
    const CLIENT_DEFAULT_STAGES = {
      plan: { enabled: true, provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "", maxConcurrency: 0 },
      impl: { enabled: true, provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "", maxConcurrency: 0 },
      review: { enabled: true, provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "", maxConcurrency: 0 },
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
      const concurrencyStatus =
        "当前运行 " + liveRunning + (livePending > 0 ? "（启动中 " + livePending + "）" : "")
        + " / 上限 " + (limit > 0 ? limit : "不限制");

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
          React.createElement("label", { style: LABEL_STYLE }, "最大并发子代理数"),
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
          React.createElement("label", { style: LABEL_STYLE }, "同一父会话内该阶段同时运行的子代理上限；0 = 不限制。仍受宿主每个 run_code 程序最多 10 个并行子调用的上限约束。"),
          React.createElement("label", { style: LABEL_STYLE }, concurrencyStatus),
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

      useEffect(() => {
        setStages(mergeStageDefaults(value.stages));
        setFollowupMode(value.followupMode ?? "steer");
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
        setSaved(true);
      }, [controller, stages, followupMode]);

      const writable = (snapshot ?? {}).writable !== false;

      return React.createElement(
        "div",
        { style: CARD_STYLE },
        React.createElement("h3", { style: TITLE_STYLE }, "代码流水线"),
        React.createElement(
          "p",
          { style: INTRO_STYLE },
          "配置 code-pipeline 预设各阶段子代理的模型与并发上限。保存后对下一次阶段派发生效（工具每次调用时读取设置，无需重启 dsh）。任一阶段关闭后，对应阶段工具调用会直接报错。最大并发 = 同一父会话内该阶段同时运行的子代理数上限（0 = 不限制）；调低不会中断正在运行的子代理，只拦截后续派发；独立目标可在一个程序里并行派发多个阶段子代理以加快进度。",
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
