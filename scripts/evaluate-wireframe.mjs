#!/usr/bin/env node
// Wireframe fidelity evaluator — the vision judge that drives the mirror loop
// toward 1:1. Compares Pixel's reference capture against the built wireframe
// render and returns a scored, actionable verdict. Spawns `claude --print`
// (authenticated, has vision); no API key needed.
//
// Usage:
//   node warloops/scripts/evaluate-wireframe.mjs --reference <ref.png> --render <wf.png> [--spec <spec.json>] [--out <eval.json>] [--json]
// Exit codes: 0 = pass, 2 = iterate, 1 = fail (or error).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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

function buildPrompt(refPath, renderPath, spec) {
  const content = (spec?.content?.required_text || []).slice(0, 20);
  return [
    "You are a STRICT UI fidelity evaluator for a 1:1 website-mirroring pipeline.",
    "Use your Read tool to open BOTH images, then compare them:",
    `- REFERENCE (the original page we must replicate): ${refPath}`,
    `- BUILT (our generated wireframe render): ${renderPath}`,
    "",
    "Judge how faithfully BUILT replicates REFERENCE. The target is a HIGH-FIDELITY 1:1 visual match:",
    "same sections in the same order and proportions; same colors, typography, and spacing; the real text content;",
    "and images/media actually replicated (not blank boxes or placeholders).",
    content.length ? "Expected key content (should appear in BUILT):\n" + content.map((t) => `- ${t}`).join("\n") : "",
    "",
    "Score each dimension 0-100:",
    "- layout: sections present, correct order, correct proportions/structure",
    "- visual: colors, typography, spacing match the reference",
    "- content: required text/labels present and correct",
    "- completeness: nothing missing or extra; images/media replicated",
    "overallScore = round(layout*0.3 + visual*0.3 + content*0.2 + completeness*0.2).",
    "decision: 'pass' if overallScore >= 85 and no P0 gaps; 'iterate' if 60-84; 'fail' if < 60.",
    "findings: concrete, actionable repair instructions for the BUILD agent — exactly what to add/change/fix to get closer to REFERENCE. Most impactful first. Empty array if pass with no notes.",
    "",
    "Output ONLY one JSON object as the very last line, no prose, no code fence:",
    '{"decision":"pass|iterate|fail","overallScore":0,"dimensions":{"layout":0,"visual":0,"content":0,"completeness":0},"findings":[{"severity":"P0|P1|P2","area":"layout|visual|content|completeness","observed":"...","fix":"..."}]}',
  ].filter(Boolean).join("\n");
}

function runClaude(prompt) {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--print", "--dangerously-skip-permissions", "-p", prompt], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: e.message }));
  });
}

// Find the last JSON object in text that has a "decision" field.
function extractVerdict(text) {
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}" && depth > 0) { depth--; if (depth === 0 && start >= 0) { objs.push(text.slice(start, i + 1)); start = -1; } }
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    try { const p = JSON.parse(objs[i]); if (p && p.decision) return p; } catch { /* keep scanning */ }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const refPath = args.reference && path.resolve(args.reference);
  const renderPath = args.render && path.resolve(args.render);
  if (!refPath || !renderPath) { console.error("Usage: evaluate-wireframe.mjs --reference <ref.png> --render <wf.png> [--spec <spec.json>] [--out <eval.json>] [--json]"); process.exit(64); }
  if (!fs.existsSync(refPath) || !fs.existsSync(renderPath)) { console.error(`[evaluate-wireframe] missing image(s): ${!fs.existsSync(refPath) ? refPath : renderPath}`); process.exit(1); }

  let spec = null;
  if (args.spec && fs.existsSync(path.resolve(args.spec))) {
    try { spec = JSON.parse(fs.readFileSync(path.resolve(args.spec), "utf-8")); } catch { /* optional */ }
  }

  const run = await runClaude(buildPrompt(refPath, renderPath, spec));
  const verdict = extractVerdict(run.stdout);
  if (!verdict) { console.error(`[evaluate-wireframe] no parseable verdict.\n${(run.stderr || run.stdout).slice(-400)}`); process.exit(1); }

  const out = {
    decision: verdict.decision,
    overallScore: verdict.overallScore ?? 0,
    dimensions: verdict.dimensions || {},
    findings: Array.isArray(verdict.findings) ? verdict.findings : [],
  };

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(out, null, 2));
  }

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const icon = { pass: "✅", iterate: "🔁", fail: "❌" }[out.decision] || "•";
    console.log(`\n${icon}  WIREFRAME ${out.decision.toUpperCase()} — fidelity ${out.overallScore}/100`);
    for (const [k, v] of Object.entries(out.dimensions)) console.log(`  ${k.padEnd(13)} ${v}`);
    if (out.findings.length) {
      console.log(`\n  Findings (${out.findings.length}):`);
      for (const f of out.findings) console.log(`    [${f.severity}] ${f.area}: ${f.observed}\n          → ${f.fix}`);
    }
    console.log("");
  }
  process.exit(out.decision === "pass" ? 0 : out.decision === "iterate" ? 2 : 1);
}

main();
