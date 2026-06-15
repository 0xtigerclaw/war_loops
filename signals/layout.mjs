// Signal: layout - do the page's horizontal SECTIONS land at the same vertical
// positions in the build as in the original? Non-LLM, deterministic, symmetric.
//
// This closes the blind spot SSIM and the (name-free) structure signal both miss:
// "right content, wrong vertical positions/proportions." We detect section
// boundaries the SAME way on both images, from the row-wise color-derivative
// profile, so it catches transitions whether they are whitespace gaps OR
// full-bleed color blocks butting together. Then we score boundary-count
// proximity + bidirectional positional alignment.
import { Jimp } from "jimp";
import { clamp } from "./_contract.mjs";

const W = 160;   // narrow: average out horizontal detail, keep vertical structure
const H = 1000;  // tall: ~0.1% vertical resolution
const SMOOTH = 7;        // rows; smooth the derivative before peak-finding
const MIN_SPACING = 0.03; // non-max suppression: boundaries >= 3% of height apart
const TOL = 0.05;        // a boundary within 5% of page height counts as aligned

// Per-row mean RGB, then the smoothed magnitude of the row-to-row difference.
// Peaks in that derivative are horizontal section transitions.
async function profile(p) {
  const img = await Jimp.read(p);
  img.resize({ w: W, h: H });
  const d = img.bitmap.data;
  const rows = new Array(H);
  for (let y = 0; y < H; y++) {
    let r = 0, g = 0, b = 0;
    const base = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = base + x * 4;
      r += d[i]; g += d[i + 1]; b += d[i + 2];
    }
    rows[y] = [r / W, g / W, b / W];
  }
  const deriv = new Array(H).fill(0);
  for (let y = 1; y < H; y++) {
    const a = rows[y], c = rows[y - 1];
    deriv[y] = Math.sqrt((a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2);
  }
  // box-smooth
  const sm = new Array(H).fill(0);
  const h = SMOOTH >> 1;
  for (let y = 0; y < H; y++) {
    let s = 0, n = 0;
    for (let k = -h; k <= h; k++) { const j = y + k; if (j >= 0 && j < H) { s += deriv[j]; n++; } }
    sm[y] = s / n;
  }
  return sm;
}

// Prominent local maxima above (mean + 0.75*std), non-max suppressed, as 0..1 positions.
function boundaries(sm) {
  const H = sm.length;
  const mean = sm.reduce((s, x) => s + x, 0) / H;
  const std = Math.sqrt(sm.reduce((s, x) => s + (x - mean) ** 2, 0) / H) || 1;
  const thr = mean + 0.75 * std;
  const cand = [];
  for (let y = 1; y < H - 1; y++) {
    if (sm[y] >= thr && sm[y] >= sm[y - 1] && sm[y] >= sm[y + 1]) cand.push({ y, v: sm[y] });
  }
  cand.sort((a, b) => b.v - a.v); // strongest first
  const minGap = MIN_SPACING * H;
  const kept = [];
  for (const c of cand) {
    if (kept.every((k) => Math.abs(k - c.y) >= minGap)) kept.push(c.y);
  }
  return kept.map((y) => y / H).sort((a, b) => a - b);
}

// Mean "how close is each boundary in X to its nearest boundary in Y", within TOL.
function nearestAlign(xs, ys) {
  if (!xs.length) return 1; // nothing to place
  let s = 0;
  for (const x of xs) {
    const dist = Math.min(...ys.map((y) => Math.abs(x - y)));
    s += Math.max(0, 1 - dist / TOL);
  }
  return s / xs.length;
}

export const name = "layout";

export async function score({ referencePath, renderPath }) {
  if (!referencePath || !renderPath) return null;
  let A, B;
  try { [A, B] = await Promise.all([profile(referencePath), profile(renderPath)]); }
  catch { return null; }
  const ra = boundaries(A), rb = boundaries(B);
  if (!ra.length && !rb.length) return null;

  const countProx = Math.min(ra.length, rb.length) / (Math.max(ra.length, rb.length) || 1);
  // bidirectional: ref boundaries covered by build, AND build boundaries justified by ref
  const align = 0.5 * nearestAlign(ra, rb) + 0.5 * nearestAlign(rb, ra);
  const s = clamp(100 * (0.65 * align + 0.35 * countProx));

  const findings = [];
  if (countProx < 0.6) {
    findings.push({
      severity: "P1", area: "layout",
      observed: `Build has ${rb.length} major horizontal sections vs ${ra.length} in the original`,
      fix: `Split or merge sections so the page reads as ${ra.length} stacked bands, like the original`,
    });
  } else if (align < 0.55) {
    // count is close but positions drift: find the worst-aligned reference band
    let worst = 0, worstAt = 0;
    for (const x of ra) { const dist = Math.min(...(rb.length ? rb : [1]).map((y) => Math.abs(x - y))); if (dist > worst) { worst = dist; worstAt = x; } }
    findings.push({
      severity: "P1", area: "layout",
      observed: `Section boundaries are misaligned (worst near ${(worstAt * 100) | 0}% down the page)`,
      fix: "Adjust section heights/proportions so each band starts at the same vertical position as the original",
    });
  }
  return { score: s, detail: `bands ref=${ra.length} build=${rb.length} · align ${align.toFixed(2)} · count ${countProx.toFixed(2)}`, findings };
}
