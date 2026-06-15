#!/usr/bin/env node
// War Loops - fidelity aggregator. Runs the enabled signal panel, blends a
// weighted overall score, and returns a decision. Replaces the single-judge
// evaluate-wireframe.mjs. Signals + weights live in warloops/signals.config.json.
//
// Usage:
//   node warloops/scripts/evaluate.mjs --reference <ref.png> --render <render.png>
//        [--spec <spec.json>] [--pen <file.pen>] [--config <path>] [--json]
// Exit: 0 = pass, 2 = iterate, 1 = fail (or error).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSignals } from "../signals/registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      a[k] = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : true;
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const referencePath = args.reference && path.resolve(args.reference);
  const renderPath = args.render && path.resolve(args.render);
  if (!referencePath || !renderPath) {
    console.error("Usage: evaluate.mjs --reference <ref.png> --render <render.png> [--spec <spec.json>] [--pen <file.pen>] [--json]");
    process.exit(64);
  }
  const configPath = args.config ? path.resolve(args.config) : path.join(__dirname, "..", "signals.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  const ctx = {
    referencePath,
    renderPath,
    specPath: args.spec ? path.resolve(args.spec) : undefined,
    penPath: args.pen ? path.resolve(args.pen) : undefined,
    builtPath: args.built ? path.resolve(args.built) : undefined,
  };

  const signals = await loadSignals(config);
  const results = [];
  for (const sig of signals) {
    try {
      const r = await sig.score(ctx);
      if (r && typeof r.score === "number") results.push({ name: sig.name, weight: sig.weight, score: r.score, detail: r.detail || "", findings: r.findings || [], usage: r.usage });
      else console.error(`[evaluate] signal "${sig.name}" abstained`);
    } catch (e) {
      console.error(`[evaluate] signal "${sig.name}" failed: ${e.message}`);
    }
  }

  if (results.length === 0) { console.error("[evaluate] no signals returned a score"); process.exit(1); }

  const totalW = results.reduce((s, r) => s + r.weight, 0) || 1;
  const overall = Math.round(results.reduce((s, r) => s + r.score * (r.weight / totalW), 0));
  const findings = results.flatMap((r) => (r.findings || []).map((f) => ({ ...f, signal: r.name })));
  const target = config.targetScore ?? 90;
  const floor = config.iterateFloor ?? 60;
  const decision = overall >= target ? "pass" : overall >= floor ? "iterate" : "fail";

  const usage = results.reduce((acc, r) => {
    if (r.usage) { acc.inputTokens += r.usage.inputTokens || 0; acc.outputTokens += r.usage.outputTokens || 0; acc.costUsd += r.usage.costUsd || 0; }
    return acc;
  }, { inputTokens: 0, outputTokens: 0, costUsd: 0 });

  // Coverage: a good measure names its own gaps. If signals abstained, the
  // overall is a blend of fewer voices and must not pass as a confident score.
  const enabled = signals.map((s) => s.name);
  const scored = new Set(results.map((r) => r.name));
  const abstained = enabled.filter((n) => !scored.has(n));
  const coverage = +(scored.size / (enabled.length || 1)).toFixed(2);
  const confidence = coverage >= 0.85 ? "ok" : coverage >= 0.6 ? "reduced" : "low";

  const out = {
    decision,
    overallScore: overall,
    target,
    confidence,
    coverage: { scored: scored.size, enabled: enabled.length, abstained },
    signals: results.map((r) => ({ name: r.name, score: r.score, weight: +(r.weight / totalW).toFixed(3), detail: r.detail })),
    findings,
    usage,
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const icon = { pass: "✅", iterate: "🔁", fail: "❌" }[decision] || "•";
    console.log(`\n${icon}  FIDELITY ${decision.toUpperCase()} - ${overall}/100 (target ${target})`);
    if (confidence !== "ok") console.log(`  ⚠  ${confidence.toUpperCase()} CONFIDENCE: ${abstained.length} signal(s) abstained [${abstained.join(", ")}] - coverage ${coverage}`);
    console.log("");
    for (const r of out.signals) console.log(`  ${r.name.padEnd(12)} ${String(r.score).padStart(3)}  · w ${r.weight}   ${r.detail}`);
    if (findings.length) {
      console.log(`\n  Findings (${findings.length}):`);
      for (const f of findings) console.log(`    [${f.severity}] ${f.signal}/${f.area}: ${f.observed}\n          → ${f.fix}`);
    }
    console.log("");
  }
  process.exit(decision === "pass" ? 0 : decision === "iterate" ? 2 : 1);
}

main();
