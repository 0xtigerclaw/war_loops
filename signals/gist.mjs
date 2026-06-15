// Signal: gist - overall resemblance to the reference, the forgiving counterpart
// to SSIM. Non-LLM, deterministic, zero-dependency (uses jimp, already present).
// Two parts: low-res structural CORRELATION (mean-centered, so it reads layout/
// composition, not brightness) + a coarse COLOR-HISTOGRAM intersection (theme /
// palette). Catches "this doesn't even look like the same kind of page."
import { Jimp } from "jimp";
import fs from "node:fs";
import { clamp } from "./_contract.mjs";

const N = 32; // thumbnail edge

async function thumb(p) {
  const img = await Jimp.read(p);
  img.resize({ w: N, h: N });
  const d = img.bitmap.data;
  const gray = [];
  const hist = new Array(64).fill(0); // 4 bins/channel = 4^3
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    gray.push(r * 0.299 + g * 0.587 + b * 0.114);
    hist[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)]++;
  }
  return { gray, hist };
}

function correlation(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    dot += da * db; na += da * da; nb += db * db;
  }
  return dot / (Math.sqrt(na * nb) || 1); // -1..1
}

function histIntersection(a, b) {
  let inter = 0, tot = 0;
  for (let i = 0; i < a.length; i++) { inter += Math.min(a[i], b[i]); tot += Math.max(a[i], b[i]); }
  return tot ? inter / tot : 0; // 0..1
}

export const name = "gist";

export async function score({ referencePath, renderPath }) {
  if (!referencePath || !renderPath || !fs.existsSync(referencePath) || !fs.existsSync(renderPath)) return null;
  const [a, b] = await Promise.all([thumb(referencePath), thumb(renderPath)]);
  const corr = correlation(a.gray, b.gray);          // -1..1
  const structMapped = Math.max(0, (corr + 1) / 2);  // 0..1
  const color = histIntersection(a.hist, b.hist);    // 0..1
  const sim = 0.55 * structMapped + 0.45 * color;
  const s = clamp(sim * 100);
  const findings = s < 65
    ? [{ severity: "P1", area: "resemblance", observed: `Overall resemblance to the reference is ${s}/100`, fix: "Match the reference's dominant theme, palette, and composition" }]
    : [];
  return { score: s, detail: `gist ${sim.toFixed(3)} (struct ${structMapped.toFixed(2)}, color ${color.toFixed(2)})`, findings };
}
