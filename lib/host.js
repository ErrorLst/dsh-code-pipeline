// Host-surface adapter: every ctx.get / ctx.on the plugin performs goes through
// here.
//
// Two jobs:
//   1. `getService` / `onHost` never throw. A host that renamed a service or
//      refuses an event registration must not take the plugin (or the host's own
//      boot / request path) down with it — the caller sees `undefined` / a
//      `{ok:false}` receipt and decides.
//   2. `probeHost` turns "the host changed shape" from a silent no-op into one
//      reportable check per surface. `apply` logs it once at startup and
//      /dsh-code-pipeline/status serves the same table to the settings card.
import { HOST_CONTRACT, SERVICE_SHAPES } from "./host-contract.js";

/** Read one host service; returns undefined instead of throwing on shape drift. */
export function getService(ctx, id) {
  try {
    const value = ctx?.get?.(id);
    return value === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}

/** method presence probe that survives throwing getters/proxies. */
function hasMethod(value, name) {
  try {
    return typeof value?.[name] === "function";
  } catch {
    return false;
  }
}

/**
 * Probe every service in the contract. Never throws.
 *
 * Returns `[{ id, kind, required, present, ok, missingMethods, degradedMethods }]`
 * — `ok` means "the plugin can still do its job through this surface":
 *   - required service absent, or a required method missing => false
 *   - optional service absent => true (documented degradation; reported via `present:false`)
 *   - present but a required method missing => false
 */
export function probeHost(ctx, contract = HOST_CONTRACT) {
  const checks = [];
  for (const row of contract) {
    if (row.kind !== "service") continue;
    if (row.scope === "agent") {
      // Agent-scoped surface (the per-agent tools registry): there is no plugin-ctx
      // service to probe. Its health is observable through the injection counters,
      // so report it as "not probed here" rather than as a false failure.
      checks.push({
        id: row.id,
        kind: row.kind,
        required: row.required === true,
        present: undefined,
        ok: true,
        missingMethods: [],
        degradedMethods: [],
        detail: "agent-scoped — covered by the injection counters",
      });
      continue;
    }
    const value = getService(ctx, row.id);
    const shapes = SERVICE_SHAPES[row.id] ?? { required: [], optional: [] };
    const present = value !== undefined;
    const missingMethods = present ? shapes.required.filter((name) => !hasMethod(value, name)) : [];
    const degradedMethods = present ? shapes.optional.filter((name) => !hasMethod(value, name)) : [];
    let ok;
    if (!present) ok = row.required !== true;
    else ok = missingMethods.length === 0;
    checks.push({
      id: row.id,
      kind: row.kind,
      required: row.required === true,
      present,
      ok,
      missingMethods,
      degradedMethods,
    });
  }
  return checks;
}

/**
 * Register one host event. Returns `{ ok: true }` or `{ ok: false, error }`
 * instead of throwing, so a host that renamed an event shows up in the startup
 * self-check instead of taking down apply().
 */
export function onHost(carrier, event, handler, options) {
  try {
    if (carrier === undefined || carrier === null || typeof carrier.on !== "function") {
      return { ok: false, error: new Error(`carrier has no on() for "${event}"`) };
    }
    carrier.on(event, handler, options);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** One human-readable line per broken/degraded check; [] when everything is fine. */
export function describeHostChecks(checks) {
  return checks
    .filter((check) => check.ok === false || check.missingMethods.length > 0)
    .map((check) => {
      const parts = [check.id];
      if (check.present === false) parts.push(`missing (${check.required ? "required" : "optional"})`);
      if (check.missingMethods.length > 0) parts.push(`missing methods: ${check.missingMethods.join(", ")}`);
      return parts.join(": ");
    });
}
