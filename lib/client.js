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
// free-text. The card renders configuration only.
//
// Layout discipline: no prose. Each stage is ONE card and its fields sit in a
// responsive CSS grid (provider / model / effort / concurrency / budget flow
// side by side) instead of five full-width vertical rows; the global settings
// are one more card. Only field labels and inputs are rendered — there is no
// intro paragraph, no hint / <details> explanation block, and no live status.
//
// Save feedback: the button itself flips to 保存中… / 已保存 ✓ / 重试保存 for a
// few seconds, mirrored by an aria-live status line. The saved flag is NOT
// cleared by the configForms revision echo — the echo is exactly what used to
// erase the feedback before the user could see it.

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-code-pipeline",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, useCallback, useRef } = React;

    const STAGE_ROWS = [
      { key: "plan", label: "规划 Plan" },
      { key: "impl", label: "实现 Impl" },
      { key: "review", label: "评审 Review" },
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


    // read 读取窗口下限（readWidenMinLines）的客户端兜底：与插件 Config 同默认（200）。
    const READ_WIDEN_FALLBACK = 200;
    const READ_WIDEN_MIN = 0;
    const READ_WIDEN_MAX = 2000;


    const CARD_STYLE = {
      maxWidth: "720px",
      color: "var(--dsw-alias-label-primary)",
      display: "flex",
      flexDirection: "column",
      gap: "14px",
    };
    const TITLE_STYLE = { margin: 0, fontSize: "16px", fontWeight: 500, lineHeight: "24px" };
    // 字段网格：每张卡片里横向铺开，窄屏自动降到 2 列 / 1 列——不再全部竖排。
    const FIELD_GRID_STYLE = {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
      gap: "10px 14px",
      alignItems: "start",
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
    const ROW_STYLE = { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 };
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
      wordBreak: "break-word",
    };
    const SAVE_ROW_STYLE = { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" };
    const FEEDBACK_STYLE = {
      margin: 0,
      fontSize: "12px",
      lineHeight: "18px",
      color: "var(--dsw-alias-state-success-primary)",
    };
    const FEEDBACK_ERROR_STYLE = {
      margin: 0,
      fontSize: "12px",
      lineHeight: "18px",
      color: "var(--dsw-alias-state-error-primary)",
    };


    function StageCard({ row, stage, options, onChange }) {
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

      const limit = Number.isFinite(stage.maxConcurrency) ? Math.max(0, Math.trunc(stage.maxConcurrency)) : 0;
      const budgetMinutes = Number.isFinite(stage.budgetMinutes) ? Math.max(0, Math.trunc(stage.budgetMinutes)) : 0;

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
        React.createElement(
          "div",
          { style: FIELD_GRID_STYLE },
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
          ),
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
      const [saveState, setSaveState] = useState("idle");
      const savedTimer = useRef(null);
      const [optionsError, setOptionsError] = useState(false);
      const [followupMode, setFollowupMode] = useState(value.followupMode ?? "steer");
      const [compactionThresholdRatio, setCompactionThresholdRatio] = useState(value.compactionThresholdRatio ?? COMPACTION_THRESHOLD_FALLBACK);
      const [readWidenMinLines, setReadWidenMinLines] = useState(value.readWidenMinLines ?? READ_WIDEN_FALLBACK);

      useEffect(() => {
        setStages(mergeStageDefaults(value.stages));
        setFollowupMode(value.followupMode ?? "steer");
        setCompactionThresholdRatio(value.compactionThresholdRatio ?? COMPACTION_THRESHOLD_FALLBACK);
        setReadWidenMinLines(value.readWidenMinLines ?? READ_WIDEN_FALLBACK);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [snapshot.revision]);

      // 保存反馈计时器：卸载时清掉，避免卸载后 setState。
      useEffect(() => () => {
        if (savedTimer.current !== null) clearTimeout(savedTimer.current);
      }, []);

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

      const setStage = useCallback((key, next) => {
        setStages((current) => ({ ...current, [key]: next }));
      }, []);

      const save = useCallback(async () => {
        if (savedTimer.current !== null) {
          clearTimeout(savedTimer.current);
          savedTimer.current = null;
        }
        setSaveState("saving");
        try {
          await controller.set("stages", stages);
          await controller.set("followupMode", followupMode);
          await controller.set("compactionThresholdRatio", compactionThresholdRatio);
          await controller.set("readWidenMinLines", readWidenMinLines);
          setSaveState("saved");
          savedTimer.current = setTimeout(() => {
            savedTimer.current = null;
            setSaveState("idle");
          }, 2500);
        } catch (error) {
          setSaveState("error");
        }
      }, [controller, stages, followupMode, compactionThresholdRatio, readWidenMinLines]);

      const writable = (snapshot ?? {}).writable !== false;

      const saving = saveState === "saving";
      const saveLabel = saving ? "保存中…" : saveState === "saved" ? "已保存 ✓" : saveState === "error" ? "重试保存" : "保存";
      const buttonStyle = {
        ...BUTTON_STYLE,
        alignSelf: "center",
        opacity: !writable || saving ? 0.6 : 1,
        cursor: !writable || saving ? "default" : "pointer",
      };

      return React.createElement(
        "div",
        { style: CARD_STYLE },
        React.createElement("h3", { style: TITLE_STYLE }, "代码流水线"),
        ...STAGE_ROWS.map((row) =>
          React.createElement(StageCard, {
            key: row.key,
            row,
            stage: stages[row.key],
            options,
            onChange: (next) => setStage(row.key, next),
          }),
        ),
        React.createElement(
          "section",
          { style: STAGE_STYLE },
          React.createElement("h4", { style: STAGE_TITLE_STYLE }, "全局"),
          React.createElement(
            "div",
            { style: FIELD_GRID_STYLE },
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
            ),
            React.createElement(
              "div",
              { style: ROW_STYLE },
              React.createElement("label", { style: LABEL_STYLE }, "子代理消息投递（pipeline_followup）"),
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
            ),
            React.createElement(
              "div",
              { style: ROW_STYLE },
              React.createElement("label", { style: LABEL_STYLE }, "read 读取窗口下限（行）"),
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
            ),
          ),
        ),
        optionsError
          ? React.createElement("p", { style: STATUS_STYLE }, "无法获取 provider/模型列表（端点不可用），相应字段已禁用；可先保存当前值，稍后重试。")
          : null,
        React.createElement(
          "div",
          { style: SAVE_ROW_STYLE, "aria-live": "polite" },
          React.createElement("button", { style: buttonStyle, onClick: save, disabled: !writable || saving }, saveLabel),
          saveState === "saved"
            ? React.createElement("span", { style: FEEDBACK_STYLE }, "已保存，对下一次阶段派发生效")
            : null,
          saveState === "error"
            ? React.createElement("span", { style: FEEDBACK_ERROR_STYLE }, "保存失败，请重试")
            : null,
        ),
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
