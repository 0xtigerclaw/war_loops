#!/usr/bin/env node
// Frontend Mirror - spec evaluator (quality gate for Pixel's output).
//
// Takes an extracted DesignSpec and decides whether it is good enough to hand
// to the wireframe/build stages. Runs deterministic gates (schema validity,
// viewport coverage, token completeness, layout, content, placeholder leakage)
// and returns pass | iterate | fail with per-gate scores and findings.
//
// Usage:
//   node warloops/scripts/evaluate-spec.mjs <spec.json> [--json] [--schema <path>]
// Exit codes: 0 = pass, 2 = iterate, 1 = fail (or error).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HEX_RE = /^~?#[0-9a-fA-F]{6}$/;
const SIZE_RE = /\d/;
// Values that mean "the extractor/model left a blank" - these must never survive.
const PLACEHOLDER_RE = /(^|[^a-z])(\.\.\.|#\.\.\.|<url|<image|base64 or path|headline|cta_label|nav items|table values|prices)([^a-z]|$)/i;

// ---- minimal JSON-Schema-subset validator (type/required/properties/items/enum/minItems/minLength) ----
function validateSchema(node, schema, pathStr, errors) {
  if (!schema) return;
  if (schema.$ref === "#/$defs/viewport") schema = ROOT_SCHEMA.$defs.viewport;
  const t = schema.type;
  if (t) {
    const actual = Array.isArray(node) ? "array" : node === null ? "null" : typeof node;
    const ok = t === "number" ? actual === "number" : t === actual;
    if (!ok) { errors.push(`${pathStr}: expected ${t}, got ${actual}`); return; }
  }
  if (schema.enum && !schema.enum.includes(node)) errors.push(`${pathStr}: "${node}" not in [${schema.enum.join(", ")}]`);
  if (t === "string" && schema.minLength && (node || "").length < schema.minLength) errors.push(`${pathStr}: shorter than ${schema.minLength}`);
  if (t === "array") {
    if (schema.minItems && node.length < schema.minItems) errors.push(`${pathStr}: needs >= ${schema.minItems} items, has ${node.length}`);
    if (schema.items) node.forEach((it, i) => validateSchema(it, schema.items, `${pathStr}[${i}]`, errors));
  }
  if (t === "object" && node && typeof node === "object") {
    for (const req of schema.required || []) if (!(req in node)) errors.push(`${pathStr}.${req}: missing required field`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in node) validateSchema(node[k], sub, `${pathStr}.${k}`, errors);
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const [k, v] of Object.entries(node)) if (!known.has(k)) validateSchema(v, schema.additionalProperties, `${pathStr}.${k}`, errors);
    }
  }
}

let ROOT_SCHEMA = {};

// ---- gates ----
function gate(name, status, score, detail) { return { gate: name, status, score, detail }; }

function findPlaceholders(obj, trail = "spec", hits = []) {
  if (typeof obj === "string") { if (PLACEHOLDER_RE.test(obj)) hits.push(`${trail} = "${obj}"`); }
  else if (Array.isArray(obj)) obj.forEach((v, i) => findPlaceholders(v, `${trail}[${i}]`, hits));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) findPlaceholders(v, `${trail}.${k}`, hits);
  return hits;
}

function evaluate(spec, schema) {
  ROOT_SCHEMA = schema;
  const gates = [];
  const findings = [];
  const add = (severity, category, observed, repair) => findings.push({ severity, category, observed, repair });

  // G1 - schema validity (critical)
  const schemaErrors = [];
  validateSchema(spec, schema, "spec", schemaErrors);
  if (schemaErrors.length === 0) gates.push(gate("schema_valid", "pass", 100, "Matches DesignSpec schema"));
  else {
    gates.push(gate("schema_valid", "fail", 0, `${schemaErrors.length} schema error(s)`));
    schemaErrors.slice(0, 8).forEach((e) => add("P0", "schema", e, "Fix field type/presence to match spec.schema.json"));
  }

  // G2 - viewport coverage
  const vps = spec.viewports || {};
  const haveShots = ["desktop", "tablet", "mobile"].filter((k) => vps[k] && vps[k].screenshot);
  const vpScore = Math.round((haveShots.length / 3) * 100);
  gates.push(gate("viewports_complete", vpScore === 100 ? "pass" : vpScore >= 34 ? "fail" : "fail", vpScore, `${haveShots.length}/3 viewports have screenshots`));
  if (haveShots.length < 3) add(haveShots.length === 0 ? "P0" : "P1", "viewports", `Missing screenshots for: ${["desktop","tablet","mobile"].filter((k)=>!haveShots.includes(k)).join(", ")}`, "Re-run extraction to capture all 3 viewports");

  // G3 - token completeness (critical)
  const colors = spec.tokens?.colors || {};
  const realHex = Object.values(colors).filter((c) => HEX_RE.test(String(c)));
  const typo = spec.tokens?.typography || {};
  const typoWithSize = Object.values(typo).filter((v) => v && SIZE_RE.test(String(v.size || "")));
  const spacing = spec.tokens?.spacing || {};
  let tokenScore = 0;
  tokenScore += Math.min(realHex.length, 3) / 3 * 40;       // >=3 valid hex
  tokenScore += Math.min(typoWithSize.length, 3) / 3 * 40;  // >=3 type styles with sizes
  tokenScore += Math.min(Object.keys(spacing).length, 2) / 2 * 20;
  tokenScore = Math.round(tokenScore);
  gates.push(gate("tokens_populated", tokenScore >= 80 ? "pass" : "fail", tokenScore, `${realHex.length} hex colors, ${typoWithSize.length} type styles, ${Object.keys(spacing).length} spacing tokens`));
  if (realHex.length < 3) add("P0", "tokens", `Only ${realHex.length} valid hex colors`, "Extract real colors (background, text, accent) as #rrggbb");
  if (typoWithSize.length < 2) add("P1", "tokens", `Only ${typoWithSize.length} typography styles with sizes`, "Capture h1/body type sizes at minimum");

  // G4 - layout definition
  const regions = spec.layout?.regions || [];
  const namedRegions = regions.filter((r) => r.name && r.role);
  const layoutScore = Math.round(Math.min(namedRegions.length, 3) / 3 * 70 + (spec.layout?.hierarchy ? 30 : 0));
  gates.push(gate("layout_defined", layoutScore >= 80 ? "pass" : "fail", layoutScore, `${namedRegions.length} named regions, hierarchy ${spec.layout?.hierarchy ? "present" : "missing"}`));
  if (namedRegions.length < 3) add("P1", "layout", `Only ${namedRegions.length} regions with name+role`, "Identify at least header/main/footer regions");

  // G5 - content capture
  const reqText = (spec.content?.required_text || []).filter((t) => t && t.trim());
  const contentScore = Math.round(Math.min(reqText.length, 3) / 3 * 100);
  gates.push(gate("content_captured", contentScore >= 100 ? "pass" : "fail", contentScore, `${reqText.length} required_text entries`));
  if (reqText.length < 3) add("P1", "content", `Only ${reqText.length} text strings captured`, "Capture headings, nav, and CTA labels");

  // G6 - no placeholders (critical)
  const placeholders = findPlaceholders(spec);
  gates.push(gate("no_placeholders", placeholders.length === 0 ? "pass" : "fail", placeholders.length === 0 ? 100 : 0, `${placeholders.length} placeholder value(s)`));
  placeholders.slice(0, 8).forEach((p) => add("P0", "placeholder", p, "Replace placeholder with a real extracted value"));

  // ---- aggregate ----
  const weights = { schema_valid: 0.25, viewports_complete: 0.1, tokens_populated: 0.25, layout_defined: 0.15, content_captured: 0.1, no_placeholders: 0.15 };
  const overallScore = Math.round(gates.reduce((s, g) => s + g.score * (weights[g.gate] || 0), 0));
  const criticalFailed = gates.some((g) => ["schema_valid", "tokens_populated", "no_placeholders"].includes(g.gate) && g.status === "fail");

  let decision;
  if (criticalFailed || overallScore < 60) decision = "fail";
  else if (overallScore < 85 || gates.some((g) => g.status === "fail")) decision = "iterate";
  else decision = "pass";

  return { decision, overallScore, gates, findings };
}

// ---- cli ----
function main() {
  const argv = process.argv.slice(2);
  const specPath = argv.find((a) => !a.startsWith("--"));
  const asJson = argv.includes("--json");
  const schemaArg = argv[argv.indexOf("--schema") + 1];
  if (!specPath) { console.error("Usage: evaluate-spec.mjs <spec.json> [--json] [--schema <path>]"); process.exit(64); }

  const schemaPath = schemaArg && !schemaArg.startsWith("--") ? schemaArg : path.join(__dirname, "spec.schema.json");
  const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), "utf-8"));
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const result = evaluate(spec, schema);

  if (asJson) { console.log(JSON.stringify(result, null, 2)); }
  else {
    const icon = { pass: "✅", iterate: "🔁", fail: "❌" }[result.decision];
    console.log(`\n${icon}  SPEC ${result.decision.toUpperCase()} - score ${result.overallScore}/100  (${path.basename(specPath)})\n`);
    for (const g of result.gates) {
      const gi = { pass: "✓", fail: "✗" }[g.status] || "•";
      console.log(`  ${gi} ${g.gate.padEnd(20)} ${String(g.score).padStart(3)}  ${g.detail}`);
    }
    if (result.findings.length) {
      console.log(`\n  Findings (${result.findings.length}):`);
      for (const f of result.findings) console.log(`    [${f.severity}] ${f.category}: ${f.observed}\n          → ${f.repair}`);
    }
    console.log("");
  }
  process.exit(result.decision === "pass" ? 0 : result.decision === "iterate" ? 2 : 1);
}

main();
