// Signal: structure — do the spec's layout regions appear in the build, in
// roughly the right count? Deterministic, non-LLM. Reads built.json.
import fs from "node:fs";
import { clamp } from "./_contract.mjs";

const toks = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
function similar(a, b) {
  const A = new Set(toks(a)), B = new Set(toks(b));
  if (!A.size || !B.size) return 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / Math.min(A.size, B.size);
}

export const name = "structure";

export async function score({ specPath, builtPath }) {
  if (!specPath || !builtPath || !fs.existsSync(specPath) || !fs.existsSync(builtPath)) return null;
  let spec, built;
  try { spec = JSON.parse(fs.readFileSync(specPath, "utf-8")); built = JSON.parse(fs.readFileSync(builtPath, "utf-8")); } catch { return null; }

  const specRegions = (spec.layout?.regions || []).map((r) => r.name || r.role).filter(Boolean);
  const builtRegions = (built.regions || []).filter(Boolean);
  if (!specRegions.length || !builtRegions.length) return null;

  let matched = 0;
  const findings = [];
  for (const sr of specRegions) {
    if (builtRegions.some((br) => similar(sr, br) >= 0.5)) matched++;
    else findings.push({ severity: "P2", area: "layout", observed: `Spec region "${sr}" has no clear match in the build`, fix: `Add a "${sr}" section in the right position` });
  }
  const coverage = matched / specRegions.length;
  const countRatio = Math.min(builtRegions.length, specRegions.length) / Math.max(builtRegions.length, specRegions.length);
  const s = clamp((0.7 * coverage + 0.3 * countRatio) * 100);
  return { score: s, detail: `${matched}/${specRegions.length} regions matched (${builtRegions.length} built)`, findings };
}
