#!/usr/bin/env node
// Frontend Mirror — deterministic spec extractor (Pixel's eyes).
//
// URL mode: launches headless Chromium (playwright-core), captures screenshots
// at 3 viewports, and reads REAL computed styles / DOM text. No guessing.
// Image mode: emits a spec template + screenshot copy for the model to fill via
// vision, then validate with evaluate-spec.mjs.
//
// Usage:
//   node warloops/scripts/extract-spec.mjs --url <url> [--out <dir>] [--name <label>]
//   node warloops/scripts/extract-spec.mjs --image <path> [--out <dir>] [--name <label>]
//
// Output: <out>/spec.json (+ <out>/screenshots/{desktop,tablet,mobile}.png for URLs)

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  }
  return args;
}

function slugify(s) {
  return (s || "spec").toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "spec";
}

// ---- in-page extraction (runs inside the browser) -------------------------
// Defined as a string-free function reference passed to page.evaluate.
function pageExtract() {
  const toHex = (rgb) => {
    if (!rgb) return null;
    const m = rgb.match(/rgba?\(([^)]+)\)/);
    if (!m) return rgb.startsWith("#") ? rgb.toLowerCase() : null;
    const parts = m[1].split(",").map((x) => x.trim());
    const [r, g, b, a] = parts;
    if (a !== undefined && parseFloat(a) === 0) return null; // fully transparent
    const h = (n) => Number(n).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0;
  };

  const all = [...document.querySelectorAll("*")].filter(visible).slice(0, 4000);

  // --- color frequency (weighted by element area) ---
  const colorArea = {};
  const bgArea = {};
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    const cs = getComputedStyle(el);
    const c = toHex(cs.color);
    const bg = toHex(cs.backgroundColor);
    if (c) colorArea[c] = (colorArea[c] || 0) + area * 0.02; // text weighted less
    if (bg) bgArea[bg] = (bgArea[bg] || 0) + area;
  }
  const topBy = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);

  const saturation = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  };

  const background = topBy(bgArea, 1)[0] || "#ffffff";
  const text = topBy(colorArea, 1)[0] || "#000000";

  // accent: most saturated color used on buttons / links / their backgrounds
  const accentCandidates = {};
  for (const el of all) {
    if (!/^(a|button)$/i.test(el.tagName) && el.getAttribute("role") !== "button") continue;
    const cs = getComputedStyle(el);
    for (const v of [toHex(cs.backgroundColor), toHex(cs.color), toHex(cs.borderColor)]) {
      if (v && v !== background && v !== "#ffffff" && v !== "#000000") {
        accentCandidates[v] = (accentCandidates[v] || 0) + saturation(v) + 0.1;
      }
    }
  }
  const accent = Object.entries(accentCandidates).sort((a, b) => b[1] - a[1])[0]?.[0] || topBy(colorArea, 3).find((c) => saturation(c) > 0.3) || text;

  // --- typography ---
  const typo = {};
  const sampleType = (key, sel) => {
    const el = document.querySelector(sel);
    if (!el || !visible(el)) return;
    const cs = getComputedStyle(el);
    typo[key] = {
      size: cs.fontSize,
      weight: cs.fontWeight,
      family: cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
      line_height: cs.lineHeight,
    };
  };
  sampleType("h1", "h1");
  sampleType("h2", "h2");
  sampleType("h3", "h3");
  sampleType("body", "p");
  sampleType("label", "button, .btn, label, nav a");

  // --- spacing (vertical rhythm between top-level sections + base padding) ---
  const sections = [...document.querySelectorAll("body > *, main > section, section, header, footer")].filter(visible);
  let sectionGap = null, padding = null;
  for (const el of sections) {
    const cs = getComputedStyle(el);
    if (!sectionGap && (parseFloat(cs.paddingTop) > 24 || parseFloat(cs.marginTop) > 24)) {
      sectionGap = `${Math.round(Math.max(parseFloat(cs.paddingTop), parseFloat(cs.marginTop)))}px`;
    }
    if (!padding && parseFloat(cs.paddingLeft) > 8) padding = `${Math.round(parseFloat(cs.paddingLeft))}px`;
  }

  // --- layout regions ---
  const roleFor = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "header") return "header";
    if (tag === "nav") return "navigation";
    if (tag === "footer") return "footer";
    if (tag === "main") return "main";
    if (el.getAttribute("role")) return el.getAttribute("role");
    return "section";
  };
  // Prefer semantic landmarks; fall back to geometric layout blocks for
  // div-soup SPAs (most modern sites) that ship no <header>/<main>/<section>.
  const vw = window.innerWidth;
  const docH = document.documentElement.scrollHeight;
  let regionEls = [...document.querySelectorAll("header, nav, main, footer, body > section, main > section")].filter(visible);
  if (regionEls.length < 3) {
    const wideTall = [...document.querySelectorAll("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      return visible(el) && r.width >= vw * 0.6 && r.height >= 80 && el.children.length > 0;
    });
    let best = null, bestCount = 0;
    for (const el of wideTall) {
      const kids = [...el.children].filter((c) => {
        const r = c.getBoundingClientRect();
        return visible(c) && r.width >= vw * 0.5 && r.height >= 60;
      });
      if (kids.length > bestCount) { bestCount = kids.length; best = el; }
    }
    if (best && bestCount >= 3) {
      regionEls = [...best.children].filter((c) => {
        const r = c.getBoundingClientRect();
        return visible(c) && r.width >= vw * 0.5 && r.height >= 40;
      });
    }
  }
  regionEls = regionEls.slice(0, 14);

  const regions = regionEls.map((el, i) => {
    const r = el.getBoundingClientRect();
    const top = r.top + window.scrollY;
    let role = roleFor(el);
    if (role === "section") {
      const linkCount = el.querySelectorAll("a").length;
      if (i === 0 && r.height < 160) role = "header";
      else if (top + r.height > docH - 12 || (i === regionEls.length - 1 && linkCount > 4)) role = "footer";
      else if (i === 0 && linkCount > 4 && r.height < 240) role = "navigation";
    }
    const name = el.id || el.getAttribute("aria-label") || (["header", "navigation", "footer", "main"].includes(role) ? role : `section_${i + 1}`);
    const childTags = [...new Set([...el.children].filter(visible).map((c) => c.id || c.getAttribute("aria-label") || c.tagName.toLowerCase()))].slice(0, 6);
    return { name, role, children: childTags, approximate_height: `${Math.round(r.height)}px` };
  });
  const hierarchy = regions.map((r) => r.name).join(" > ") || "body";

  // --- content ---
  const txt = (sel) => [...document.querySelectorAll(sel)].filter(visible).map((e) => e.textContent.trim()).filter((t) => t && t.length < 120);
  // Heading-like text for div-soup sites: leaf nodes rendered noticeably larger than body.
  const bodyFs = parseFloat(getComputedStyle(document.body).fontSize) || 16;
  const headingLike = all
    .filter((el) => el.childElementCount === 0 && parseFloat(getComputedStyle(el).fontSize) >= bodyFs * 1.4)
    .map((el) => el.textContent.trim())
    .filter((t) => t && t.length > 1 && t.length < 80);
  const required_text = [...new Set([
    ...txt("h1, h2, h3"),
    ...headingLike,
    ...txt("nav a, header a"),
    ...txt("button, .btn, a.button, [role=button]"),
  ])].slice(0, 40);

  const dataRe = /(\$\s?\d[\d,.]*|\d[\d,.]*\s?(%|x|k\+?|m\+?|ms|s|gb|tb)|\b\d{2,}[\d,.]*\b)/i;
  const required_data = [...new Set(
    [...document.querySelectorAll("body *")].filter(visible)
      .map((e) => (e.childElementCount === 0 ? e.textContent.trim() : ""))
      .filter((t) => t && t.length < 40 && dataRe.test(t))
  )].slice(0, 30);

  // --- interactions ---
  const states = ["default"];
  if (document.querySelector("a, button, [role=button]")) states.push("hover");
  if (document.querySelector("[aria-haspopup], [aria-expanded], details, .dropdown")) states.push("open");
  if (document.querySelector("input, textarea, select")) states.push("focus");
  const elements = [];
  if (document.querySelector("[aria-haspopup], .dropdown, details")) elements.push({ type: "dropdown", trigger: "nav item", state: "open" });
  if (document.querySelector("dialog, [role=dialog], .modal")) elements.push({ type: "modal", trigger: "cta button", state: "open" });
  if (document.querySelector("a, button")) elements.push({ type: "button", trigger: "pointer", state: "hover" });

  return {
    title: document.title,
    tokens: {
      colors: { primary: accent, background, text, accent },
      typography: typo,
      spacing: { section_gap: sectionGap || "64px", padding: padding || "16px" },
    },
    layout: { regions, hierarchy },
    content: { required_text, required_data },
    interactions: { states: [...new Set(states)], elements },
  };
}

async function extractUrl(url, outDir, name, opts = {}) {
  const settle = Number.isFinite(opts.settle) ? opts.settle : 1200;
  const scroll = !!opts.scroll;
  fs.mkdirSync(path.join(outDir, "screenshots"), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let analysis = null;
  const viewports = {};
  try {
    for (const [key, vp] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(async () => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      });
      await page.waitForTimeout(settle); // let lazy content settle
      if (scroll) {
        // Scroll through the full page to trigger lazy-loaded / on-view content.
        await page.evaluate(async () => {
          await new Promise((res) => {
            let y = 0;
            const step = window.innerHeight;
            const timer = setInterval(() => {
              window.scrollBy(0, step);
              y += step;
              if (y >= document.body.scrollHeight) { clearInterval(timer); window.scrollTo(0, 0); res(); }
            }, 100);
          });
        });
        await page.waitForTimeout(600);
      }
      const shotPath = path.join(outDir, "screenshots", `${key}.png`);
      await page.screenshot({ path: shotPath, fullPage: true });
      viewports[key] = { width: vp.width, height: vp.height, screenshot: path.relative(outDir, shotPath) };
      if (key === "desktop") analysis = await page.evaluate(pageExtract);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  return {
    source_type: "url",
    source_ref: url,
    extracted_at: new Date().toISOString(),
    extractor: "playwright",
    name: name || analysis?.title || slugify(url),
    viewports,
    layout: analysis.layout,
    tokens: analysis.tokens,
    content: analysis.content,
    interactions: analysis.interactions,
  };
}

function imageTemplate(imagePath, outDir, name) {
  const shotDir = path.join(outDir, "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });
  const dest = path.join(shotDir, "source" + path.extname(imagePath));
  try { fs.copyFileSync(imagePath, dest); } catch { /* leave reference */ }
  return {
    source_type: "image",
    source_ref: imagePath,
    extracted_at: new Date().toISOString(),
    extractor: "vision",
    name: name || slugify(imagePath),
    _instructions: "IMAGE MODE: open the source image, then fill every field below from what you observe. Prefix any estimated value with '~'. Then run evaluate-spec.mjs to verify completeness.",
    viewports: {
      desktop: { width: 1440, screenshot: path.relative(outDir, dest) },
      tablet: { width: 1024, screenshot: "" },
      mobile: { width: 390, screenshot: "" },
    },
    layout: { regions: [], hierarchy: "" },
    tokens: { colors: {}, typography: {}, spacing: {} },
    content: { required_text: [], required_data: [] },
    interactions: { states: ["default"], elements: [] },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url && !args.image) {
    console.error("Usage: extract-spec.mjs --url <url> | --image <path> [--out <dir>] [--name <label>]");
    process.exit(64);
  }
  const ref = args.url || args.image;
  const outDir = path.resolve(args.out || path.join(".mirror-specs", slugify(ref)));
  fs.mkdirSync(outDir, { recursive: true });

  const spec = args.url
    ? await extractUrl(args.url, outDir, args.name, { settle: args.settle ? parseInt(args.settle, 10) : undefined, scroll: !!args.scroll })
    : imageTemplate(args.image, outDir, args.name);

  const specPath = path.join(outDir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  console.log(`[extract-spec] ${spec.source_type} spec written: ${specPath}`);
  if (spec.source_type === "url") {
    console.log(`[extract-spec] screenshots: ${path.join(outDir, "screenshots")} (desktop/tablet/mobile)`);
    console.log(`[extract-spec] colors=${JSON.stringify(spec.tokens.colors)} regions=${spec.layout.regions.length} text=${spec.content.required_text.length}`);
  } else {
    console.log(`[extract-spec] template only — fill via vision, then evaluate.`);
  }
  console.log(specPath);
}

main().catch((e) => { console.error("[extract-spec] FAILED:", e.message); process.exit(1); });
