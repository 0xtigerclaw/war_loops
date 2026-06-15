// Signal: structure - does the build reproduce the page's structural shape?
// Deterministic, non-LLM. Reads built.json.
//
// We do NOT name-match regions: the spec's region names are unreliable (generic
// "section_N" on div-soup sites, or noisy duplicate roles), so they don't align
// with the build's descriptive names. Instead we score the shape we CAN compare
// reliably: comparable section COUNT + the presence of header/footer bookends.
// (Whether the right sections are present is judged subjectively by the vision signal.)
import fs from "node:fs";
import { clamp } from "./_contract.mjs";

const HEADERISH = /header|nav|top\b|menu/i;
const FOOTERISH = /footer|copyright|bottom\b/i;

export const name = "structure";

export async function score({ specPath, builtPath }) {
  if (!specPath || !builtPath || !fs.existsSync(specPath) || !fs.existsSync(builtPath)) return null;
  let spec, built;
  try { spec = JSON.parse(fs.readFileSync(specPath, "utf-8")); built = JSON.parse(fs.readFileSync(builtPath, "utf-8")); } catch { return null; }

  const specRegions = (spec.layout?.regions || []).map((r) => r.name || r.role).filter(Boolean);
  const builtRegions = (built.regions || []).filter(Boolean);
  if (!specRegions.length || !builtRegions.length) return null;

  const sc = specRegions.length, bc = builtRegions.length;
  const countRatio = Math.min(sc, bc) / Math.max(sc, bc);

  const hasHeader = builtRegions.some((r) => HEADERISH.test(r));
  const hasFooter = builtRegions.some((r) => FOOTERISH.test(r));
  const bookend = (hasHeader ? 0.5 : 0) + (hasFooter ? 0.5 : 0);

  const s = clamp(80 * countRatio + 20 * bookend);
  const findings = [];
  if (countRatio < 0.6) findings.push({ severity: "P2", area: "layout", observed: `Built ${bc} top-level sections vs ${sc} detected in the reference`, fix: `Bring the number of major sections closer to ${sc}` });
  if (!hasHeader) findings.push({ severity: "P2", area: "layout", observed: "No header/nav region detected in the build", fix: "Add a header/nav section at the top" });
  if (!hasFooter) findings.push({ severity: "P2", area: "layout", observed: "No footer region detected in the build", fix: "Add a footer section at the bottom" });
  return { score: s, detail: `${bc} built vs ${sc} spec sections · bookends ${hasHeader ? "H" : "-"}${hasFooter ? "F" : "-"}`, findings };
}
