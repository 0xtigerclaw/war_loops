#!/usr/bin/env node
// Frontend Mirror - deterministic spec extractor (Pixel's eyes).
//
// URL mode captures screenshots at 3 viewports and reads REAL computed styles /
// DOM text. To get past bot walls (Cloudflare etc.) it drives a GENUINE browser:
//   - default: real Chrome with a persistent profile (channel:"chrome", headed),
//     waiting for any JS challenge to auto-clear; the clearance cookie persists.
//   - --cdp <url>: attach to an already-running Chrome over CDP (your real
//     session, cookies + logins intact). Most robust for protected/auth pages.
//   - --headless: legacy bundled-Chromium headless (fast, but bot-walls block it).
// A `blocked` flag is set if we still land on a challenge page.
// Image mode emits a spec template + screenshot copy for the model to fill via vision.
//
// Usage:
//   node warloops/scripts/extract-spec.mjs --url <url> [--out <dir>] [--name <label>]
//                                          [--cdp http://localhost:9222] [--headless] [--profile <dir>]
//   node warloops/scripts/extract-spec.mjs --image <path> [--out <dir>] [--name <label>]
//
// Output: <out>/spec.json (+ <out>/screenshots/{desktop,tablet,mobile}.png for URLs)

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Signatures of bot-wall / challenge / interstitial pages.
const CHALLENGE_RE = /just a moment|checking your browser|verifying you are (a )?human|attention required|performing security verification|verifying\.\.\.|enable javascript and cookies|ddos protection by/i;

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

// ---- in-page MOTION extraction (runs inside the browser) ------------------
// The experiential layer the static spec misses: CSS animations, transitions,
// @keyframes, scroll-reveal, and which animation library drives them. Read
// deterministically from computed styles + same-origin stylesheets. This makes
// motion VISIBLE and inspectable in the spec even before the build can honor it
// (the prerequisite for a motion-match signal and animated code output later).
function motionExtract() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = (typeof el.className === "string" && el.className.trim()) ? "." + el.className.trim().split(/\s+/)[0] : "";
    return tag + cls;
  };
  const first = (v) => (v || "").split(",")[0].trim();

  // 1. @keyframes inventory (same-origin sheets only; cross-origin .cssRules throws)
  const keyframes = [];
  const kfNames = new Set();
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    for (const rule of rules) {
      const isKf = rule.type === 7 || (rule.constructor && rule.constructor.name === "CSSKeyframesRule");
      if (!isKf || kfNames.has(rule.name)) continue;
      kfNames.add(rule.name);
      const props = new Set();
      for (const kf of rule.cssRules || []) { const st = kf.style; for (let i = 0; i < (st?.length || 0); i++) props.add(st[i]); }
      keyframes.push({ name: rule.name, props: [...props].slice(0, 8) });
    }
  }

  // 2. animated + transitioned elements
  const animated = [], transitions = [];
  let hasInfinite = false;
  const all = [...document.querySelectorAll("body *")];
  const seenA = new Set(), seenT = new Set();
  for (const el of all) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const an = cs.animationName;
    if (an && an !== "none" && animated.length < 50) {
      const key = sel(el) + "|" + an;
      if (!seenA.has(key)) {
        seenA.add(key);
        const iter = first(cs.animationIterationCount);
        if (iter === "infinite") hasInfinite = true;
        animated.push({ selector: sel(el), name: first(an), duration: first(cs.animationDuration), timing: first(cs.animationTimingFunction), iteration: iter, delay: first(cs.animationDelay) });
      }
    }
    const tp = cs.transitionProperty;
    if (tp && tp !== "none" && (parseFloat(cs.transitionDuration) || 0) > 0 && transitions.length < 60) {
      const s = sel(el);
      if (!seenT.has(s)) {
        seenT.add(s);
        transitions.push({ selector: s, props: tp.split(",").map((x) => x.trim()).slice(0, 6), duration: first(cs.transitionDuration), timing: first(cs.transitionTimingFunction) });
      }
    }
  }

  // 3. library + scroll-reveal detection
  const w = window, libs = [];
  if (w.gsap || w.TweenMax || w.TweenLite) libs.push("gsap");
  if (w.AOS || document.querySelector("[data-aos]")) libs.push("aos");
  if (w.Motion || document.querySelector("[data-framer-name], [data-projection-id]")) libs.push("framer-motion");
  if (w.lottie || document.querySelector("lottie-player, [data-animation-path]")) libs.push("lottie");
  if (w.ScrollMagic) libs.push("scrollmagic");
  if (document.querySelector("[data-scroll], [data-scroll-speed]")) libs.push("locomotive");

  let revealCandidates = 0;
  for (const el of all) {
    const cs = getComputedStyle(el);
    if ((parseFloat(cs.transitionDuration) || 0) > 0 && (parseFloat(cs.opacity) < 0.1 || (cs.transform && cs.transform !== "none"))) {
      if (++revealCandidates > 200) break;
    }
  }
  const revealMarker = document.querySelector("[data-aos], [data-scroll], [data-animate], [data-sr], .reveal, .fade-in, .animate-on-scroll");
  const detected = !!revealMarker || libs.some((l) => ["aos", "gsap", "locomotive", "scrollmagic"].includes(l)) || revealCandidates > 3;
  const scroll_reveal = {
    detected,
    mechanism: revealMarker ? "attribute/class marker" : (libs.length ? `library:${libs[0]}` : (revealCandidates > 3 ? "inferred (hidden + transition)" : "none")),
    candidates: revealCandidates,
  };

  return {
    libraries: [...new Set(libs)],
    keyframes: keyframes.slice(0, 30),
    animated,
    transitions,
    scroll_reveal,
    summary: { animated_count: animated.length, transition_count: transitions.length, keyframe_count: keyframes.length, has_infinite: hasInfinite, has_scroll_reveal: detected },
  };
}

// Acquire a browser context. Default = genuine Chrome with a persistent profile
// (passes bot walls); --cdp attaches to a running Chrome; --headless = legacy.
async function getBrowserContext(opts) {
  if (opts.cdp) {
    const browser = await chromium.connectOverCDP(opts.cdp);
    const context = browser.contexts()[0] || (await browser.newContext());
    return { context, mode: "cdp", cleanup: async () => { await browser.close().catch(() => {}); } };
  }
  if (opts.headless) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORTS.desktop, deviceScaleFactor: 1 });
    return { context, mode: "headless", cleanup: async () => browser.close() };
  }
  const userDataDir = opts.profile || path.join(os.homedir(), ".war-loops", "chrome-profile");
  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: false,
    viewport: VIEWPORTS.desktop,
    deviceScaleFactor: 1,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  });
  return { context, mode: "chrome", cleanup: async () => context.close() };
}

// Wait for a Cloudflare-style JS challenge to auto-resolve (a real browser clears
// it within a few seconds; the page title stops matching the challenge text).
async function waitForChallengeClear(page, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => "");
    if (!CHALLENGE_RE.test(title || "")) return;
    await page.waitForTimeout(1500);
  }
}

function looksBlocked(title, bodyText, regionCount) {
  if (CHALLENGE_RE.test(title || "") || CHALLENGE_RE.test(bodyText || "")) return true;
  return regionCount === 0 && /cloudflare|ray id/i.test(bodyText || "");
}

async function autoScroll(page) {
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

async function extractUrl(url, outDir, name, opts = {}) {
  const settle = Number.isFinite(opts.settle) ? opts.settle : 1500;
  const scroll = !!opts.scroll;
  fs.mkdirSync(path.join(outDir, "screenshots"), { recursive: true });
  const { context, mode, cleanup } = await getBrowserContext(opts);
  let analysis = null;
  let motion = null;
  let blocked = false;
  const viewports = {};
  try {
    for (const [key, vp] of Object.entries(VIEWPORTS)) {
      const page = await context.newPage();
      await page.setViewportSize(vp).catch(() => {}); // CDP real tabs may not allow override
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(settle);
      await waitForChallengeClear(page); // let the bot-wall JS challenge auto-resolve
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      if (scroll) await autoScroll(page);
      const shotPath = path.join(outDir, "screenshots", `${key}.png`);
      await page.screenshot({ path: shotPath, fullPage: true });
      viewports[key] = { width: vp.width, height: vp.height, screenshot: path.relative(outDir, shotPath) };
      if (key === "desktop") {
        analysis = await page.evaluate(pageExtract);
        motion = await page.evaluate(motionExtract).catch(() => null);
        const bodyText = await page.evaluate(() => (document.body && document.body.innerText ? document.body.innerText.slice(0, 500) : "")).catch(() => "");
        blocked = looksBlocked(analysis.title, bodyText, analysis.layout.regions.length);
      }
      await page.close();
    }
  } finally {
    await cleanup();
  }

  return {
    source_type: "url",
    source_ref: url,
    extracted_at: new Date().toISOString(),
    extractor: mode === "cdp" ? "playwright-cdp" : mode === "chrome" ? "playwright-chrome" : "playwright-headless",
    blocked,
    name: name || analysis?.title || slugify(url),
    viewports,
    layout: analysis.layout,
    tokens: analysis.tokens,
    content: analysis.content,
    interactions: analysis.interactions,
    motion: motion || { libraries: [], keyframes: [], animated: [], transitions: [], scroll_reveal: { detected: false, mechanism: "none", candidates: 0 }, summary: { animated_count: 0, transition_count: 0, keyframe_count: 0, has_infinite: false, has_scroll_reveal: false } },
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
    ? await extractUrl(args.url, outDir, args.name, {
        settle: args.settle ? parseInt(args.settle, 10) : undefined,
        scroll: !!args.scroll,
        cdp: typeof args.cdp === "string" ? args.cdp : undefined,
        headless: !!args.headless,
        profile: typeof args.profile === "string" ? args.profile : undefined,
      })
    : imageTemplate(args.image, outDir, args.name);

  const specPath = path.join(outDir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  console.log(`[extract-spec] ${spec.source_type} spec written: ${specPath}`);
  if (spec.source_type === "url") {
    console.log(`[extract-spec] mode=${spec.extractor} screenshots: ${path.join(outDir, "screenshots")} (desktop/tablet/mobile)`);
    console.log(`[extract-spec] colors=${JSON.stringify(spec.tokens.colors)} regions=${spec.layout.regions.length} text=${spec.content.required_text.length} blocked=${spec.blocked}`);
    const m = spec.motion?.summary || {};
    console.log(`[extract-spec] motion: ${m.animated_count || 0} animated, ${m.transition_count || 0} transitions, ${m.keyframe_count || 0} keyframes${m.has_infinite ? ", has-infinite" : ""}${m.has_scroll_reveal ? ", scroll-reveal" : ""}${spec.motion?.libraries?.length ? ", libs=[" + spec.motion.libraries.join(",") + "]" : ""}`);
    if (spec.blocked) console.error(`[extract-spec] ⚠️  BLOCKED: landed on a bot-wall / challenge page. Try --cdp <runningChromeUrl>, re-run (profile may clear on retry), or use image mode.`);
  } else {
    console.log(`[extract-spec] template only - fill via vision, then evaluate.`);
  }
  console.log(specPath);
}

main().catch((e) => { console.error("[extract-spec] FAILED:", e.message); process.exit(1); });
