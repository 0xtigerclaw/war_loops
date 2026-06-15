// Signal: responsive - RESPONSIVENESS fidelity, reported as a SEPARATE axis (not
// blended into the desktop static score). Does the build ADAPT across viewports
// the way the original does? We already capture both the reference and the build
// at desktop / tablet / mobile, so this is a pure deterministic comparison:
//   - reflow : does page height adapt like the original (relative to desktop)?
//   - fit    : does the build stay within the viewport (no horizontal overflow)?
//
// Abstains when the build has no tablet/mobile renders (e.g. the static Pencil
// wireframe), so it only scores builds that actually claim to be responsive.
import { Jimp } from "jimp";
import fs from "node:fs";
import { clamp } from "./_contract.mjs";

export const name = "responsive";
export const axis = "responsive"; // partitioned out of the weighted static overall

// desktop.png -> { desktop, tablet, mobile } sibling paths
function viewports(p) {
  return {
    desktop: p,
    tablet: p.replace(/desktop(\.[a-z]+)$/i, "tablet$1"),
    mobile: p.replace(/desktop(\.[a-z]+)$/i, "mobile$1"),
  };
}
async function dims(p) { const im = await Jimp.read(p); return { w: im.bitmap.width, h: im.bitmap.height }; }

export async function score({ referencePath, renderPath }) {
  if (!referencePath || !renderPath) return null;
  const R = viewports(referencePath), B = viewports(renderPath);
  if (!fs.existsSync(R.desktop) || !fs.existsSync(B.desktop)) return null;
  // Both sides must be true multi-viewport captures (a "desktop.png" whose tablet/
  // mobile siblings are distinct files). A static build render (e.g. wireframe.png)
  // has no siblings, so the path is unchanged -> abstain.
  if (B.tablet === B.desktop || R.tablet === R.desktop) return null;
  const vps = ["tablet", "mobile"].filter((v) => fs.existsSync(R[v]) && fs.existsSync(B[v]));
  if (!vps.length) return null; // no responsive renders to compare (static build): abstain

  const rd = await dims(R.desktop), bd = await dims(B.desktop);
  const findings = [];
  const scores = [];
  for (const v of vps) {
    const rv = await dims(R[v]), bv = await dims(B[v]);
    // reflow: height growth relative to desktop should match the original's
    const rGrow = rd.h > 0 ? rv.h / rd.h : 1;
    const bGrow = bd.h > 0 ? bv.h / bd.h : 1;
    const reflow = Math.min(rGrow, bGrow) / (Math.max(rGrow, bGrow) || 1);
    // fit: the build should occupy the viewport width like the original (no overflow)
    const fit = Math.min(rv.w, bv.w) / (Math.max(rv.w, bv.w) || 1);
    scores.push(0.6 * reflow + 0.4 * fit);

    if (reflow < 0.6) findings.push({ severity: "P1", area: "responsive", observed: `At ${v}, the build's height adapts ${bGrow.toFixed(2)}x vs the original's ${rGrow.toFixed(2)}x (relative to desktop)`, fix: `Make the ${v} layout reflow like the original (stack/condense, do not keep the desktop layout)` });
    if (fit < 0.9) findings.push({ severity: "P1", area: "responsive", observed: `At ${v}, the build renders ${bv.w}px wide in a ${rv.w}px viewport (horizontal overflow)`, fix: `Constrain the ${v} layout to the viewport width; no horizontal scroll` });
  }

  const overall = scores.reduce((s, x) => s + x, 0) / scores.length;
  return { score: clamp(overall * 100), axis, detail: `${vps.join("+")} adapt ${(overall).toFixed(2)} (vs reference reflow)`, findings };
}
