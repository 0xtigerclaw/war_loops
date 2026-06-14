// Signal: tokens — do the design tokens the spec extracted (colors, fonts)
// actually appear in the built design's variables? Deterministic, non-LLM.
// Reads built.json (emitted by the build: { variables, regions, texts }).
import fs from "node:fs";
import { clamp } from "./_contract.mjs";

const HEX = /^#?[0-9a-fA-F]{6}$/;
const norm = (c) => String(c).replace(/^#/, "").toLowerCase();

export const name = "tokens";

export async function score({ specPath, builtPath }) {
  if (!specPath || !builtPath || !fs.existsSync(specPath) || !fs.existsSync(builtPath)) return null;
  let spec, built;
  try { spec = JSON.parse(fs.readFileSync(specPath, "utf-8")); built = JSON.parse(fs.readFileSync(builtPath, "utf-8")); } catch { return null; }

  const vals = Object.values(built.variables || {}).map((v) => String(v).toLowerCase());
  const builtHex = vals.filter((v) => HEX.test(v.startsWith("#") ? v : "#" + v)).map(norm);
  const checks = [];
  const findings = [];

  for (const [k, raw] of Object.entries(spec.tokens?.colors || {})) {
    const h = norm(String(raw).replace(/^~/, ""));
    if (!HEX.test("#" + h)) continue;
    const present = builtHex.includes(h);
    checks.push(present);
    if (!present) findings.push({ severity: "P2", area: "color", observed: `Spec color ${k}=#${h} is not among the build's variables`, fix: `Define a variable = #${h} and apply it where ${k} belongs` });
  }

  const specFams = [...new Set(Object.values(spec.tokens?.typography || {}).map((t) => String(t.family || "").toLowerCase()).filter(Boolean))];
  for (const fam of specFams) {
    const present = vals.some((v) => v.includes(fam));
    checks.push(present);
    if (!present) findings.push({ severity: "P2", area: "type", observed: `Font "${fam}" from the spec is not used in the build`, fix: `Use ${fam} for the matching text` });
  }

  if (checks.length === 0) return null;
  const matched = checks.filter(Boolean).length;
  return { score: clamp((matched / checks.length) * 100), detail: `${matched}/${checks.length} tokens matched`, findings };
}
