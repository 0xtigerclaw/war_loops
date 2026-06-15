#!/usr/bin/env node
// capture-motion - record a page's motion as an energy TIMELINE, the deterministic
// basis for a real motion-match ("does it move like the original, at the same
// moments, in the same places"), not a count.
//
// Primary capture is CDP SCREENCAST: the browser streams every rendered frame
// (high fps), so it catches fast entrance + scroll-reveal animations that
// fixed-interval screenshots miss (screenshots have ~150ms latency; reveals often
// finish faster). Two phases, neither with a scroll confound:
//   - entrance/ambient: held at the top, frames time-binned into a fixed timeline
//   - scroll-reveal: scroll to a position, HOLD, stream frames while the reveal
//     plays (same scroll offset, so motion = the animation, not the scroll)
// Falls back to interval screenshots if screencast is unavailable.
//
// Output: <out>/motion-frames.json { energy[], bandEnergy[][], totalEnergy,
//   scrollReveal { positions, energy[], total }, capture }
//
// Usage: node capture-motion.mjs --url <url|file://> --out <dir>
//        [--scroll-reveal] [--headless] [--cdp <url>] [--screenshots]
import { chromium } from "playwright-core";
import { Jimp } from "jimp";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const has = (f) => process.argv.includes(f);

const url = arg("--url");
const outDir = path.resolve(arg("--out", "./motion-capture"));
const SCROLL_REVEAL = has("--scroll-reveal");
const FORCE_SCREENSHOTS = has("--screenshots");
const ENTRANCE_MS = parseInt(arg("--entrance", "2200"), 10);
const SR_HOLD_MS = parseInt(arg("--sr-hold", "1300"), 10);
const SR_POSITIONS = [0.15, 0.35, 0.55, 0.78];
const NBINS = 10; // fixed entrance timeline bins (time-aligned across ref/build)
if (!url) { console.error("Usage: capture-motion.mjs --url <url> --out <dir> [--scroll-reveal] [--headless] [--cdp <url>]"); process.exit(64); }
fs.mkdirSync(outDir, { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };
const W = 160, H = 100, BANDS = 4;
const CHALLENGE_RE = /just a moment|checking your browser|verifying you are/i;

async function getContext() {
  if (has("--cdp")) { const b = await chromium.connectOverCDP(arg("--cdp")); return { context: b.contexts()[0] || (await b.newContext()), cleanup: async () => b.close().catch(() => {}) }; }
  if (has("--headless")) { const b = await chromium.launch({ headless: true }); return { context: await b.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 }), cleanup: async () => b.close() }; }
  const dir = path.join(os.homedir(), ".war-loops", "chrome-profile");
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: "chrome", headless: false, viewport: VIEWPORT, deviceScaleFactor: 1, args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"] });
  return { context: ctx, cleanup: async () => ctx.close() };
}

function grayFromBitmap(d) { const g = new Float32Array(W * H); for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; return g; }
async function grayFromB64(b64) { const im = await Jimp.read(Buffer.from(b64, "base64")); im.resize({ w: W, h: H }); return grayFromBitmap(im.bitmap.data); }
async function grayFromFile(p) { const im = await Jimp.read(p); im.resize({ w: W, h: H }); return grayFromBitmap(im.bitmap.data); }

// total + per-band mean-abs diff between two gray frames
function diffBands(a, b) {
  let tot = 0; const bs = new Array(BANDS).fill(0); const bc = new Array(BANDS).fill(0);
  for (let y = 0; y < H; y++) { const band = Math.min(BANDS - 1, Math.floor(y / (H / BANDS))); for (let x = 0; x < W; x++) { const k = y * W + x; const df = Math.abs(a[k] - b[k]); tot += df; bs[band] += df; bc[band]++; } }
  return { total: tot / (W * H) / 255, bands: bs.map((v, i) => v / (bc[i] || 1) / 255) };
}

// ---- screencast capture (primary) ----
async function captureScreencast() {
  const { context, cleanup } = await getContext();
  const out = { entrance: [], srWindows: [], ok: false };
  try {
    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT).catch(() => {});
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    for (let w = 0; w < 8; w++) { const t = await page.title().catch(() => ""); if (!CHALLENGE_RE.test(t || "")) break; await page.waitForTimeout(1000); }
    let client;
    try { client = await context.newCDPSession(page); } catch { await page.close(); return out; }
    const collect = async (ms) => {
      const frames = [];
      const h = (p) => { frames.push({ data: p.data, t: p.metadata?.timestamp || 0 }); client.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {}); };
      client.on("Page.screencastFrame", h);
      try { await client.send("Page.startScreencast", { format: "jpeg", quality: 55, everyNthFrame: 1 }); } catch { client.off("Page.screencastFrame", h); return frames; }
      await page.waitForTimeout(ms);
      await client.send("Page.stopScreencast").catch(() => {});
      client.off("Page.screencastFrame", h);
      return frames;
    };
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    out.entrance = await collect(ENTRANCE_MS);
    if (SCROLL_REVEAL) {
      const max = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - window.innerHeight)).catch(() => 0);
      for (const pos of SR_POSITIONS) {
        await page.evaluate((y) => window.scrollTo(0, y), Math.round(pos * max)).catch(() => {});
        out.srWindows.push({ pos, frames: await collect(SR_HOLD_MS) });
      }
    }
    out.ok = out.entrance.length >= 2;
    await page.close();
  } finally { await cleanup(); }
  return out;
}

// ---- screenshot capture (fallback) ----
async function captureScreenshots() {
  const { context, cleanup } = await getContext();
  const frames = [];
  try {
    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT).catch(() => {});
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    for (let w = 0; w < 8; w++) { const t = await page.title().catch(() => ""); if (!CHALLENGE_RE.test(t || "")) break; await page.waitForTimeout(1000); }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    for (let i = 0; i < 12; i++) {
      const p = path.join(outDir, `t${String(i).padStart(3, "0")}.png`);
      await page.screenshot({ path: p }).catch(() => {});
      if (fs.existsSync(p)) frames.push(p);
      if (i < 11) await page.waitForTimeout(200);
    }
    await page.close();
  } finally { await cleanup(); }
  return frames;
}

// ---- process entrance frames into a fixed, time-binned timeline ----
async function processEntrance(frames) {
  const grays = []; for (const f of frames) grays.push(await grayFromB64(f.data));
  const t0 = frames[0]?.t || 0; const binDur = (ENTRANCE_MS / 1000) / NBINS;
  const energy = new Array(NBINS).fill(0);
  const bandEnergy = Array.from({ length: NBINS }, () => new Array(BANDS).fill(0));
  for (let i = 1; i < grays.length; i++) {
    const d = diffBands(grays[i], grays[i - 1]);
    const bin = Math.min(NBINS - 1, Math.max(0, Math.floor(((frames[i].t || 0) - t0) / binDur)));
    energy[bin] += d.total;
    for (let b = 0; b < BANDS; b++) bandEnergy[bin][b] += d.bands[b];
  }
  return { energy: energy.map((x) => +x.toFixed(5)), bandEnergy: bandEnergy.map((r) => r.map((x) => +x.toFixed(5))), total: +energy.reduce((s, x) => s + x, 0).toFixed(5) };
}
async function revealEnergy(frames) {
  const grays = []; for (const f of frames) grays.push(await grayFromB64(f.data));
  let tot = 0; for (let i = 1; i < grays.length; i++) tot += diffBands(grays[i], grays[i - 1]).total;
  return +tot.toFixed(5);
}

// ---- run ----
let result;
const sc = FORCE_SCREENSHOTS ? { ok: false } : await captureScreencast();
if (sc.ok) {
  const ent = await processEntrance(sc.entrance);
  let scrollReveal;
  if (sc.srWindows.length) {
    const energy = []; for (const w of sc.srWindows) energy.push(await revealEnergy(w.frames));
    scrollReveal = { positions: sc.srWindows.map((w) => w.pos), energy, total: +energy.reduce((s, x) => s + x, 0).toFixed(5) };
  }
  result = { url, viewport: VIEWPORT, bands: BANDS, capture: "screencast", framesEntrance: sc.entrance.length, energy: ent.energy, bandEnergy: ent.bandEnergy, totalEnergy: ent.total, scrollReveal };
  console.log(`[capture-motion] screencast: ${sc.entrance.length} entrance frames, energy ${ent.total}${scrollReveal ? `, scroll-reveal ${scrollReveal.total} [${scrollReveal.energy.map((e) => e.toFixed(3)).join(" ")}]` : ""}`);
} else {
  // fallback: interval screenshots (entrance/ambient only)
  const frames = await captureScreenshots();
  const grays = []; for (const p of frames) grays.push(await grayFromFile(p));
  const energy = [], bandEnergy = [];
  for (let i = 1; i < grays.length; i++) { const d = diffBands(grays[i], grays[i - 1]); energy.push(+d.total.toFixed(5)); bandEnergy.push(d.bands.map((x) => +x.toFixed(5))); }
  result = { url, viewport: VIEWPORT, bands: BANDS, capture: "screenshots", framesEntrance: frames.length, energy, bandEnergy, totalEnergy: +energy.reduce((s, x) => s + x, 0).toFixed(5) };
  console.log(`[capture-motion] screenshots (fallback): ${frames.length} frames, energy ${result.totalEnergy}`);
}

fs.writeFileSync(path.join(outDir, "motion-frames.json"), JSON.stringify(result, null, 2));
console.log(path.join(outDir, "motion-frames.json"));
