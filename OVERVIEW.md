# War Loops - Engineering Overview

Working notes for the autonomous frontend-mirror pipeline: what it does, what has
been built, where the important files are, and how to swap the models it runs on.

> Public README is `README.md`. This file is the builder's map.

## What it is

Point it at a URL or image. Pixel captures the page with a genuine browser and
extracts a ground-truth `DesignSpec`. Wireframe rebuilds it in Pencil and a
weighted panel of signals scores fidelity against the original; a surgical critic
drives a repair loop until it passes or stops improving. Forge (code output) is a
stub. The thesis: a loop is only as good as its measure, so the judge is the point.

Pipeline: **Pixel** (capture + spec gate) -> **Wireframe** (Pencil build + signal
panel + repair loop) -> **Forge** (stub).

## What has been built (recent work)

- **Genuine-browser capture.** Pixel drives real Chrome (channel:"chrome", headed,
  persistent profile) and can attach over CDP, to beat Cloudflare/bot walls. A
  capture that lands on a challenge page is flagged `blocked` and hard-halts.
- **Multi-signal fidelity panel.** Seven signals, six deterministic (non-LLM) so
  the score does not drift. Pluggable: a signal is a file in `signals/` plus a line
  in `signals.config.json`.
- **`layout` signal (new).** Deterministic geometry grounding: segments the
  original and the build into horizontal bands the same way (row-wise color
  derivative) and scores band-count + position alignment. Closes the "right
  content, wrong vertical positions" blind spot that SSIM and `structure` miss.
- **Surgical critic.** Repairs target the 1-3 weakest signals and top findings,
  "fix only these, do not rebuild," so iterations move forward.
- **Run metrics.** Every run writes `metrics.json` (time, tokens, real cost). Both
  token-consuming tools self-report: Pencil via `--usage`, the judge via
  `claude --output-format json`.
- **Benchmark + leaderboard.** `scripts/benchmark.ts` runs the panel over the
  corpus and writes `benchmark/report.json` + `leaderboard.md` (the MetaLoop).
- **Supervised calibration (new).** `scripts/calibrate.mjs` fits signal weights to
  human ratings (simplex-constrained, ridge-regularized, leave-one-out validated),
  writes `signals.config.suggested.json` for review. Warns when the corpus is too
  small to trust.
- **Model routing (new).** Every model the pipeline runs is selectable from one
  config. See "Swapping models" below.

## Important files

| File | What it is |
|------|-----------|
| `orchestrator.ts` | Pipeline controller. `runFrontendMirrorPipeline`, `runPixelStage`, `runWireframeStage` (build + repair loop), metrics. |
| `models.config.json` | **Model routing control surface.** One place to set which model each role runs. |
| `scripts/model-router.mjs` | Turns `models.config.json` (+ env overrides) into CLI flags. The only code that knows the flag shapes. |
| `signals.config.json` | Signal toggles + weights (priors) + pass thresholds. |
| `signals/` | The fidelity signals: `layout`, `perceptual`, `gist`, `tokens`, `structure`, `content`, `vision`. |
| `signals/vision.mjs` | The LLM judge (spawns `claude`). Reads the `judge` route. |
| `scripts/extract-spec.mjs` | Pixel: genuine-browser capture -> `spec.json`. |
| `scripts/evaluate-spec.mjs` | Spec quality gate. |
| `scripts/evaluate.mjs` | The weighted signal aggregator (panel runner). |
| `scripts/critic.mjs` | Surgical repair planner. |
| `scripts/calibrate.mjs` | Fit signal weights to human ratings. |
| `scripts/benchmark.ts` | Run the corpus -> `benchmark/report.json` + `leaderboard.md`. |
| `calibration/ratings.json` | Human fidelity ratings (0..100 per target) that calibrate the weights. |
| `targets.json` | Benchmark corpus. |
| `.mirror-specs/<id>/` | Per-run artifacts: `spec.json`, `built.json`, `screenshots/desktop.png` (reference), `wireframe.png` (render), `usage/`, `metrics.json`. |

## Swapping models

All model selection flows through `models.config.json`. Three roles:

| Role | What runs it | What it does | Cost |
|------|-------------|--------------|------|
| `build` | Pencil CLI agent | designs + repairs the `.pen`. The dominant cost. | high (about $1.5-$2/build) |
| `readback` | Pencil CLI agent | cheap structured read-back of the built doc (no design). | low |
| `judge` | `claude` CLI | the vision fidelity signal. | about $0.27/eval |

Pencil infers the provider from the model id, so `build`/`readback` can run on
Claude, OpenAI, or Gemini. The defaults (`"model": "default"`) reproduce the
verified baseline (Pencil `--agent claude`, claude CLI default), so an untouched
config changes nothing.

**Three ways to swap, fastest first:**

1. **Env var (one-off, no file edit).** Per-role override `WARLOOPS_<ROLE>_MODEL`:
   ```bash
   WARLOOPS_BUILD_MODEL=claude-sonnet-4-6 npx tsx warloops/scripts/benchmark.ts --only=vercel
   WARLOOPS_JUDGE_MODEL=claude-haiku-4-5 node warloops/scripts/evaluate.mjs ...
   ```
2. **Edit `models.config.json` (persistent).** Set the role's `model` to a Pencil
   model id (and optional `"effort": "low|medium|high"` for `build`):
   ```json
   "build": { "engine": "pencil", "model": "gpt-5.5", "effort": "high" }
   ```
3. **Point at a different config file.** `WARLOOPS_MODELS_CONFIG=/path/to/alt.json`.

**Find valid model ids:**
```bash
pencil --list-models --agent claude     # also: --agent codex, --agent gemini
```

**Where the flags actually get applied** (if you need to extend routing):
- `build` + `readback`: `orchestrator.ts` calls `pencilModelArgs(role)` from the
  router and splices the flags into the Pencil invocation.
- `judge`: `signals/vision.mjs` calls `claudeModelArgs("judge")` into the `claude`
  spawn.
- To add a new role: add it to `models.config.json` and call `pencilModelArgs` /
  `claudeModelArgs` at the new call site. No other changes.

**Provider API keys** (Pencil reads these from the environment):
`ANTHROPIC_API_KEY` for Claude agents, `PENCIL_AGENT_API_KEY` to override per agent,
`PENCIL_CLI_KEY` for CI. The `claude` judge uses the authenticated `claude` CLI.

**Cost note.** The `build` role is the whole bill; routing it to a cheaper model
(e.g. `claude-sonnet-4-6`) is the single biggest cost lever. The deterministic
signals are free; only `judge` and the Pencil agents consume tokens. After any
model swap, re-run the benchmark to measure the fidelity/cost tradeoff.

## Common commands

```bash
# full pipeline benchmark (from the mission-control root)
npx tsx warloops/scripts/benchmark.ts --only=tailwind,vercel,linear

# standalone fidelity of one build vs its reference
node warloops/scripts/evaluate.mjs --reference <ref.png> --render <render.png> --spec <spec.json> --built <built.json>

# calibrate weights against human ratings
node warloops/scripts/calibrate.mjs --report warloops/benchmark/report.json --ratings warloops/calibration/ratings.json

# list Pencil model ids
pencil --list-models --agent claude
```
