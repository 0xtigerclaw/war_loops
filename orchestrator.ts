import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "node:url";

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL!;
const MAX_SPEC_ATTEMPTS = 3;
const WIREFRAME_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_WIREFRAME_ITERATIONS = 3;

interface DesignSpec {
  source_type: "url" | "image";
  source_ref: string;
  blocked?: boolean;
  viewports: Record<string, { width: number; screenshot?: string }>;
  layout: { regions: Array<{ name: string; role: string; children?: string[]; approximate_height?: string }>; hierarchy: string };
  tokens: { colors: Record<string, string>; typography: Record<string, Record<string, string>>; spacing: Record<string, string> };
  content: { required_text: string[]; required_data: string[] };
  interactions: { states: string[]; elements: Array<{ type: string; trigger: string; state: string }> };
}

export async function runFrontendMirrorPipeline(taskId: string) {
  const client = new ConvexHttpClient(CONVEX_URL);
  const id = taskId as Id<"tasks">;

  const task = await client.query(api.tasks.get, { id });
  if (!task) throw new Error(`Task ${taskId} not found`);

  console.log(`[MIRROR] Starting pipeline for "${task.title}"`);
  await client.mutation(api.tasks.updateStatus, { id, status: "in_progress" });

  // Step 1: Pixel — produce a gated spec (refines until the evaluator passes),
  // then hand it off. Halts the pipeline if the spec can't clear the gate.
  const tPixel = Date.now();
  const handoff = await runPixelStage(client, id, taskId, task.description || "");
  recordStage("pixel", tPixel);
  if (!handoff) return; // failPipeline already invoked

  // Step 2: Wireframe — the agent translates the verified spec into Pencil
  // (active editor), self-checks structurally + visually, and exports a PNG.
  const tWf = Date.now();
  const wireframe = await runWireframeStage(client, id, taskId, handoff);
  recordStage("wireframe", tWf);
  await writeMetrics(client, id, handoff.specDir);
  if (!wireframe) return; // failPipeline already invoked

  // Step 3: Forge — Build production frontend
  console.log(`[MIRROR] Forge building production frontend`);
  await client.mutation(api.agents.logActivity, {
    agentName: "Forge",
    type: "action",
    content: `Building production React + Tailwind frontend from verified wireframe`,
  });

  // Forge agent runs here via Claude Code context
  // Reads: wireframe screenshot, layout snapshot, design tokens, Pixel spec
  // Outputs: React + Tailwind code to output/mirror-{taskId}/

  // Step 4: Handoff to review
  await client.mutation(api.tasks.updateStatus, { id, status: "review" });
  console.log(`[MIRROR] Pipeline complete, moved to review`);
}

interface SpecGate { gate: string; status: string; score: number; detail: string }
interface SpecEvaluation {
  decision: "pass" | "iterate" | "fail";
  overallScore: number;
  gates: SpecGate[];
  findings: Array<{ severity: string; category: string; observed: string; repair: string }>;
}

// Run one of the mirror node scripts (extract-spec / evaluate-spec) and capture output.
function runNode(scriptRel: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const scriptPath = path.resolve(process.cwd(), scriptRel);
    const child = spawn("node", [scriptPath, ...args], { cwd: process.cwd(), env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + e.message }));
  });
}

async function failPipeline(client: ConvexHttpClient, id: Id<"tasks">, agent: string, message: string) {
  console.error(`[MIRROR] ${message}`);
  await client.mutation(api.agents.logActivity, { agentName: agent, type: "error", content: message }).catch(() => ({}));
  await client.mutation(api.tasks.appendOutput, { id, title: "Pipeline Failed", content: message, agent });
  await client.mutation(api.tasks.updateStatus, { id, status: "review" });
}

// The artifact Pixel hands to the next stage: a gate-cleared spec + where it lives.
interface SpecHandoff {
  specPath: string;
  specDir: string;
  spec: DesignSpec;
  evaluation: SpecEvaluation;
}

// Step 1 producer: extract → evaluate, looping until the spec passes the gate (or
// attempts are exhausted), keeping the best-scoring attempt. URL retries escalate
// extraction effort (longer settle + full-page scroll) to pull in lazy content.
// Returns the handoff, or null after calling failPipeline.
async function runPixelStage(
  client: ConvexHttpClient,
  id: Id<"tasks">,
  taskId: string,
  description: string,
): Promise<SpecHandoff | null> {
  const sourceRef = extractSourceRef(description);
  console.log(`[MIRROR] Pixel analyzing source: ${sourceRef.type} — ${sourceRef.ref}`);
  await client.mutation(api.agents.logActivity, {
    agentName: "Pixel",
    type: "action",
    content: `Analyzing ${sourceRef.type} source: ${sourceRef.ref}`,
  });

  const specDir = path.resolve(process.cwd(), "warloops", ".mirror-specs", `mirror-${taskId}`);
  const specPath = path.join(specDir, "spec.json");
  const maxAttempts = sourceRef.type === "url" ? MAX_SPEC_ATTEMPTS : 1;

  let best: { spec: DesignSpec; evaluation: SpecEvaluation } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Real Chrome + full-page scroll are the defaults (beats bot walls, pulls in
    // lazy content). WARLOOPS_CDP attaches to a running, logged-in Chrome.
    const extractArgs = sourceRef.type === "url"
      ? ["--url", sourceRef.ref, "--out", specDir, "--scroll", "--settle", String(1500 + (attempt - 1) * 2500), ...(process.env.WARLOOPS_CDP ? ["--cdp", process.env.WARLOOPS_CDP] : [])]
      : ["--image", sourceRef.ref, "--out", specDir];

    const extract = await runNode("warloops/scripts/extract-spec.mjs", extractArgs);
    if (extract.code !== 0 || !fs.existsSync(specPath)) {
      await failPipeline(client, id, "Pixel", `Spec extraction failed for ${sourceRef.ref}: ${(extract.stderr || extract.stdout).slice(-400)}`);
      return null;
    }

    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8")) as DesignSpec;

    // Hard gate: a bot-wall / challenge page is never usable. Retry (the profile
    // may clear), then fail loudly rather than building from a blocked capture.
    if (spec.blocked) {
      await client.mutation(api.agents.logActivity, { agentName: "Pixel", type: "error", content: `Capture blocked (bot wall) on attempt ${attempt}/${maxAttempts}` });
      if (attempt < maxAttempts) { console.log(`[MIRROR] Capture blocked — retrying`); continue; }
      await failPipeline(client, id, "Pixel", `Source is bot-protected (e.g. Cloudflare) or login-gated: capture returned a challenge page, not the real page. Set WARLOOPS_CDP to attach to your logged-in Chrome, or use image mode (provide a screenshot).`);
      return null;
    }

    const evalRun = await runNode("warloops/scripts/evaluate-spec.mjs", [specPath, "--json"]);
    let evaluation: SpecEvaluation;
    try {
      evaluation = JSON.parse(evalRun.stdout);
    } catch {
      await failPipeline(client, id, "Pixel", `Spec evaluation produced no parseable result: ${(evalRun.stderr || evalRun.stdout).slice(-400)}`);
      return null;
    }

    if (!best || evaluation.overallScore > best.evaluation.overallScore) best = { spec, evaluation };

    await client.mutation(api.agents.logActivity, {
      agentName: "Pixel",
      type: evaluation.decision === "fail" ? "error" : "log",
      content: `Spec attempt ${attempt}/${maxAttempts}: ${evaluation.decision} (${evaluation.overallScore}/100)`,
    });

    if (evaluation.decision === "pass") break;
    if (attempt < maxAttempts) console.log(`[MIRROR] Spec ${evaluation.decision} (${evaluation.overallScore}/100) — retrying with more extraction effort`);
  }

  const { spec, evaluation } = best!;
  const failedGates = evaluation.gates.filter((g) => g.status !== "pass").map((g) => `${g.gate} (${g.score})`);

  await client.mutation(api.tasks.appendOutput, {
    id,
    title: `Pixel Spec — ${evaluation.decision.toUpperCase()} ${evaluation.overallScore}/100`,
    content:
      `**Source:** ${sourceRef.type} — ${sourceRef.ref}\n` +
      `**Spec gate:** ${evaluation.decision} (${evaluation.overallScore}/100)` +
      (failedGates.length ? `\n**Gates needing work:** ${failedGates.join(", ")}` : "") +
      (evaluation.findings.length ? `\n\n**Findings:**\n${evaluation.findings.map((f) => `- [${f.severity}] ${f.category}: ${f.observed} → ${f.repair}`).join("\n")}` : "") +
      `\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
    agent: "Pixel",
  });

  await client.mutation(api.agents.logActivity, {
    agentName: "Pixel",
    type: evaluation.decision === "fail" ? "error" : "success",
    content: `Spec ${evaluation.decision} (${evaluation.overallScore}/100) — ${spec.layout?.regions?.length ?? 0} regions, ${spec.content?.required_text?.length ?? 0} text strings`,
  });

  if (evaluation.decision === "fail") {
    await failPipeline(client, id, "Pixel", `Spec failed quality gate after ${maxAttempts} attempt(s) (${evaluation.overallScore}/100). Failed gates: ${failedGates.join(", ") || "n/a"}. Fix the source extraction (or fill the image spec via vision) before building.`);
    return null;
  }

  console.log(`[MIRROR] Pixel spec ${evaluation.decision} (${evaluation.overallScore}/100) → handoff at ${specPath}`);
  return { specPath, specDir, spec, evaluation };
}

function extractSourceRef(description: string): { type: "url" | "image"; ref: string } {
  const urlMatch = description.match(/https?:\/\/\S+/);
  if (urlMatch) return { type: "url", ref: urlMatch[0] };

  const pathMatch = description.match(/(?:\/[\w.-]+)+\.\w+/);
  if (pathMatch) return { type: "image", ref: pathMatch[0] };

  return { type: "image", ref: description.trim() };
}

// Spawn the Pencil CLI (`pencil`, authenticated via stored session) and capture
// its output. The CLI builds a REAL .pen file on disk and a rendered export PNG.
function runPencilCli(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("pencil", args, { cwd: process.cwd(), env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: stderr + e.message }); });
  });
}

interface WireframeResult { penPath: string; exportPath?: string; previewPath?: string; score?: number; decision?: string; iterations: number }
interface WireframeEval { decision: "pass" | "iterate" | "fail"; overallScore: number; signals: Array<{ name: string; score: number; weight: number; detail: string }>; findings: Array<{ severity: string; area: string; observed: string; fix: string; signal?: string }>; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }

// Appended to every build prompt: the agent reads the document back and reports
// what it actually built, so the deterministic signals can diff spec vs build.
const BUILT_REPORT = [
  "",
  "FINALLY, read the document back with get_variables and snapshot_layout, then output a fenced json block as the LAST thing in your reply (nothing after it):",
  "```json",
  '{ "variables": { "<name>": <value> }, "regions": ["<section names, top to bottom>"], "texts": ["<every visible text string>"] }',
  "```",
];

// Pull the build agent's reported {variables, regions, texts} out of stdout.
function extractBuilt(stdout: string): { variables?: Record<string, unknown>; regions?: string[]; texts?: string[] } | null {
  let depth = 0, start = -1, inStr = false, esc = false;
  const objs = [];
  for (let i = 0; i < stdout.length; i++) {
    const c = stdout[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}" && depth > 0) { depth--; if (depth === 0 && start >= 0) { objs.push(stdout.slice(start, i + 1)); start = -1; } }
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    try { const p = JSON.parse(objs[i]); if (p && (p.variables || p.regions || p.texts)) return p; } catch { /* keep */ }
  }
  return null;
}

const READBACK_PROMPT = 'Do not change the design at all. Read the current document with get_variables and snapshot_layout, then output ONLY a fenced json block (nothing else): { "variables": { "<name>": <value> }, "regions": ["<section names, top to bottom>"], "texts": ["<every visible text string>"] }';

// Guarantee built.json exists: if the build's output didn't include the report
// (common on the heavy initial build), do a cheap read-back pass to extract it.
async function ensureBuilt(stdout: string, penPath: string, builtPath: string): Promise<void> {
  let built = extractBuilt(stdout);
  if (!built) {
    const rbUsage = path.join(path.dirname(builtPath), "usage", "readback.json");
    fs.mkdirSync(path.dirname(rbUsage), { recursive: true });
    const rb = await runPencilCli(["--in", penPath, "--out", path.join(path.dirname(builtPath), "_readback.pen"), "--prompt", READBACK_PROMPT, "--agent", "claude", "--usage", rbUsage], 5 * 60 * 1000);
    built = extractBuilt(rb.stdout);
    recordCall("readback", readPencilUsage(rbUsage));
  }
  if (built) fs.writeFileSync(builtPath, JSON.stringify(built, null, 2));
}

// ---- run metrics: time, tokens, cost ----
interface Usage { inputTokens: number; outputTokens: number; costUsd: number }
const METRICS = {
  startedAt: Date.now(),
  stages: [] as { name: string; seconds: number }[],
  calls: [] as { call: string; inputTokens: number; outputTokens: number; costUsd: number }[],
};
function recordStage(name: string, t0: number) { METRICS.stages.push({ name, seconds: Math.round((Date.now() - t0) / 1000) }); }
function recordCall(call: string, u: Partial<Usage>) { METRICS.calls.push({ call, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, costUsd: u.costUsd || 0 }); }
function readPencilUsage(p: string): Partial<Usage> {
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      inputTokens: j.inputTokens ?? j.input_tokens ?? j.promptTokens ?? j.tokens?.input ?? j.usage?.input_tokens ?? 0,
      outputTokens: j.outputTokens ?? j.output_tokens ?? j.completionTokens ?? j.tokens?.output ?? j.usage?.output_tokens ?? 0,
      costUsd: j.cost ?? j.costUsd ?? j.total_cost_usd ?? j.totalCost ?? 0,
    };
  } catch { return {}; }
}
async function writeMetrics(client: ConvexHttpClient, id: Id<"tasks">, specDir: string) {
  const totalSeconds = Math.round((Date.now() - METRICS.startedAt) / 1000);
  const inputTokens = METRICS.calls.reduce((s, c) => s + c.inputTokens, 0);
  const outputTokens = METRICS.calls.reduce((s, c) => s + c.outputTokens, 0);
  const costUsd = +METRICS.calls.reduce((s, c) => s + c.costUsd, 0).toFixed(4);
  const metrics = { totalSeconds, tokens: { input: inputTokens, output: outputTokens }, costUsd, stages: METRICS.stages, calls: METRICS.calls };
  try { fs.writeFileSync(path.join(specDir, "metrics.json"), JSON.stringify(metrics, null, 2)); } catch { /* ignore */ }
  const mm = Math.floor(totalSeconds / 60), ss = totalSeconds % 60;
  const summary = `⏱ ${mm}m${ss}s · ${Math.round(inputTokens / 1000)}k in / ${Math.round(outputTokens / 1000)}k out · $${costUsd.toFixed(2)}`;
  console.log(`[MIRROR] metrics: ${summary}`);
  await client.mutation(api.tasks.appendOutput, {
    id,
    title: `Run metrics — ${summary}`,
    content: `**Time:** ${mm}m ${ss}s\n**Tokens:** ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out\n**Cost:** $${costUsd.toFixed(2)}\n\n` +
      METRICS.calls.map((c) => `- ${c.call}: $${c.costUsd.toFixed(3)} (${c.inputTokens.toLocaleString()}+${c.outputTokens.toLocaleString()} tok)`).join("\n"),
    agent: "Orchestrator",
  }).catch(() => ({}));
}

// Initial build brief: a high-fidelity 1:1 mirror. The reference screenshot is
// ALSO attached to the CLI call (-f), so the agent sees the target directly.
function buildWireframePrompt(spec: DesignSpec, varsJson: string, hasReference: boolean): string {
  const regions = (spec.layout?.regions || []).map((r) => `${r.role}: ${r.name}`).join(", ");
  const text = (spec.content?.required_text || []).slice(0, 28);
  return [
    `Build a HIGH-FIDELITY 1:1 DESKTOP mirror (1440px wide) of the page "${spec.source_ref}".`,
    hasReference
      ? "An image of the ORIGINAL page is attached. Replicate it as closely as possible: same sections in the same order, same proportions, same colors/typography/spacing, and replicate images/media (use Generate for stock/AI images where the original has photos/graphics — do not leave blank boxes)."
      : "Reproduce the layout, hierarchy, and real content faithfully. Replicate images/media using Generate where the original has photos/graphics.",
    "",
    "USE EXACTLY THESE DESIGN TOKENS (set as document variables, then reference them). Do not guess colors/fonts/sizes:",
    "```json",
    varsJson,
    "```",
    "",
    `LAYOUT — build these regions as stacked frames, in order: ${regions || "header, hero, content sections, footer"}.`,
    "Full-width via fill_container, sized by content. Header = logo + nav; hero = headline + subhead + CTA; sections = title + body/cards; footer = columns + copyright.",
    "",
    "REAL CONTENT (use these exact strings):",
    ...text.map((t) => `- ${t}`),
    "",
    "One top-level frame. Keep it clean — don't wrap every element in a card. Nothing clipped or overlapping.",
    ...BUILT_REPORT,
  ].join("\n");
}

// Surgical critic: focus the weakest signals + the most impactful findings, and
// tell the agent to fix ONLY those (no rebuild). Mirrors warloops/scripts/critic.mjs.
function buildRepairPrompt(spec: DesignSpec, ev: WireframeEval): string {
  const SEV: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const weakest = [...(ev.signals || [])].sort((a, b) => a.score - b.score).slice(0, 3).map((s) => s.name);
  const rank = (f: { severity: string; signal?: string }) => (SEV[f.severity] ?? 9) * 10 + (weakest.includes(f.signal || "") ? 0 : 5);
  const chosen = [...(ev.findings || [])]
    .filter((f) => weakest.includes(f.signal || "") || f.severity === "P0" || f.severity === "P1")
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 6);
  const list = chosen.length ? chosen : (ev.findings || []).slice(0, 6);
  return [
    `Improve the wireframe mirror of "${spec.source_ref}" toward the ORIGINAL (attached first; current render second). Fidelity ${ev.overallScore}/100; weakest areas: ${weakest.join(", ")}.`,
    `Fix ONLY these ${list.length} issues, most impactful first. Do NOT rebuild, and do NOT touch parts that already match:`,
    "",
    ...list.map((f) => `- [${f.severity}] ${f.area}: ${f.fix}${f.observed ? `  (now: ${f.observed})` : ""}`),
    "",
    "Replicate any still-missing images/media with Generate. Nothing clipped or overlapping.",
    ...BUILT_REPORT,
  ].join("\n");
}

// Map the vision-judge eval onto the dashboard's evaluation scorecard shape.
function toEvaluationRecord(ev: WireframeEval) {
  const gates: Record<string, { status: string; score: number }> = {};
  for (const s of ev.signals || []) gates[s.name] = { status: s.score >= 70 ? "pass" : "fail", score: s.score };
  const findings = (ev.findings || []).map((f, i) => ({
    id: `WF-${i + 1}`,
    severity: f.severity || "P2",
    category: f.signal ? `${f.signal}/${f.area}` : (f.area || "fidelity"),
    viewport: "desktop",
    state: "default",
    observed: f.observed || "",
    expected: "Match the reference",
    evidence: [] as string[],
    repair_instruction: f.fix || "",
    acceptance_check: "Re-evaluate fidelity vs reference",
  }));
  return { gates, findings };
}

// Step 2 producer: translate tokens → variables, then build + evaluate + repair
// in a loop via the Pencil CLI and the vision-judge evaluator, driving toward a
// 1:1 mirror. Returns the result, or null after failPipeline.
async function runWireframeStage(
  client: ConvexHttpClient,
  id: Id<"tasks">,
  taskId: string,
  handoff: SpecHandoff,
): Promise<WireframeResult | null> {
  const specDir = handoff.specDir;
  const varsPath = path.join(specDir, "pencil-vars.json");
  const vars = await runNode("warloops/scripts/spec-to-pencil-vars.mjs", [handoff.specPath, "--out", varsPath]);
  if (vars.code !== 0) {
    await failPipeline(client, id, "Wireframe", `Token translation failed: ${(vars.stderr || vars.stdout).slice(-300)}`);
    return null;
  }

  const penPath = path.join(specDir, "wireframe.pen");
  const exportPath = path.join(specDir, "wireframe.png");
  const previewPath = path.join(specDir, "preview.png");
  const refPath = path.join(specDir, "screenshots", "desktop.png");
  const hasReference = fs.existsSync(refPath);
  const varsJson = fs.readFileSync(varsPath, "utf-8");

  let lastEval: WireframeEval | null = null;
  let prevScore = -1;
  let iterations = 0;

  for (let iter = 0; iter < MAX_WIREFRAME_ITERATIONS; iter++) {
    iterations = iter + 1;
    const isRepair = iter > 0 && lastEval != null;
    await client.mutation(api.agents.logActivity, {
      agentName: "Wireframe",
      type: "action",
      content: isRepair ? `Repair iteration ${iter} (fidelity ${lastEval!.overallScore}/100)` : `Building wireframe via Pencil CLI → ${path.basename(penPath)}`,
    });

    const buildArgs = isRepair
      ? ["--in", penPath, "--out", penPath, "--prompt", buildRepairPrompt(handoff.spec, lastEval!)]
      : ["--out", penPath, "--prompt", buildWireframePrompt(handoff.spec, varsJson, hasReference)];
    if (hasReference) buildArgs.push("-f", refPath);
    if (isRepair && fs.existsSync(exportPath)) buildArgs.push("-f", exportPath);
    const buildUsage = path.join(specDir, "usage", `build-${iter}.json`);
    fs.mkdirSync(path.dirname(buildUsage), { recursive: true });
    buildArgs.push("--agent", "claude", "--export", exportPath, "--enable-preview", "--preview-output", previewPath, "--usage", buildUsage);

    const tBuild = Date.now();
    const run = await runPencilCli(buildArgs, WIREFRAME_TIMEOUT_MS);
    recordStage(`wireframe.build.${iter}`, tBuild);
    recordCall(`build.${iter}`, readPencilUsage(buildUsage));
    if (run.code !== 0 || !fs.existsSync(penPath)) {
      if (iter === 0) { await failPipeline(client, id, "Wireframe", `Pencil CLI failed (code ${run.code}): ${(run.stderr || run.stdout).slice(-400)}`); return null; }
      break; // keep best-so-far on a later-iteration failure
    }

    if (!fs.existsSync(exportPath)) break; // can't evaluate without a render

    // Persist what was built (read-back fallback ensures it exists even on iter 0).
    const builtPath = path.join(specDir, "built.json");
    await ensureBuilt(run.stdout, penPath, builtPath);

    // Multi-signal fidelity vs the reference capture (panel runs the enabled signals).
    const evalArgs = ["--reference", refPath, "--render", exportPath, "--spec", handoff.specPath, "--pen", penPath, "--json"];
    if (fs.existsSync(builtPath)) evalArgs.push("--built", builtPath);
    const tEval = Date.now();
    const evRun = await runNode("warloops/scripts/evaluate.mjs", evalArgs);
    recordStage(`eval.${iter}`, tEval);
    let ev: WireframeEval | null = null;
    try { ev = JSON.parse(evRun.stdout); } catch { /* no verdict */ }
    if (ev && ev.usage) recordCall(`eval.${iter}`, ev.usage);
    if (!ev) { lastEval = lastEval || { decision: "iterate", overallScore: 0, signals: [], findings: [] }; break; }
    lastEval = ev;

    const rec = toEvaluationRecord(ev);
    await client.mutation(api.evaluations.create, {
      taskId: id, iteration: iter, stage: "wireframe",
      decision: ev.decision, overallScore: ev.overallScore,
      gates: rec.gates, findings: rec.findings, runtime: "pencil-cli",
    });
    await client.mutation(api.agents.logActivity, { agentName: "Wireframe", type: ev.decision === "fail" ? "error" : "log", content: `Fidelity ${ev.overallScore}/100 (${ev.decision})` });

    if (ev.decision === "pass") break;
    if (iter > 0 && ev.overallScore - prevScore < 5) break; // stagnation
    prevScore = ev.overallScore;
  }

  const result: WireframeResult = {
    penPath,
    exportPath: fs.existsSync(exportPath) ? exportPath : undefined,
    previewPath: fs.existsSync(previewPath) ? previewPath : undefined,
    score: lastEval?.overallScore,
    decision: lastEval?.decision,
    iterations,
  };

  await client.mutation(api.tasks.appendOutput, {
    id,
    title: `Wireframe — ${result.decision ?? "built"} (${result.score ?? "?"}/100, ${iterations} iter)`,
    content:
      "**Built a real `.pen` mirror via the Pencil CLI, evaluated for 1:1 fidelity.**\n" +
      `**Pencil file:** ${penPath}\n` +
      `**Open in Pencil:** \`open -a Pencil "${penPath}"\`\n` +
      (result.exportPath ? `**Export:** ${result.exportPath}\n` : "") +
      `**Fidelity:** ${result.score ?? "?"}/100 (${result.decision ?? "n/a"}) over ${iterations} iteration(s)\n` +
      (lastEval?.findings?.length ? `\n**Remaining gaps:**\n${lastEval.findings.map((f) => `- [${f.severity}] ${f.area}: ${f.observed}`).join("\n")}\n` : "") +
      `\nVariables: ${varsPath}`,
    agent: "Wireframe",
  });
  await client.mutation(api.agents.logActivity, { agentName: "Wireframe", type: "success", content: `Wireframe ${result.decision ?? "built"} (${result.score ?? "?"}/100)` });

  return result;
}

// Entry point — only when this file is the directly-invoked script (not when
// imported, e.g. by the benchmark runner, which would otherwise misread argv).
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const taskId = process.argv[2];
  if (taskId) {
    runFrontendMirrorPipeline(taskId).catch((err) => {
      console.error(`[MIRROR] Fatal error:`, err);
      process.exit(1);
    });
  }
}
