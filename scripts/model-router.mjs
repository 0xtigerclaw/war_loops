// War Loops - model router.
//
// One place to decide which model runs each ROLE in the pipeline, and the only
// place that knows how to turn that into CLI flags. Both the orchestrator (the
// Pencil build/repair agent) and the vision signal (the claude judge) read from
// here, so swapping a model is a config edit or an env var, never a code change.
//
// Roles:
//   build    - the Pencil design + repair agent. The dominant cost. Route it to
//              a cheaper or different-provider model to trade cost for fidelity.
//   readback - the cheap structured read-back of the built doc (no design work).
//   judge    - the vision fidelity signal (the `claude` CLI).
//
// Source of truth: models.config.json. Per-role env overrides win, for quick
// one-off swaps without editing the file:
//   WARLOOPS_BUILD_MODEL, WARLOOPS_READBACK_MODEL, WARLOOPS_JUDGE_MODEL
//
// Defaults reproduce the original behavior exactly (Pencil --agent claude, and
// the claude CLI default), so an empty/again-default config changes nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.WARLOOPS_MODELS_CONFIG || path.join(__dirname, "..", "models.config.json");

function loadRoutes() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).roles || {}; }
  catch { return {}; }
}

// Resolve a role to { engine, agent, model, effort }, applying env overrides.
export function routeFor(role) {
  const r = { ...(loadRoutes()[role] || {}) };
  const envModel = process.env[`WARLOOPS_${role.toUpperCase()}_MODEL`];
  if (envModel) r.model = envModel;
  return r;
}

const hasModel = (r) => r.model && r.model !== "default" && r.model !== "auto";

// Pencil CLI flags for a role. Pencil infers the provider from the model id
// (claude-*, gpt-*, gemini-*); with no model it falls back to --agent.
export function pencilModelArgs(role) {
  const r = routeFor(role);
  const args = hasModel(r) ? ["--model", r.model] : ["--agent", r.agent || "claude"];
  if (r.effort) args.push("--effort", r.effort);
  return args;
}

// claude CLI flags for a role. No model id => use the CLI default (no flag).
export function claudeModelArgs(role) {
  const r = routeFor(role);
  return hasModel(r) ? ["--model", r.model] : [];
}

// Human-readable label of what a role will actually run (for logs / metrics).
export function routeLabel(role) {
  const r = routeFor(role);
  return hasModel(r) ? r.model : `${r.engine || "?"}:${r.agent || "default"}`;
}
