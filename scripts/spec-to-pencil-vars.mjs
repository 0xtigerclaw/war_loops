#!/usr/bin/env node
// Frontend Mirror — deterministic token translator (spec → Pencil variables).
//
// Maps a DesignSpec's measured tokens (colors, typography, spacing) to a
// Pencil set_variables payload. This is the deterministic half of the hybrid
// Wireframe stage: the exact extracted values become the design system, so the
// agent builds layout WITHOUT re-guessing colors/fonts/sizes.
//
// Usage:
//   node warloops/scripts/spec-to-pencil-vars.mjs <spec.json> [--out <vars.json>]
// Prints the variables payload as JSON (and writes it if --out is given).

import fs from "node:fs";
import path from "node:path";

const HEX_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

function cleanHex(v) {
  const s = String(v).replace(/^~/, "").trim(); // drop image-mode estimate marker
  return HEX_RE.test(s) ? s.toLowerCase() : null;
}

function px(v) {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function specToVars(spec) {
  const vars = {};
  const colors = spec.tokens?.colors || {};
  for (const [key, raw] of Object.entries(colors)) {
    const hex = cleanHex(raw);
    if (hex) vars[`color-${key}`] = { type: "color", value: hex };
  }

  const typo = spec.tokens?.typography || {};
  // Font families: heading (from h1, fallback h2) and body.
  const headingFamily = typo.h1?.family || typo.h2?.family;
  const bodyFamily = typo.body?.family || typo.label?.family;
  if (headingFamily) vars["font-heading"] = { type: "string", value: headingFamily };
  if (bodyFamily) vars["font-body"] = { type: "string", value: bodyFamily };
  // Sizes + weights per named style.
  for (const [key, style] of Object.entries(typo)) {
    const size = px(style?.size);
    if (size) vars[`text-${key}`] = { type: "number", value: size };
    if (style?.weight) vars[`weight-${key}`] = { type: "string", value: String(style.weight) };
  }

  const spacing = spec.tokens?.spacing || {};
  for (const [key, raw] of Object.entries(spacing)) {
    const n = px(raw);
    if (n != null) vars[`space-${key.replace(/_/g, "-")}`] = { type: "number", value: n };
  }

  return vars;
}

function main() {
  const argv = process.argv.slice(2);
  const specPath = argv.find((a) => !a.startsWith("--"));
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
  if (!specPath) { console.error("Usage: spec-to-pencil-vars.mjs <spec.json> [--out <vars.json>]"); process.exit(64); }

  const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), "utf-8"));
  const vars = specToVars(spec);

  const json = JSON.stringify(vars, null, 2);
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), json);
    console.error(`[spec-to-pencil-vars] ${Object.keys(vars).length} variables → ${outPath}`);
  }
  console.log(json);
}

main();
