#!/usr/bin/env node
// War Loops - supervised weight calibration.
//
// Turns "I eyeballed the weights" into "the overall provably tracks human
// judgment." Reads per-signal scores from a benchmark report and human fidelity
// ratings, then fits non-negative signal weights on the probability simplex
// (sum = 1) that best predict the human rating, ridge-regularized toward the
// current config weights so it degrades gracefully on thin data.
//
// It NEVER overwrites the live config: it writes signals.config.suggested.json
// and prints the fit quality (in-sample + leave-one-out Pearson r) so a human
// can approve the change. It warns loudly when the labeled corpus is too small
// to fit reliably (rule of thumb: want >= 2x as many rated targets as signals).
//
// Usage:
//   node scripts/calibrate.mjs \
//     --report benchmark/report.json \
//     --ratings calibration/ratings.json \
//     --config signals.config.json \
//     [--lambda 0.15] [--out signals.config.suggested.json]
import fs from "node:fs";

function arg(flag, def) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : def; }

const reportPath = arg("--report", "benchmark/report.json");
const ratingsPath = arg("--ratings", "calibration/ratings.json");
const configPath = arg("--config", "signals.config.json");
const outPath = arg("--out", "signals.config.suggested.json");
const lambda = parseFloat(arg("--lambda", "0.15")); // pull toward priors; higher = more conservative

for (const [label, p] of [["report", reportPath], ["ratings", ratingsPath], ["config", configPath]]) {
  if (!fs.existsSync(p)) { console.error(`[calibrate] ${label} not found: ${p}`); process.exit(1); }
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
const ratings = JSON.parse(fs.readFileSync(ratingsPath, "utf-8")); // { "<target>": <0..100>, ... } or { ratings: {...} }
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const ratingMap = ratings.ratings || ratings;

const signals = (config.signals || []).filter((s) => s.enabled !== false).map((s) => s.name);
const priorRaw = signals.map((n) => config.signals.find((s) => s.name === n)?.weight ?? 1);
const priorSum = priorRaw.reduce((a, b) => a + b, 0) || 1;
const prior = priorRaw.map((w) => w / priorSum);

// Build the feature matrix X (targets x signals) and label vector y, from rated targets only.
const rows = report.rows || report.results || (Array.isArray(report) ? report : []);
const X = [], y = [], names = [];
for (const r of rows) {
  const name = r.name || r.target;
  if (!(name in ratingMap)) continue;
  const gates = r.gates || r.signals || {};
  const feat = signals.map((s) => {
    const g = gates[s];
    const v = typeof g === "number" ? g : (g?.score ?? null);
    return v == null ? null : v / 100; // 0..1, null = abstained
  });
  // mean-impute abstentions so a missing signal does not bias the fit
  const present = feat.filter((v) => v != null);
  const mean = present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0.5;
  X.push(feat.map((v) => (v == null ? mean : v)));
  y.push(ratingMap[name] / 100);
  names.push(name);
}

const n = X.length, k = signals.length;
if (n < 2) { console.error(`[calibrate] need >= 2 rated targets, have ${n}. Add ratings to ${ratingsPath}.`); process.exit(1); }

// --- fit: minimize  ||Xw - y||^2 + lambda*||w - prior||^2,  s.t. w >= 0, sum w = 1 ---
// projected gradient descent with Euclidean projection onto the simplex.
function projectSimplex(v) {
  const u = [...v].sort((a, b) => b - a);
  let css = 0, rho = -1;
  for (let i = 0; i < u.length; i++) { css += u[i]; if (u[i] - (css - 1) / (i + 1) > 0) rho = i; else break; }
  let cssRho = 0; for (let i = 0; i <= rho; i++) cssRho += u[i];
  const theta = (cssRho - 1) / (rho + 1);
  return v.map((x) => Math.max(0, x - theta));
}
function predict(w, x) { let s = 0; for (let j = 0; j < k; j++) s += w[j] * x[j]; return s; }
function pearson(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const da = a[i] - ma, db = b[i] - mb; dot += da * db; na += da * da; nb += db * db; }
  return dot / (Math.sqrt(na * nb) || 1);
}
function fit(Xtr, ytr, prior, lambda) {
  let w = [...prior];
  const lr = 0.5;
  for (let it = 0; it < 4000; it++) {
    const grad = new Array(k).fill(0);
    for (let i = 0; i < Xtr.length; i++) {
      const err = predict(w, Xtr[i]) - ytr[i];
      for (let j = 0; j < k; j++) grad[j] += 2 * err * Xtr[i][j];
    }
    for (let j = 0; j < k; j++) grad[j] = grad[j] / Xtr.length + 2 * lambda * (w[j] - prior[j]);
    w = projectSimplex(w.map((wj, j) => wj - lr * grad[j]));
  }
  return w;
}

const w = fit(X, y, prior, lambda);
const predTrain = X.map((x) => predict(w, x));
const predPrior = X.map((x) => predict(prior, x));
const rTrain = pearson(predTrain, y);
const rPrior = pearson(predPrior, y);

// leave-one-out generalization
let looPred = [];
if (n >= 3) {
  looPred = X.map((_, i) => {
    const Xtr = X.filter((_, j) => j !== i), ytr = y.filter((_, j) => j !== i);
    const wi = fit(Xtr, ytr, prior, lambda);
    return predict(wi, X[i]);
  });
}
const rLoo = looPred.length ? pearson(looPred, y) : null;

// --- report ---
const pct = (x) => (x * 100).toFixed(0);
console.log(`\nWar Loops - weight calibration`);
console.log(`  rated targets: ${n}  ·  signals: ${k}  ·  ridge lambda: ${lambda}`);
if (n < 2 * k) console.log(`  ⚠  UNDERDETERMINED: ${n} targets for ${k} signals. Want >= ${2 * k}. Treat weights as a nudge, not truth; collect more ratings.`);
console.log(`\n  signal       prior   fitted   delta`);
signals.forEach((s, j) => {
  const d = w[j] - prior[j];
  console.log(`  ${s.padEnd(11)}  ${prior[j].toFixed(2)}    ${w[j].toFixed(2)}    ${d >= 0 ? "+" : ""}${d.toFixed(2)}`);
});
console.log(`\n  fit (Pearson r, overall vs human):`);
console.log(`    prior weights : ${rPrior.toFixed(3)}`);
console.log(`    fitted (train): ${rTrain.toFixed(3)}`);
console.log(`    fitted (LOO)  : ${rLoo == null ? "n/a (need >= 3 targets)" : rLoo.toFixed(3)}`);
console.log(`\n  per-target (human  vs  prior  fitted):`);
names.forEach((nm, i) => console.log(`    ${nm.padEnd(14)} ${pct(y[i]).padStart(3)}   ${pct(predPrior[i]).padStart(3)}   ${pct(predTrain[i]).padStart(3)}`));

const suggested = JSON.parse(JSON.stringify(config));
suggested._comment = `CALIBRATED SUGGESTION (n=${n}, train r=${rTrain.toFixed(3)}, LOO r=${rLoo == null ? "n/a" : rLoo.toFixed(3)}). Review before promoting to signals.config.json.`;
signals.forEach((s, j) => { const e = suggested.signals.find((x) => x.name === s); if (e) e.weight = Math.round(w[j] * 100) / 100; });
fs.writeFileSync(outPath, JSON.stringify(suggested, null, 2));
console.log(`\n  wrote ${outPath}  (review, then copy weights into signals.config.json to promote)\n`);
