// The complete inventory of Host surfaces this plugin touches.
//
// Why a declarative list instead of ad-hoc ctx.get(...) calls: a dsh update that
// renames a service, drops a method or renames an event used to fail SILENTLY
// (the stage tools simply never appeared, or a settings value was never written).
// lib/host.js probes this table at startup and `/dsh-code-pipeline/status`
// reports it, so a host rename surfaces as one WARN naming the exact surface.
//
// The smoke test additionally asserts that the ids here are exactly the ids the
// code asks for (getService / onHost call sites in lib/index.js), so adding a new
// host dependency without registering it here fails the test rather than drifting.
//
// `required` semantics:
//   - service: cannot be absent AND cannot lose its required methods, or the
//     plugin's core job (injecting stage tools / dispatching children) is dead.
//   - optional services degrade to one missing feature; absence is NOT a failure,
//     but a present service whose required methods vanished IS one (shape drift).
export const HOST_CONTRACT = [
  { id: "agents", kind: "service", required: true, since: "0.1.x",
    why: "get() / roots() / isOwnedBy() — ROOT-agent check and live-agent lookup" },
  { id: "agentPresets", kind: "service", required: true, since: "0.1.x",
    why: "composedPreset() / serviceFor() — preset attribution and the realm-private compaction service" },
  { id: "subagents", kind: "service", required: true, since: "0.1.x",
    why: "startContinuable / sendMessage / prompt / getProvider / listChildren / interrupt — stage dispatch and continuation" },
  { id: "tools", kind: "service", required: true, since: "0.1.x", scope: "agent",
    why: "register() — injecting the stage tools into a code-pipeline agent (resolved from the AGENT's ctx, not the plugin ctx; covered by the injection counters)" },
  { id: "settings", kind: "service", required: false, since: "0.1.7",
    why: "get() / describe() — the host's live-subagent limit shown in the settings card" },
  { id: "webServer", kind: "service", required: false, since: "0.1.x",
    why: "register() — the /dsh-code-pipeline/options and /status endpoints" },
  { id: "llm", kind: "service", required: false, since: "0.1.x",
    why: "listProviders / listModels / resolveModelInfo — provider+model+effort options in the settings card" },
  { id: "configEditor", kind: "service", required: false, since: "0.1.7",
    why: "entries() / edit() — writing the compaction threshold into the preset declaration" },

  { id: "agent/created", kind: "event", required: true, since: "0.1.x",
    why: "the primary injection trigger" },
  { id: "agent-preset/selected", kind: "event", required: true, since: "0.1.x",
    why: "re-injection when a session switches to the code-pipeline preset" },
  { id: "agent/request", kind: "event", required: true, since: "0.1.x",
    why: "request-time injection fallback + per-stage reasoningEffort waterfall" },
  { id: "subagent/provider-added", kind: "event", required: false, since: "0.1.x",
    why: "defers injection until the spawn provider is registered" },
  { id: "subagent/start", kind: "event", required: false, since: "0.1.x",
    why: "invalidates the previous envelope when a child is reactivated" },
  { id: "subagent/end", kind: "event", required: true, since: "0.1.x",
    why: "parses the structured envelope, releases the running slot and advances the wall-clock phase" },
  { id: "agent/disposed", kind: "event", required: false, since: "0.1.x",
    why: "drops the concurrency ledger of a destroyed parent" },
  { id: "tools/execute", kind: "event", required: false, since: "0.1.x",
    why: "pre-execution read-window widening" },
  { id: "tools/post-execute", kind: "event", required: false, since: "0.1.x",
    why: "incremental-read hygiene notice" },
  { id: "loader/volatile-update", kind: "event", required: false, since: "0.1.7",
    why: "debounced re-write of the compaction threshold after a settings change" },
];

/**
 * Method shapes probed per service.
 *   required — absent => the surface is reported as broken (ok:false) and WARNed.
 *   optional — absent => reported as a degradation in the check detail only
 *              (the code already has a documented fallback for each of these).
 */
export const SERVICE_SHAPES = {
  agents: { required: ["get", "roots", "isOwnedBy"], optional: [] },
  agentPresets: { required: ["composedPreset", "serviceFor"], optional: [] },
  subagents: {
    required: ["startContinuable", "sendMessage", "getProvider"],
    optional: ["prompt", "listChildren", "interrupt"],
  },
  tools: { required: ["register"], optional: ["restrict"] },
  settings: { required: [], optional: ["get", "describe", "update"] },
  webServer: { required: ["register"], optional: [] },
  llm: { required: [], optional: ["listProviders", "listModels", "resolveModelInfo"] },
  configEditor: { required: [], optional: ["entries", "edit"] },
};
