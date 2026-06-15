# Calibration run: spread via mismatched anchors

The first calibration with real **spread** in the labels. Three matched builds (a build scored against
its own reference, rated by a human: tailwind 75, vercel 77, linear 79) plus three **mismatched
anchors** (a build scored against a *wrong* reference, auto-labelled ~6 because it is plainly the wrong
page). `scripts/calibrate.mjs` then fit the signal weights against those ratings.

## Result

| | fit (Pearson r) |
|---|---|
| prior weights | 0.980 |
| fitted (train) | 0.995 |
| fitted (**leave-one-out**) | **0.987** |

With spread, the fit is strong and generalizes. The fitted weights separate the anchors far better
than the priors (priors scored the wrong-page builds 47-53; the fit scores them 20-26).

| signal | prior | fitted | reads the reference image? |
|--------|-------|--------|----------------------------|
| vision | 0.27 | **0.53** | yes |
| gist | 0.13 | 0.20 | yes |
| perceptual | 0.03 | 0.11 | yes |
| content | 0.18 | 0.09 | no (build vs its own spec) |
| tokens | 0.20 | 0.04 | no |
| layout | 0.13 | 0.03 | yes |
| structure | 0.06 | 0.00 | no |

## The finding (why we did NOT promote these weights)

The anchors exposed a structural fact about the panel: **four of the seven static signals
(`tokens`, `structure`, `content`, and partly `layout`) never look at the reference screenshot.** They
compare the build to the *spec* Pixel extracted earlier, so they answer "did the build match its own
spec," not "does it match the reference." For a correct build that is fine, but for a wrong-page build
they stay high, so they cannot discriminate right page from wrong.

Calibrating on mismatch anchors therefore rewards exactly the reference-grounded signals
(vision/gist/perceptual) and zeroes the spec-consistency signals. That is correct for catching gross
mismatch, but it over-rotates the panel onto `vision` (0.53) - the one LLM judge - which **undercuts
the project's grounding thesis** (most of the score should be deterministic). So these weights are a
diagnostic, not a promotion.

## What real calibration still needs

Mismatch anchors calibrate the *coarse* axis (right page vs wrong page). The *fine* axis (a faithful
build vs a mediocre one) needs **varied-quality real builds** with human ratings spread across the
range, not just two clusters at ~6 and ~77. That is a data-collection effort (more targets, or
deliberately degraded real builds), and it is the honest prerequisite before any weight promotion.

Dataset: `calib-report.json` (per-signal scores) + `calib-ratings.json` (labels). Re-run:

```bash
node scripts/calibrate.mjs --report calibration/calib-report.json --ratings calibration/calib-ratings.json
```
