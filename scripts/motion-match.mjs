#!/usr/bin/env node
// motion-match - compare two motion-energy timelines (reference vs build) from
// capture-motion. Scores whether the build MOVES LIKE the reference:
//   - magnitude : does it move about as much (not too little, not wildly more)
//   - temporal  : does motion happen at the same moments (timeline correlation)
//   - spatial   : does motion happen in the same places (per-band correlation)
// Deterministic, non-LLM. This replaces the count-based richness proxy with an
// actual "same moments, same places" comparison.
//
// Usage: node motion-match.mjs --reference <dir|motion-frames.json>
//        --build <dir|motion-frames.json> [--json]
import fs from "node:fs";
import path from "node:path";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const MOTION_FLOOR = 0.002; // below this total energy, a page is effectively static

function loadTimeline(p) {
  p = path.resolve(p);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "motion-frames.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  a = a.slice(0, n); b = b.slice(0, n);
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; dot += da * db; na += da * da; nb += db * db; }
  return dot / (Math.sqrt(na * nb) || 1);
}
function sumBands(tl) {
  const be = tl.bandEnergy || [], n = tl.bands || 4, s = new Array(n).fill(0);
  for (const row of be) for (let i = 0; i < n; i++) s[i] += row[i] || 0;
  return s;
}

const ref = loadTimeline(arg("--reference"));
const build = loadTimeline(arg("--build"));
const R = ref.energy || [], B = build.energy || [];
const rTot = ref.totalEnergy || 0, bTot = build.totalEnergy || 0;

let score, detail, parts = {};
if (rTot < MOTION_FLOOR) {
  // Reference barely moves: a faithful build should also be calm. Reward calm,
  // penalize a build that invents motion the original does not have.
  score = bTot < MOTION_FLOOR ? 100 : Math.max(0, Math.round(100 * (1 - Math.min(1, (bTot - rTot) / 0.02))));
  detail = `reference near-static (${rTot.toFixed(4)}); build ${bTot.toFixed(4)}`;
} else {
  const mag = Math.min(rTot, bTot) / Math.max(rTot, bTot);          // comparable amount of motion
  const temporal = Math.max(0, pearson(R, B));                      // at the same moments
  const spatial = Math.max(0, pearson(sumBands(ref), sumBands(build))); // in the same places
  parts = { mag: +mag.toFixed(2), temporal: +temporal.toFixed(2), spatial: +spatial.toFixed(2) };
  score = Math.round(100 * (0.45 * mag + 0.35 * temporal + 0.20 * spatial));
  detail = `mag ${parts.mag} · temporal ${parts.temporal} · spatial ${parts.spatial} (ref ${rTot.toFixed(3)} / build ${bTot.toFixed(3)})`;
}

const result = { score, detail, parts, referenceEnergy: rTot, buildEnergy: bTot };
if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
else console.log(`motion-match ${score}/100 - ${detail}`);
