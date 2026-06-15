// Signal: perceptual — SSIM (structural similarity) between the reference and
// the render. Non-LLM, deterministic. Catches layout drift, missing sections,
// wrong proportions. Both images are normalized to a common size first.
import { Jimp } from "jimp";
import fs from "node:fs";
import * as SSIM from "ssim.js";
import { clamp } from "./_contract.mjs";

const ssim = SSIM.ssim || SSIM.default;
const W = 768, H = 1024;

async function load(p) {
  const img = await Jimp.read(p);
  img.resize({ w: W, h: H });
  return { data: new Uint8ClampedArray(img.bitmap.data), width: img.bitmap.width, height: img.bitmap.height };
}

export const name = "perceptual";

export async function score({ referencePath, renderPath }) {
  if (!referencePath || !renderPath || !fs.existsSync(referencePath) || !fs.existsSync(renderPath)) return null;
  const [a, b] = await Promise.all([load(referencePath), load(renderPath)]);
  const { mssim } = ssim(a, b);
  const m = Math.max(0, Math.min(1, mssim));
  const s = clamp(m * 100);
  const findings = s < 70
    ? [{ severity: "P1", area: "structure", observed: `Structural similarity to the reference is only ${s}/100`, fix: "Align section sizes, order, and overall proportions to the reference" }]
    : [];
  return { score: s, detail: `SSIM ${m.toFixed(3)}`, findings };
}
