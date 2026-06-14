// Signal: content — did the spec's required text (headings, nav, CTAs) make it
// into the build? Deterministic, non-LLM. Reads built.json.
import fs from "node:fs";
import { clamp } from "./_contract.mjs";

export const name = "content";

export async function score({ specPath, builtPath }) {
  if (!specPath || !builtPath || !fs.existsSync(specPath) || !fs.existsSync(builtPath)) return null;
  let spec, built;
  try { spec = JSON.parse(fs.readFileSync(specPath, "utf-8")); built = JSON.parse(fs.readFileSync(builtPath, "utf-8")); } catch { return null; }

  const required = (spec.content?.required_text || []).map((t) => String(t).toLowerCase().trim()).filter((t) => t.length > 1);
  const builtTexts = (built.texts || []).map((t) => String(t).toLowerCase());
  const blob = builtTexts.join(" \n ");
  if (!required.length) return null;

  let present = 0;
  const missing = [];
  for (const t of required) {
    if (blob.includes(t)) present++;
    else missing.push(t);
  }
  const findings = missing.length
    ? [{ severity: "P1", area: "content", observed: `${missing.length}/${required.length} required strings missing, e.g. "${missing.slice(0, 3).join('", "')}"`, fix: "Add the missing headings, labels, and CTAs from the reference" }]
    : [];
  return { score: clamp((present / required.length) * 100), detail: `${present}/${required.length} required strings present`, findings };
}
