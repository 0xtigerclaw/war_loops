// War Loops — benchmark runner. Runs the full pipeline across the target corpus,
// records each target's fidelity + per-signal breakdown, and writes a disk report
// + a sorted leaderboard. This is the MetaLoop: "is the system getting better,
// on average," and the surface where signal weights get calibrated.
//
// Usage:  npx tsx warloops/scripts/benchmark.ts [--only=tailwind,vercel]
// Output: warloops/benchmark/report.json  +  warloops/benchmark/leaderboard.md
//
// Heavy: it runs the whole pipeline (capture + build + eval loop) per target,
// sequentially. Use --only to scope a quick run.
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import * as dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: ".env.local" });

interface Target { name: string; url?: string; image?: string; kind?: string }
interface Forge { staticScore?: number; experiential?: number; responsive?: number }
interface Row { name: string; ref: string; status?: string; overall: number | null; iteration: number | null; gates: Record<string, { score?: number }>; forge?: Forge }

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
  const { runFrontendMirrorPipeline } = await import("../orchestrator");
  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

  const targets: Target[] = JSON.parse(fs.readFileSync(path.resolve("warloops/targets.json"), "utf-8")).targets;
  const selected = onlyArg ? targets.filter((t) => onlyArg.split(",").includes(t.name)) : targets;
  console.log(`[bench] running ${selected.length} target(s)`);

  const rows: Row[] = [];
  for (const t of selected) {
    const ref = t.url || t.image || "";
    const desc = t.url ? `Mirror this page: ${t.url}` : `Mirror this image: ${t.image}`;
    const taskId = await client.mutation(api.tasks.create, { title: `Benchmark: ${t.name}`, description: desc, pipelineType: "frontend-mirror" });
    await client.mutation(api.tasks.updateStatus, { id: taskId, status: "in_progress" });
    console.log(`[bench] ${t.name} → ${taskId}`);
    try {
      await runFrontendMirrorPipeline(String(taskId));
    } catch (e) {
      console.error(`[bench] ${t.name} threw:`, e instanceof Error ? e.message : e);
    }
    const task = await client.query(api.tasks.get, { id: taskId });
    const ev = await client.query(api.evaluations.latest, { taskId });
    // Forge's three-axis result is written to disk (not the evaluations table).
    let forge: Forge | undefined;
    try { forge = JSON.parse(fs.readFileSync(path.resolve(`warloops/.mirror-specs/mirror-${taskId}/forge/result.json`), "utf-8")); } catch { /* no forge build */ }
    rows.push({ name: t.name, ref, status: task?.status, overall: ev?.overallScore ?? null, iteration: ev?.iteration ?? null, gates: (ev?.gates as Record<string, { score?: number }>) || {}, forge });
    await client.mutation(api.tasks.cancel, { id: taskId });
    console.log(`[bench] ${t.name}: wireframe ${ev?.overallScore ?? "n/a"}/100 · forge static ${forge?.staticScore ?? "n/a"} / exp ${forge?.experiential ?? "n/a"} / resp ${forge?.responsive ?? "n/a"} (${task?.status})`);
  }

  const outDir = path.resolve("warloops/benchmark");
  fs.mkdirSync(outDir, { recursive: true });
  const ranAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ ranAt, rows }, null, 2));

  const scored = rows.filter((r) => r.overall != null);
  const avg = scored.length ? Math.round(scored.reduce((s, r) => s + (r.overall || 0), 0) / scored.length) : 0;
  const sorted = [...rows].sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
  const md = [
    "# War Loops fidelity leaderboard",
    "",
    `_ran ${ranAt} · ${scored.length}/${rows.length} scored · mean fidelity ${avg}/100_`,
    "",
    "Wireframe = Pencil static mirror. Forge = code build, scored on three axes (static design / experiential motion / responsive reflow).",
    "",
    "| # | target | wireframe | forge static | experiential | responsive | status |",
    "|---|--------|-----------|--------------|--------------|------------|--------|",
    ...sorted.map((r, i) => `| ${i + 1} | ${r.name} | ${r.overall ?? "—"} | ${r.forge?.staticScore ?? "—"} | ${r.forge?.experiential ?? "—"} | ${r.forge?.responsive ?? "—"} | ${r.status} |`),
    "",
    "Per-signal (wireframe):",
    ...sorted.map((r) => `- **${r.name}**: ${Object.entries(r.gates).map(([k, v]) => `${k} ${v.score ?? "?"}`).join(", ")}`),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "leaderboard.md"), md);

  console.log(`\n[bench] mean fidelity ${avg}/100 across ${scored.length} target(s)`);
  console.log(`[bench] wrote warloops/benchmark/report.json + leaderboard.md`);
  process.exit(0);
}

main();
