#!/usr/bin/env node
// War Loops - surgical critic. Turns the panel's per-signal scores + merged
// findings into a tight, prioritized repair plan: focus the 1-3 WEAKEST signals,
// keep only the most impactful findings, phrase them as precise directives.
// Replaces "dump every finding and rebuild" with "fix these few, surgically" -
// so each repair iteration moves forward instead of churning the whole page.
//
// Usage (standalone): node warloops/scripts/critic.mjs <eval.json> [--max-areas N] [--max-findings N]
// Library: import { planRepairs, repairBrief } from "./critic.mjs";
import fs from "node:fs";

const SEV = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function planRepairs(evalResult, { maxAreas = 3, maxFindings = 6 } = {}) {
  const signals = evalResult.signals || [];
  const findings = evalResult.findings || [];

  // Focus effort on the lowest-scoring signals.
  const weakest = [...signals].sort((a, b) => a.score - b.score).slice(0, maxAreas).map((s) => s.name);

  // Keep findings from the weak signals, plus any P0/P1 from anywhere.
  // Rank by severity first, then prefer findings tied to a weak signal.
  const rank = (f) => (SEV[f.severity] ?? 9) * 10 + (weakest.includes(f.signal) ? 0 : 5);
  const chosen = [...findings]
    .filter((f) => weakest.includes(f.signal) || f.severity === "P0" || f.severity === "P1")
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, maxFindings);

  const instructions = chosen.map((f) => `[${f.severity}] ${f.area}: ${f.fix}${f.observed ? `  (now: ${f.observed})` : ""}`);
  return { focus: weakest, count: chosen.length, instructions, findings: chosen };
}

export function repairBrief(evalResult, sourceRef, opts) {
  const plan = planRepairs(evalResult, opts);
  if (plan.count === 0) return null; // nothing actionable
  return [
    `Improve the wireframe mirror of "${sourceRef}" toward the ORIGINAL (attached first; current render second). Current fidelity ${evalResult.overallScore}/100; weakest areas: ${plan.focus.join(", ")}.`,
    `Fix ONLY these ${plan.count} issues, most impactful first. Do NOT rebuild, and do NOT touch parts that already match:`,
    "",
    ...plan.instructions.map((s) => `- ${s}`),
    "",
    "Then re-read the document (get_variables, snapshot_layout) and report { variables, regions, texts } as before.",
  ].join("\n");
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1];
  return a;
}

if (process.argv[2] && !process.argv[2].startsWith("--")) {
  const args = parseArgs(process.argv.slice(3));
  const ev = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
  const brief = repairBrief(ev, ev.source_ref || "the page", {
    maxAreas: args["max-areas"] ? +args["max-areas"] : undefined,
    maxFindings: args["max-findings"] ? +args["max-findings"] : undefined,
  });
  console.log(brief || "[critic] nothing actionable - fidelity is at target.");
}
