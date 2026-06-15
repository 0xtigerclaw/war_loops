---
name: frontend-spec-extractor
description: "Extract a ground-truth design spec (colors, typography, spacing, layout regions, content, interactions) from a live URL or a source image, then evaluate the spec against pass/iterate/fail quality gates. Use for the Pixel agent / frontend-mirror pipeline, or any time you need a measured, machine-checkable DesignSpec before building or wireframing a UI."
---

# Frontend Spec Extractor

## Overview

Produces the **DesignSpec** that the frontend-mirror pipeline (Pixel → Wireframe → Forge) builds from. It replaces guesswork with measurement:

- **URL sources** → headless Chromium reads *real* `getComputedStyle` values, DOM text, and layout geometry at 3 viewports (1440 / 1024 / 390) and captures full-page screenshots. No hallucinated tokens.
- **Image sources** → emits a spec template + a copy of the image for the model to fill via vision (estimated values prefixed with `~`).

A separate **evaluator** then scores the spec against deterministic quality gates and returns `pass` / `iterate` / `fail` with actionable findings - so a thin or placeholder-laden spec never reaches the build stage.

The schema in `warloops/scripts/spec.schema.json` is the single source of truth, shared with `warloops/orchestrator.ts` (the `DesignSpec` interface) and `squad/pixel.md`.

## When to Use This Skill

- A frontend-mirror task starts and Pixel needs to analyze a source.
- You need to verify the specs Pixel produced are correct/complete.
- You want a measured token set (colors/type/spacing) from any reference site before building a UI.

## Commands

Run from the `mission-control/` directory (the backing scripts use its `playwright-core` + installed Chromium).

```bash
# Extract from a live URL (deterministic)
node warloops/scripts/extract-spec.mjs --url <url> [--out <dir>] [--name <label>]
npm run spec:extract -- --url <url>

# Extract from an image (emits a template to fill via vision)
node warloops/scripts/extract-spec.mjs --image <path> [--out <dir>]

# Evaluate a spec - human summary or --json
node warloops/scripts/evaluate-spec.mjs <out>/spec.json
npm run spec:evaluate -- <out>/spec.json --json
```

Default output dir: `.mirror-specs/<slug>/` containing `spec.json` and `screenshots/{desktop,tablet,mobile}.png`.

Evaluator exit codes: **0 = pass, 2 = iterate, 1 = fail** (branch on these in the orchestrator).

## Workflow

1. **Extract.** Run `extract-spec.mjs` against the URL or image.
2. **Evaluate.** Run `evaluate-spec.mjs` on the resulting `spec.json`.
   - `pass` → hand the spec to the wireframe/build stage.
   - `iterate` → read the findings; for URLs re-run extraction, for images fill the flagged fields, then re-evaluate.
   - `fail` → a critical gate failed (invalid schema, no real colors, or placeholder values). Fix before proceeding.
3. **Image mode.** Open the image, fill every field in the template spec from what you observe, prefix estimates with `~`, then evaluate.

## Quality Gates (evaluator)

| Gate | Critical | Checks |
|------|----------|--------|
| `schema_valid` | ✓ | Matches `spec.schema.json` (types + required fields) |
| `viewports_complete` | | Screenshots for desktop/tablet/mobile |
| `tokens_populated` | ✓ | ≥3 real hex colors, ≥3 type styles with sizes, spacing present |
| `layout_defined` | | ≥3 named regions + hierarchy |
| `content_captured` | | ≥3 required_text entries |
| `no_placeholders` | ✓ | No leftover `#...`, `...`, `headline`, `nav items`, etc. |

A failed critical gate forces `fail`; otherwise score ≥85 with all gates passing = `pass`, else `iterate`.

## Known Limitations

- **Bot-walled sites** (Cloudflare "Just a moment…", login gates) return a challenge page to headless Chromium → the spec will show default colors and ~0 regions. The extractor reports this faithfully; use **image mode** (manually screenshot the real page) for these.
- **CSS-gradient accents** aren't captured as solid `background-color`, so the accent token may fall back to a nearby solid color.
- **Header/footer classification** on heavily nested div-soup layouts may label some regions generically as `section_N` (heights are still accurate).
