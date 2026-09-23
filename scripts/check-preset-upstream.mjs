// Drift check: does this bundle's agent preset still match the dsh it is
// installed into?
//
// Why it exists: the preset is copied from the host's built-in `ptc` preset, and a
// single row that no longer resolves fails the WHOLE preset mount — the session
// then refuses to resume (`row "..." names a plugin that cannot be resolved`, the
// 0.1.6 workflow-worker-thread -> workflow-ptc rename being the canonical case).
// Run this after every dsh upgrade, before the user hits that:
//
//   node scripts/check-preset-upstream.mjs            # human report
//   node scripts/check-preset-upstream.mjs --json     # machine report
//   node scripts/check-preset-upstream.mjs --dsh <dsh-root>
//
// Exits 1 when a declared package cannot be resolved in the installed dsh tree, or
// when upstream ptc gained a row this preset does not carry.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const PLUGIN_PRESET = join(REPO_ROOT, "preset", "code-pipeline", "agent.cordis.yml");
const UPSTREAM_RELATIVE = join("node_modules", "@deepseek-ai", "dsh-web-app", "presets", "ptc.patch.yml");

/** Recursively collect `{ id, name, disabled }` from a preset row list (groups nest under `config`). */
export function collectRows(rows, out = new Map()) {
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const id = typeof row.id === "string" ? row.id : undefined;
    if (id !== undefined && !out.has(id)) {
      out.set(id, { name: typeof row.name === "string" ? row.name : undefined, disabled: row.disabled === true });
    }
    if (Array.isArray(row.config)) collectRows(row.config, out);
  }
  return out;
}

/** True for names that must resolve to an installed package (everything except cordis:groups). */
function isPackageName(name) {
  return typeof name === "string" && name.length > 0 && !name.startsWith("cordis:");
}

/**
 * Pure comparison — the test drives this with synthetic presets.
 * `isResolvable(name) => boolean` answers "is this package installed in the host tree?".
 *
 * Errors (exit 1):
 *   - `unresolvable`    a declared package installs nothing => the whole preset fails to mount.
 *   - `missingUpstream` an upstream row that is ENABLED upstream is absent here => lost capability.
 * Informational (exit 0):
 *   - `upstreamDisabledOnly` upstream carries the row but disabled it; omitting it loses nothing.
 *   - `disabledDrift`        a shared row whose disabled flag differs from upstream.
 *   - `extraLocal`           rows this preset adds or keeps for the pipeline itself.
 */
export function comparePresetRows({ pluginRows, upstreamRows, isResolvable }) {
  const unresolvable = [];
  for (const [id, row] of pluginRows) {
    if (!isPackageName(row.name)) continue;
    if (!isResolvable(row.name)) unresolvable.push({ id, name: row.name });
  }
  const missingUpstream = [];
  const upstreamDisabledOnly = [];
  for (const [id, row] of upstreamRows) {
    if (pluginRows.has(id)) continue;
    if (row.disabled) upstreamDisabledOnly.push({ id, name: row.name });
    else missingUpstream.push({ id, name: row.name });
  }
  const disabledDrift = [];
  for (const [id, row] of pluginRows) {
    const upstream = upstreamRows.get(id);
    if (upstream === undefined) continue;
    if (upstream.disabled !== row.disabled) disabledDrift.push({ id, upstreamDisabled: upstream.disabled, localDisabled: row.disabled });
  }
  const extraLocal = [];
  for (const [id] of pluginRows) {
    if (!upstreamRows.has(id)) extraLocal.push(id);
  }
  return {
    ok: unresolvable.length === 0 && missingUpstream.length === 0,
    unresolvable,
    missingUpstream,
    upstreamDisabledOnly,
    disabledDrift,
    extraLocal,
  };
}

/** Locate the installed dsh tree. Order: --dsh / DSH_ROOT, DSH_HOME profile, global node_modules. */
function resolveDshRoot(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.DSH_ROOT) candidates.push(process.env.DSH_ROOT);
  const profilesDir = join(process.env.DSH_HOME || join(process.env.HOME || "", ".dsh"), "profiles");
  if (existsSync(profilesDir)) {
    for (const profile of readdirSafe(profilesDir)) {
      const require = createRequire(join(profilesDir, profile, "package.json"));
      try {
        candidates.push(dirname(require.resolve("@deepseek-ai/dsh/package.json")));
      } catch {
        /* not resolvable through this profile */
      }
      try {
        // Fallback: the host's own dependency carries the built-in preset; strip
        // <dsh>/node_modules/@deepseek-ai/dsh-web-app/package.json back to <dsh>.
        const webApp = require.resolve("@deepseek-ai/dsh-web-app/package.json");
        candidates.push(dirname(dirname(dirname(dirname(webApp)))));
      } catch {
        /* profile without the host packages: try the next one */
      }
    }
  }
  // Global install layout: <root>/node_modules/@deepseek-ai/dsh
  candidates.push("/usr/local/lib/node_modules/@deepseek-ai/dsh");
  candidates.push("/usr/lib/node_modules/@deepseek-ai/dsh");
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (root) candidates.push(join(root, "@deepseek-ai", "dsh"));
  } catch {
    /* npm unavailable: the explicit/profile paths are enough */
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    // Accept either the dsh package dir or its parent.
    const asDsh = existsSync(join(candidate, "package.json")) && existsSync(join(candidate, UPSTREAM_RELATIVE))
      ? candidate
      : existsSync(join(candidate, "node_modules", "@deepseek-ai", "dsh", UPSTREAM_RELATIVE))
        ? join(candidate, "node_modules", "@deepseek-ai", "dsh")
        : undefined;
    if (asDsh !== undefined) return asDsh;
  }
  return undefined;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Is `name` installed next to the dsh package (host deps) or beside it (@deepseek-ai/*)? */
export function makeResolver(dshRoot) {
  return (name) => {
    const root = packageRootOf(name);
    const candidates = [
      join(dshRoot, "node_modules", root, "package.json"),
      join(dirname(dirname(dshRoot)), root, "package.json"),
      join(dirname(dshRoot), root, "package.json"),
    ];
    return candidates.some((path) => existsSync(path));
  };
}

/** Read a preset row list out of either the raw composition or a generated patch. */
export function readPresetRows(text, file) {
  const parsed = parse(text, { logLevel: "silent" });
  const entries = Array.isArray(parsed) ? parsed : [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    for (const row of Array.isArray(entry.insert) ? entry.insert : []) {
      const plugins = row?.config?.plugins;
      if (Array.isArray(plugins)) return plugins;
    }
  }
  // No `insert` patch shape: the document IS the raw row list (agent.cordis.yml).
  if (Array.isArray(parsed)) return parsed;
  throw new Error(`cannot locate a preset row list in ${file}`);
}

/** Package root of a row name: strips a subpath export (`@scope/pkg/sub` -> `@scope/pkg`). */
export function packageRootOf(name) {
  const parts = String(name).split("/");
  if (String(name).startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0];
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const dshFlag = args.indexOf("--dsh");
  const explicit = dshFlag === -1 ? undefined : args[dshFlag + 1];

  if (!existsSync(PLUGIN_PRESET)) {
    console.error(`[check-preset] plugin preset missing at ${PLUGIN_PRESET}`);
    process.exitCode = 1;
    return;
  }
  const dshRoot = resolveDshRoot(explicit);
  if (dshRoot === undefined) {
    console.error(
      "[check-preset] cannot locate the installed dsh tree. Pass --dsh <path-to-@deepseek-ai/dsh> "
      + "or set DSH_ROOT. NOTE: a failure to locate the host is reported as an error on purpose — "
      + "silently passing here would hide a real drift.",
    );
    process.exitCode = 1;
    return;
  }
  const upstreamPath = join(dshRoot, UPSTREAM_RELATIVE);

  const pluginRows = collectRows(readPresetRows(readFileSync(PLUGIN_PRESET, "utf8"), PLUGIN_PRESET));
  const upstreamRows = collectRows(readPresetRows(readFileSync(upstreamPath, "utf8"), upstreamPath));
  const result = comparePresetRows({ pluginRows, upstreamRows, isResolvable: makeResolver(dshRoot) });

  if (json) {
    console.log(JSON.stringify({ dshRoot, upstreamPath, pluginRows: pluginRows.size, upstreamRows: upstreamRows.size, ...result }, null, 2));
  } else {
    console.log(`[check-preset] dsh: ${dshRoot}`);
    console.log(`[check-preset] ${pluginRows.size} preset rows vs ${upstreamRows.size} upstream ptc rows`);
    for (const row of result.unresolvable) {
      console.error(`  ✗ unresolvable package: row "${row.id}" names ${row.name} — the whole preset would fail to mount; update preset/code-pipeline/agent.cordis.yml and re-run scripts/build-preset.mjs`);
    }
    for (const row of result.missingUpstream) {
      console.error(`  ✗ upstream row missing here: "${row.id}"${row.name ? ` (${row.name})` : ""} — the built-in ptc preset ENABLES it; decide whether the pipeline should carry it`);
    }
    for (const row of result.upstreamDisabledOnly) {
      console.log(`  · upstream has "${row.id}" but disabled it — omitting it here loses nothing`);
    }
    for (const row of result.disabledDrift) {
      console.log(`  · disabled-flag drift on "${row.id}": upstream=${row.upstreamDisabled} local=${row.localDisabled}`);
    }
    if (result.extraLocal.length > 0) {
      console.log(`  · local-only rows (expected, informational): ${result.extraLocal.join(", ")}`);
    }
    console.log(result.ok ? "[check-preset] OK" : "[check-preset] DRIFT DETECTED (see above)");
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
