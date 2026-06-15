#!/usr/bin/env node
// motion-match - compare two motion-energy timelines (reference vs build) from
// capture-motion. Scores whether the build MOVES LIKE the reference:
//   - magnitude : does it move about as much (not too little, not wildly more)
//   - temporal  : does motion happen at the same moments (timeline correlation)
//   - spatial   : does motion happen in the same places (per-band correlation)
// Deterministic, non-LLM. This replaces the count-based richness proxy with an
// actual "same moments, same places" comparison.
//
// Importable: compareMotion(refTimeline, buildTimeline) -> { score, detail, parts }.
// CLI: node motion-match.mjs --reference <dir|json> --build <dir|json> [--json]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MOTION_FLOOR = 0.002; // below this total energy, a page is effectively static

export function pearson(a, b) {
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

// "calm match": a near-static reference should be met with a near-static build.
function calmMatch(rTot, bTot, floor) {
  return bTot < floor ? 100 : Math.max(0, Math.round(100 * (1 - Math.min(1, (bTot - rTot) / 0.02))));
}

// Compare two parsed timeline objects (from capture-motion's motion-frames.json).
// Two components: entrance/ambient (held at top) and, when both captured it,
// scroll-reveal. Blended by where the REFERENCE's motion actually lives.
export function compareMotion(ref, build) {
  const SR_FLOOR = 0.003;
  // --- entrance / ambient ---
  const R = ref.energy || [], B = build.energy || [];
  const rE = ref.totalEnergy || 0, bE = build.totalEnergy || 0;
  let eScore, eParts = { mag: null, temporal: null, spatial: null };
  if (rE < MOTION_FLOOR) {
    eScore = calmMatch(rE, bE, MOTION_FLOOR);
  } else {
    const mag = Math.min(rE, bE) / Math.max(rE, bE);
    const temporal = Math.max(0, pearson(R, B));
    const spatial = Math.max(0, pearson(sumBands(ref), sumBands(build)));
    eParts = { mag: +mag.toFixed(2), temporal: +temporal.toFixed(2), spatial: +spatial.toFixed(2) };
    eScore = Math.round(100 * (0.45 * mag + 0.35 * temporal + 0.20 * spatial));
  }

  // --- scroll-reveal: only scored when the REFERENCE demonstrably has it (above
  // floor). A near-zero capture (reveal too fast for screenshots, or the page has
  // little scroll motion) is ignored rather than polluting the score. ---
  let srScore = null, rSR = ref.scrollReveal?.total || 0, bSR = build.scrollReveal?.total || 0;
  const srParts = { srMag: null, srTemporal: null };
  if (ref.scrollReveal && build.scrollReveal && rSR >= SR_FLOOR) {
    const srMag = Math.min(rSR, bSR) / Math.max(rSR, bSR);
    const srTemporal = Math.max(0, pearson(ref.scrollReveal.energy || [], build.scrollReveal.energy || []));
    srParts.srMag = +srMag.toFixed(2); srParts.srTemporal = +srTemporal.toFixed(2);
    srScore = Math.round(100 * (0.65 * srMag + 0.35 * srTemporal));
  } else {
    rSR = 0; // not scored: do not let it into the weighted blend
  }

  const parts = { ...eParts, ...srParts };
  if (srScore === null) {
    const detail = rE < MOTION_FLOOR ? `reference near-static (${rE.toFixed(4)}); build ${bE.toFixed(4)}` : `mag ${eParts.mag} · temporal ${eParts.temporal} · spatial ${eParts.spatial} (entrance/ambient)`;
    return { score: eScore, detail, parts };
  }
  // blend, weighted by where the reference's motion is (entrance vs scroll-reveal)
  const tot = rE + rSR;
  const score = tot < MOTION_FLOOR ? Math.round((eScore + srScore) / 2) : Math.round((rE / tot) * eScore + (rSR / tot) * srScore);
  const detail = `entrance ${eScore} + scroll-reveal ${srScore} -> ${score} (ref e${rE.toFixed(3)}/sr${rSR.toFixed(3)})`;
  return { score, detail, parts };
}

export function loadTimeline(p) {
  p = path.resolve(p);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "motion-frames.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// ---- CLI (only when invoked directly, so importing this module is side-effect free) ----
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
  const ref = loadTimeline(arg("--reference"));
  const build = loadTimeline(arg("--build"));
  const result = compareMotion(ref, build);
  result.referenceEnergy = ref.totalEnergy || 0;
  result.buildEnergy = build.totalEnergy || 0;
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(`motion-match ${result.score}/100 - ${result.detail}`);
}
