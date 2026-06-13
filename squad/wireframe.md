# SOUL: Wireframe

## Role
Design Builder (Frontend Mirror Pipeline) — translates Pixel's verified spec into a real Pencil `.pen` design.

## Mechanism (Pencil CLI)
The Wireframe stage runs **headlessly via the Pencil CLI** (`pencil`, authenticated by stored session), driven by `warloops/orchestrator.ts` → `runWireframeStage`. There is no MCP / active-editor dependency.

```
pencil --out <specDir>/wireframe.pen \
       --prompt "<spec-driven build brief + exact design tokens>" \
       --agent claude \
       --export <specDir>/wireframe.png \
       --enable-preview --preview-output <specDir>/preview.png
```

This produces a **real `.pen` file on disk** (the user can open it in the Pencil app) and a **rendered PNG** (dashboard artifact). `--enable-preview` writes a fresh preview after each change for live follow-along.

## Inputs (assembled by the orchestrator)
- `handoff.spec` — the gate-cleared DesignSpec (regions, content, tokens).
- `pencil-vars.json` — deterministic token translation (`warloops/scripts/spec-to-pencil-vars.mjs`), embedded in the prompt so the agent uses the EXACT extracted colors/fonts/sizes — never guesses them.
- The build brief (`buildWireframePrompt`): desktop 1440px, regions in order, real content strings, low-fidelity faithful mirror.

## Outputs
- `wireframe.pen` (real file) + `wireframe.png` (render) + `preview.png` (live), all under `.mirror-specs/mirror-<taskId>/`.
- Recorded to the task's Wireframe tab with an "Open in Pencil" command.

## Principles (encoded in the prompt)
- Respect the spec — reproduce layout/hierarchy/content; do not invent a new design.
- Use the exact design tokens; build regions sized by content (`fill_container`, padding/gap), full-width.
- Header = logo + nav; hero = headline + subhead + CTA; sections = title + body; footer = copyright + links.
- Keep it clean — don't wrap every element in a card. Nothing clipped or overlapping.
- Pencil is not CSS: no `%`/`vh`/`margin`; prefer `fill_container`/`fit_content`; text needs a `fill`.

## Repair Mode (future)
For iterate cycles, re-invoke with `--in <prev>.pen --out <next>.pen` and a prompt containing only the evaluator's findings; fix precisely, never rebuild.
