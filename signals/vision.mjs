// Signal: vision - the subjective judge, now just one weighted voice in the
// panel. Spawns `claude` (authenticated, has vision) to compare the reference
// against the render and return dimensioned sub-scores. Abstains (returns null)
// if claude is unavailable, so the panel degrades gracefully to the non-LLM
// signals instead of failing.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { clamp } from "./_contract.mjs";
import { claudeModelArgs } from "../scripts/model-router.mjs";

export const name = "vision";

function buildPrompt(refPath, renderPath, spec) {
  const content = (spec?.content?.required_text || []).slice(0, 16);
  return [
    "You are a strict UI fidelity judge for a 1:1 website-mirroring pipeline.",
    "Use your Read tool to open BOTH images, then compare them:",
    `- REFERENCE (the original page): ${refPath}`,
    `- BUILT (our render): ${renderPath}`,
    "",
    "Score how faithfully BUILT replicates REFERENCE, each 0-100:",
    "- layout: sections present, correct order, correct proportions",
    "- visual: colors, typography, spacing match",
    "- content: required text/labels present and correct",
    "- completeness: nothing missing or extra; images/media replicated",
    content.length ? "Expected key content:\n" + content.map((t) => `- ${t}`).join("\n") : "",
    "",
    "overallScore = round(layout*0.3 + visual*0.3 + content*0.2 + completeness*0.2).",
    "findings: concrete, actionable repair instructions, most impactful first.",
    "Output ONLY one JSON object as the very last line, no prose:",
    '{"overallScore":0,"dimensions":{"layout":0,"visual":0,"content":0,"completeness":0},"findings":[{"severity":"P0|P1|P2","area":"layout|visual|content|completeness","observed":"...","fix":"..."}]}',
  ].filter(Boolean).join("\n");
}

function extractVerdict(text) {
  let depth = 0, start = -1, inStr = false, esc = false;
  const objs = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}" && depth > 0) { depth--; if (depth === 0 && start >= 0) { objs.push(text.slice(start, i + 1)); start = -1; } }
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    try { const p = JSON.parse(objs[i]); if (p && typeof p.overallScore === "number") return p; } catch { /* keep */ }
  }
  return null;
}

function runClaude(prompt) {
  return new Promise((resolve) => {
    const c = spawn("claude", ["--print", "--output-format", "json", ...claudeModelArgs("judge"), "--dangerously-skip-permissions", "-p", prompt], { env: process.env });
    let o = "", e = "";
    c.stdout.on("data", (d) => (o += d.toString()));
    c.stderr.on("data", (d) => (e += d.toString()));
    c.on("close", (code) => resolve({ code, stdout: o, stderr: e }));
    c.on("error", (err) => resolve({ code: 1, stdout: o, stderr: err.message }));
  });
}

export async function score({ referencePath, renderPath, specPath }) {
  if (!referencePath || !renderPath) return null;
  let spec = null;
  if (specPath && fs.existsSync(specPath)) { try { spec = JSON.parse(fs.readFileSync(specPath, "utf-8")); } catch { /* optional */ } }
  const prompt = buildPrompt(referencePath, renderPath, spec);
  // The judge is the dominant subjective signal; retry once on a flaky/unparseable
  // response so a transient miss doesn't drop it from the panel.
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = await runClaude(prompt);
    // --output-format json wraps the model text in an envelope with usage + cost.
    let text = run.stdout, usage;
    try {
      const env = JSON.parse(run.stdout);
      text = env.result || run.stdout;
      const u = env.usage || {};
      usage = {
        inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        outputTokens: u.output_tokens || 0,
        costUsd: env.total_cost_usd || 0,
      };
    } catch { /* fall back to raw text, no usage */ }

    const v = extractVerdict(text);
    if (v && typeof v.overallScore === "number") {
      const dims = v.dimensions || {};
      const detail = Object.entries(dims).map(([k, val]) => `${k} ${val}`).join(" · ") || `score ${v.overallScore}`;
      const findings = (Array.isArray(v.findings) ? v.findings : []).map((f) => ({
        severity: f.severity || "P2", area: f.area || "vision", observed: f.observed || "", fix: f.fix || "",
      }));
      return { score: clamp(v.overallScore), detail, findings, usage };
    }
  }
  return null; // abstain after retry
}
