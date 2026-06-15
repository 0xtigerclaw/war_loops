#!/usr/bin/env node
// Forge - deterministic spec -> moving HTML. The code-output stage Pencil cannot
// be: it reproduces the static design AND the captured motion, so the clone
// actually moves. No LLM, no tokens: a pure compile from the verified spec.
//
// Motion reproduction (drives the experiential axis up from 0):
//   - every captured @keyframes is emitted verbatim (the motion vocabulary)
//   - scroll-reveal: sections fade/rise in on viewport entry (IntersectionObserver)
//   - ambient: if the reference had looping motion, a hero accent loops
//   - transitions: interactive elements carry hover/state transitions
//
// Usage: node warloops/scripts/forge.mjs <spec.json> [--out <dir>]
// Output: <dir>/index.html  (self-contained)
import fs from "node:fs";
import path from "node:path";

function arg(flag, def) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : def; }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const specPath = process.argv[2];
if (!specPath || specPath.startsWith("--")) { console.error("Usage: forge.mjs <spec.json> [--out <dir>]"); process.exit(64); }
const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
const outDir = path.resolve(arg("--out", path.join(path.dirname(specPath), "forge")));
fs.mkdirSync(outDir, { recursive: true });

const t = spec.tokens || {};
const colors = t.colors || {};
const bg = colors.background || "#ffffff";
const text = colors.text || "#111111";
const accent = colors.accent || colors.primary || "#2563eb";
const headFont = t.typography?.h1?.family || t.typography?.h2?.family || "system-ui";
const bodyFont = t.typography?.body?.family || "system-ui";

const texts = (spec.content?.required_text || []).map((s) => String(s).trim()).filter(Boolean);
const regions = spec.layout?.regions || [];
const motion = spec.motion || {};
const m = motion.summary || {};

// --- distribute content across sections (hero + one per region) ---
const navLinks = texts.filter((s) => s.length <= 18).slice(0, 5);
const hero = { title: texts[0] || spec.name || "Untitled", sub: texts.find((s) => s.length > 24) || "" };
const used = new Set([hero.title, hero.sub]);
const pool = texts.filter((s) => !used.has(s));
const bodyRegions = regions.filter((r) => !/header|nav|footer/i.test(r.name || r.role || "")).slice(0, 6);
const sections = bodyRegions.map((r, i) => {
  const heading = pool[i * 2] || r.name || `Section ${i + 1}`;
  const body = pool[i * 2 + 1] || "";
  return { heading, body };
});

// --- motion CSS ---
const keyframeCss = (motion.keyframes || []).map((k) => k.css).filter(Boolean).join("\n");
const hasReveal = !!m.has_scroll_reveal;
const hasAmbient = !!m.has_infinite;
// pick a real looping animation if one was captured, else a built-in float
const ambient = (motion.animated || []).find((a) => a.iteration === "infinite");
const ambientName = ambient?.name && (motion.keyframes || []).some((k) => k.name === ambient.name) ? ambient.name : "wl-float";
const ambientRule = hasAmbient
  ? `.wl-ambient{animation:${ambientName} ${ambient?.duration || "6s"} ${ambient?.timing || "ease-in-out"} infinite;}`
  : "";

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(hero.title)}</title>
<style>
:root{--bg:${bg};--text:${text};--accent:${accent};--head:${esc(headFont)},system-ui,sans-serif;--body:${esc(bodyFont)},system-ui,sans-serif;}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--body);line-height:1.5;}
.wl-wrap{max-width:1200px;margin:0 auto;padding:0 ${esc(t.spacing?.padding || "24px")};}
.wl-nav{display:flex;align-items:center;justify-content:space-between;padding:18px 0;position:sticky;top:0;background:var(--bg);border-bottom:1px solid rgba(127,127,127,.15);transition:box-shadow .2s ease,background-color .2s ease;z-index:10;}
.wl-nav.scrolled{box-shadow:0 2px 16px rgba(0,0,0,.08);}
.wl-logo{font-family:var(--head);font-weight:800;font-size:20px;}
.wl-nav a{color:var(--text);text-decoration:none;margin-left:22px;opacity:.8;transition:opacity .15s ease,color .15s ease;}
.wl-nav a:hover{opacity:1;color:var(--accent);}
.wl-hero{padding:96px 0 72px;}
.wl-hero h1{font-family:var(--head);font-size:clamp(34px,6vw,64px);line-height:1.05;margin:0 0 18px;}
.wl-hero p{font-size:20px;opacity:.75;max-width:60ch;margin:0 0 28px;}
.wl-cta{display:inline-block;background:var(--accent);color:#fff;padding:13px 26px;border-radius:9px;font-weight:600;text-decoration:none;transition:transform .2s ease,filter .2s ease,box-shadow .2s ease;}
.wl-cta:hover{transform:translateY(-2px);filter:brightness(1.05);box-shadow:0 10px 24px rgba(0,0,0,.15);}
.wl-section{padding:64px 0;border-top:1px solid rgba(127,127,127,.1);}
.wl-section h2{font-family:var(--head);font-size:clamp(24px,3.5vw,36px);margin:0 0 14px;}
.wl-section p{font-size:17px;opacity:.72;max-width:65ch;}
.wl-dot{display:inline-block;width:54px;height:54px;border-radius:50%;background:var(--accent);opacity:.9;margin-bottom:22px;}
.wl-foot{padding:48px 0;border-top:1px solid rgba(127,127,127,.15);opacity:.7;font-size:14px;}
${hasReveal ? `.reveal{opacity:0;transform:translateY(26px);transition:opacity .6s ease,transform .6s ease;}\n.reveal.in{opacity:1;transform:none;}` : ""}
@keyframes wl-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
${ambientRule}
/* --- captured @keyframes (reproduced verbatim) --- */
${keyframeCss}
</style></head>
<body>
<header class="wl-nav"><div class="wl-wrap" style="display:flex;align-items:center;justify-content:space-between;width:100%">
<span class="wl-logo">${esc((spec.name || hero.title).split(/[\s|-]/)[0])}</span>
<nav>${navLinks.map((l) => `<a href="#">${esc(l)}</a>`).join("")}</nav>
</div></header>
<main class="wl-wrap">
<section class="wl-hero ${hasReveal ? "reveal" : ""}">
${hasAmbient ? `<div class="wl-dot wl-ambient"></div>` : `<div class="wl-dot"></div>`}
<h1>${esc(hero.title)}</h1>
${hero.sub ? `<p>${esc(hero.sub)}</p>` : ""}
<a class="wl-cta" href="#">${esc(navLinks[0] || "Get started")}</a>
</section>
${sections.map((s) => `<section class="wl-section ${hasReveal ? "reveal" : ""}">
<h2>${esc(s.heading)}</h2>
${s.body ? `<p>${esc(s.body)}</p>` : ""}
</section>`).join("\n")}
</main>
<footer class="wl-foot"><div class="wl-wrap">${esc((spec.name || hero.title))} - reproduced by Forge</div></footer>
<script>
(function(){
  var nav=document.querySelector('.wl-nav');
  if(nav)addEventListener('scroll',function(){nav.classList.toggle('scrolled',scrollY>8);},{passive:true});
  ${hasReveal ? `var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)e.target.classList.add('in');});},{threshold:.12});document.querySelectorAll('.reveal').forEach(function(el){io.observe(el);});` : ""}
})();
</script>
</body></html>`;

const outFile = path.join(outDir, "index.html");
fs.writeFileSync(outFile, html);
console.log(`[forge] wrote ${outFile}`);
console.log(`[forge] reproduced: ${(motion.keyframes || []).length} keyframes, scroll-reveal ${hasReveal ? "on" : "off"}, ambient ${hasAmbient ? "on" : "off"}, ${sections.length + 1} sections`);
console.log(outFile);
