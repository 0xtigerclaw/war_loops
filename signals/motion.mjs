// Signal: motion - EXPERIENTIAL fidelity, reported as a SEPARATE axis (never
// blended into the static fidelity score). It quantifies how much of the
// reference page's motion the build reproduces.
//
// Today the Pencil build is static, so this measures the GAP: it turns "the
// clone feels dead" into a number and names exactly what is missing (scroll
// reveals, ambient/looping motion, hover transitions). When a motion-capable
// build stage (Forge) exists and emits a build-side motion profile, the same
// signal scores real motion fidelity by comparing reference vs build.
//
// Reads spec.motion (captured by Pixel). Build motion is read from an optional
// buildMotionPath; absent => static build => the score is the unmet experiential
// demand.
import fs from "node:fs";
import { compareMotion } from "../scripts/motion-match.mjs";

export const name = "motion";
export const axis = "experiential"; // partitioned out of the weighted static overall

function richness(m) {
  const s = (m && m.summary) || {};
  return {
    kf: s.keyframe_count ?? (m?.keyframes || []).length,
    tr: s.transition_count ?? (m?.transitions || []).length,
    anim: s.animated_count ?? (m?.animated || []).length,
    infinite: !!s.has_infinite,
    reveal: !!s.has_scroll_reveal,
    libs: (m?.libraries || []).length,
  };
}

// Weighted by how much each kind of motion shapes the felt experience.
function demandOf(r) {
  return (r.reveal ? 30 : 0) + (r.infinite ? 25 : 0) + Math.min(25, r.tr * 1.5) + Math.min(20, r.kf * 0.5);
}
function supplyOf(ref, build) {
  return (ref.reveal && build.reveal ? 30 : 0)
    + (ref.infinite && build.infinite ? 25 : 0)
    + Math.min(25, Math.min(ref.tr, build.tr) * 1.5)
    + Math.min(20, Math.min(ref.kf, build.kf) * 0.5);
}

export async function score({ specPath, buildMotionPath, refMotionTimeline, buildMotionTimeline }) {
  // PREFERRED: a real frame-based motion-match (same moments, same places) when
  // both the reference and the build have a captured motion timeline. This is the
  // honest signal; the richness proxy below is the fallback when timelines are absent.
  if (refMotionTimeline && buildMotionTimeline && fs.existsSync(refMotionTimeline) && fs.existsSync(buildMotionTimeline)) {
    try {
      const refTL = JSON.parse(fs.readFileSync(refMotionTimeline, "utf-8"));
      const buildTL = JSON.parse(fs.readFileSync(buildMotionTimeline, "utf-8"));
      const r = compareMotion(refTL, buildTL);
      const findings = [];
      if (r.parts.mag != null && r.parts.mag < 0.6) findings.push({ severity: "P1", area: "motion", observed: `Build moves about ${Math.round(r.parts.mag * 100)}% as much as the original`, fix: "Add the missing entrance/ambient motion" });
      if (r.parts.temporal != null && r.parts.temporal < 0.5) findings.push({ severity: "P1", area: "motion", observed: "Motion happens at different moments than the original (e.g. one-shot entrance vs sustained/ambient)", fix: "Match the original's motion timing, including any continuous/ambient motion" });
      if (r.parts.spatial != null && r.parts.spatial < 0.5) findings.push({ severity: "P2", area: "motion", observed: "Motion is concentrated in different regions than the original", fix: "Animate the same areas the original animates" });
      if (r.parts.srMag != null && r.parts.srMag < 0.6) findings.push(r.parts.srOver
        ? { severity: "P1", area: "motion", observed: "Build over-animates on scroll (far more reveal motion than the original)", fix: "Tone down scroll-reveal to the original's subtler motion (smaller offsets, fewer animated elements)" }
        : { severity: "P1", area: "motion", observed: "Build reveals less on scroll than the original", fix: "Add scroll-triggered reveals (IntersectionObserver) so sections animate in as they enter the viewport" });
      return { score: r.score, axis, detail: `frame-match ${r.detail}`, findings };
    } catch { /* fall through to the richness proxy */ }
  }

  if (!specPath || !fs.existsSync(specPath)) return null;
  let spec; try { spec = JSON.parse(fs.readFileSync(specPath, "utf-8")); } catch { return null; }
  if (!spec.motion) return null; // spec predates motion capture: abstain
  const ref = richness(spec.motion);

  let build = richness(null); // static build => no motion
  if (buildMotionPath && fs.existsSync(buildMotionPath)) {
    // accepts a spec (uses .motion) or a raw motion object
    try { const bm = JSON.parse(fs.readFileSync(buildMotionPath, "utf-8")); build = richness(bm.motion || bm); } catch { /* keep empty */ }
  }

  const demand = demandOf(ref);
  if (demand < 1) return { score: 100, axis, detail: "reference has no detectable motion; nothing to reproduce", findings: [] };
  const s = Math.max(0, Math.min(100, Math.round(100 * supplyOf(ref, build) / demand)));

  const findings = [];
  if (ref.reveal && !build.reveal) findings.push({ severity: "P1", area: "motion", observed: `Reference reveals content on scroll (${spec.motion.scroll_reveal?.mechanism || "detected"}); the build is static`, fix: "Reproduce scroll-reveal (IntersectionObserver + transition) in a motion-capable build stage" });
  if (ref.infinite && !build.infinite) findings.push({ severity: "P1", area: "motion", observed: "Reference has continuous/looping animation (ambient motion); the build has none", fix: "Emit the looping @keyframes animation on the corresponding element" });
  if (ref.tr > build.tr) findings.push({ severity: "P2", area: "motion", observed: `Reference has ${ref.tr} interactive transitions (hover/state); build has ${build.tr}`, fix: "Carry hover/state CSS transitions into the build" });

  return { score: s, axis, detail: `experiential ${s}/100 (ref ${ref.kf}kf ${ref.tr}tr${ref.infinite ? " inf" : ""}${ref.reveal ? " reveal" : ""}; build ${build.kf}kf ${build.tr}tr)`, findings };
}
