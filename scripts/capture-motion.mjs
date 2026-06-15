#!/usr/bin/env node
// capture-motion - record a short frame sequence of a page's motion (held at the
// top: entrance animations + ambient/looping motion, no scroll confound) and
// reduce it to a motion-energy TIMELINE. This is the deterministic basis for a
// real motion-match: not "does the build have motion" (a count) but "does it move
// like the original, at the same moments, in the same places."
//
// Output: <out>/motion-frames.json { energy[], bandEnergy[][], totalEnergy } and
// the raw frames under <out>/frames/.
//
// Usage: node capture-motion.mjs --url <url|file://...> --out <dir>
//        [--frames 12] [--interval 200] [--headless] [--cdp <url>]
import { chromium } from "playwright-core";
import { Jimp } from "jimp";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const has = (f) => process.argv.includes(f);

const url = arg("--url");
const outDir = path.resolve(arg("--out", "./motion-capture"));
const FRAMES = parseInt(arg("--frames", "12"), 10);
const INTERVAL = parseInt(arg("--interval", "200"), 10);
const SCROLL_REVEAL = has("--scroll-reveal");
const SR_SETTLE = parseInt(arg("--sr-settle", "900"), 10); // ms for a (CPU-throttled) reveal to play out
const SR_POSITIONS = [0.15, 0.35, 0.55, 0.78];
if (!url) { console.error("Usage: capture-motion.mjs --url <url> --out <dir> [--frames N] [--interval ms] [--headless] [--cdp <url>]"); process.exit(64); }
fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };
const CHALLENGE_RE = /just a moment|checking your browser|verifying you are/i;

// Browser modes mirror the spec extractor: genuine Chrome by default (beats bot
// walls), --cdp to attach, --headless for local files / speed.
async function getContext() {
  if (has("--cdp")) { const b = await chromium.connectOverCDP(arg("--cdp")); return { context: b.contexts()[0] || (await b.newContext()), cleanup: async () => b.close().catch(() => {}) }; }
  if (has("--headless")) { const b = await chromium.launch({ headless: true }); return { context: await b.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 }), cleanup: async () => b.close() }; }
  const dir = path.join(os.homedir(), ".war-loops", "chrome-profile");
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: "chrome", headless: false, viewport: VIEWPORT, deviceScaleFactor: 1, args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"] });
  return { context: ctx, cleanup: async () => ctx.close() };
}

async function capture() {
  const { context, cleanup } = await getContext();
  const frames = [];
  const srPairs = []; // [{ pos, immediate, settled }]
  try {
    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT).catch(() => {});
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    for (let w = 0; w < 8; w++) { const t = await page.title().catch(() => ""); if (!CHALLENGE_RE.test(t || "")) break; await page.waitForTimeout(1000); }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    // hold at the top and sample the viewport over time: entrance + ambient motion
    for (let i = 0; i < FRAMES; i++) {
      const p = path.join(outDir, "frames", `t${String(i).padStart(3, "0")}.png`);
      await page.screenshot({ path: p }).catch(() => {});
      if (fs.existsSync(p)) frames.push(p);
      if (i < FRAMES - 1) await page.waitForTimeout(INTERVAL);
    }
    // scroll-reveal: at each position, capture immediately then after a settle. Both
    // frames are at the SAME scroll offset, so their difference is the reveal
    // animation itself (content fading/sliding in), with no scroll-translation confound.
    if (SCROLL_REVEAL) {
      // Reveals often complete faster than screenshot latency. CPU-throttle the
      // page so the animation plays slowly enough to catch between immediate and
      // settled frames at the same scroll offset.
      let cdp;
      try { cdp = await page.context().newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 }); } catch { cdp = null; }
      const max = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - window.innerHeight)).catch(() => 0);
      let i = 0;
      for (const pos of SR_POSITIONS) {
        await page.evaluate((y) => window.scrollTo(0, y), Math.round(pos * max)).catch(() => {});
        const imm = path.join(outDir, "frames", `sr${i}-a.png`);
        await page.screenshot({ path: imm }).catch(() => {});
        await page.waitForTimeout(SR_SETTLE);
        const set = path.join(outDir, "frames", `sr${i}-b.png`);
        await page.screenshot({ path: set }).catch(() => {});
        if (fs.existsSync(imm) && fs.existsSync(set)) srPairs.push({ pos, immediate: imm, settled: set });
        i++;
      }
      if (cdp) { try { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); } catch { /* ignore */ } }
    }
    await page.close();
  } finally { await cleanup(); }
  return { frames, srPairs };
}

// motion-energy timeline: consecutive-frame grayscale diffs, total + per-band
// (4 horizontal bands) for a coarse spatial signature of WHERE motion happens.
const W = 160, H = 100, BANDS = 4;
async function gray(p) {
  const im = await Jimp.read(p); im.resize({ w: W, h: H });
  const d = im.bitmap.data; const g = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  return g;
}

// mean abs grayscale diff between two frames (0..1)
function frameDiff(a, b) {
  let tot = 0;
  for (let k = 0; k < a.length; k++) tot += Math.abs(a[k] - b[k]);
  return tot / a.length / 255;
}

const { frames, srPairs } = await capture();
const grays = [];
for (const p of frames) grays.push(await gray(p));
const energy = [], bandEnergy = [];
for (let i = 1; i < grays.length; i++) {
  const a = grays[i], b = grays[i - 1];
  let tot = 0; const bs = new Array(BANDS).fill(0); const bc = new Array(BANDS).fill(0);
  for (let y = 0; y < H; y++) { const band = Math.min(BANDS - 1, Math.floor(y / (H / BANDS))); for (let x = 0; x < W; x++) { const k = y * W + x; const diff = Math.abs(a[k] - b[k]); tot += diff; bs[band] += diff; bc[band]++; } }
  energy.push(tot / (W * H) / 255);
  bandEnergy.push(bs.map((v, bi) => v / (bc[bi] || 1) / 255));
}
const totalEnergy = +energy.reduce((s, x) => s + x, 0).toFixed(5);

// scroll-reveal timeline: per-position reveal energy (immediate vs settled at the
// same scroll offset). Captures scroll-triggered reveals the top-hold pass misses.
let scrollReveal;
if (srPairs.length) {
  const srEnergy = [];
  for (const pr of srPairs) { const a = await gray(pr.immediate), b = await gray(pr.settled); srEnergy.push(+frameDiff(a, b).toFixed(5)); }
  scrollReveal = { positions: srPairs.map((p) => p.pos), energy: srEnergy, total: +srEnergy.reduce((s, x) => s + x, 0).toFixed(5) };
}

const out = { url, frames: frames.length, intervalMs: INTERVAL, viewport: VIEWPORT, bands: BANDS, energy, bandEnergy, totalEnergy, scrollReveal };
fs.writeFileSync(path.join(outDir, "motion-frames.json"), JSON.stringify(out, null, 2));
console.log(`[capture-motion] ${frames.length} frames, entrance/ambient energy ${totalEnergy}${scrollReveal ? `, scroll-reveal energy ${scrollReveal.total} [${scrollReveal.energy.map((e) => e.toFixed(3)).join(" ")}]` : ""}`);
console.log(path.join(outDir, "motion-frames.json"));
