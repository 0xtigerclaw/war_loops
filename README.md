# war_loops — Frontend Mirror Pipeline

Turn a **URL or image** of any web page into a faithful, evaluated **Pencil design** —
autonomously, with quality gates and self-correcting loops at every stage.
*"War loops" = the build → evaluate → repair loops that drive each stage toward a 1:1 mirror.*

```
URL / image ──► Pixel ──► (spec gate) ──► Wireframe ──► (fidelity loop) ──► .pen + render
              extract       pass/iterate     build in        vision judge
              real tokens    /fail            Pencil CLI      → repair → repeat
```

> This repo is a **snapshot** extracted from the `clawd/mission-control` workspace, where the
> pipeline runs integrated with Convex, the agent gateway, and a Next.js dashboard. As a
> standalone repo it documents the architecture and ships the self-contained logic. The
> `scripts/` are fully runnable on their own; `orchestrator.ts` is included as reference
> (it still imports mission-control's Convex/agent layer).

## Architecture

```mermaid
flowchart TB
    SRC(["URL / Image"]):::io
    ORCH{{"Orchestrator<br/>runFrontendMirrorPipeline()"}}:::orch

    subgraph S1["① Pixel · Source Analyzer"]
      direction TB
      EX["extract-spec.mjs<br/>Playwright — computed styles, DOM,<br/>geometry, screenshots @ 1440/1024/390"]
      SE{"Spec Evaluator · evaluate-spec.mjs<br/>schema · tokens · layout · content · placeholders"}
      EX --> SE
      SE -->|"iterate · re-extract, more effort"| EX
    end

    subgraph S2["② Wireframe · Design Builder"]
      direction TB
      VARS["spec-to-pencil-vars.mjs<br/>tokens → Pencil variables"]
      BUILD["Pencil CLI<br/>pencil --in/--out --prompt --export<br/>(reference screenshot attached)"]
      WE{"Wireframe Evaluator · evaluate-wireframe.mjs<br/>claude VISION judge<br/>layout · visual · content · completeness"}
      VARS --> BUILD --> WE
      WE -->|"iterate · repair findings (≤3, stagnation guard)"| BUILD
    end

    FORGE["③ Forge · production React / Tailwind  (stub)"]
    HAND[/"Verified DesignSpec — handoff"/]:::io
    OUT[/"wireframe.pen + render + preview"/]:::io
    REV["⛔ Halt → human review"]:::warn

    subgraph CVX["🗄️ Convex — Memory &amp; State (real-time)"]
      direction LR
      T[("tasks<br/>status · outputs · handoff")]
      EV[("evaluations<br/>per-iteration score · gates · findings")]
      AC[("agents / activity<br/>live agent log")]
      MEM[("memories<br/>long-term + embeddings")]
    end

    UI[/"Mirror Dashboard · app/mirror<br/>subscribes to Convex (live)"/]:::io

    %% --- pipeline flow ---
    SRC --> ORCH
    ORCH -->|"Stage 1"| EX
    SE -->|"pass"| HAND
    SE -->|"fail"| REV
    HAND --> ORCH
    ORCH -->|"Stage 2"| VARS
    WE -->|"pass / best"| OUT
    WE -->|"fail / max iters"| REV
    OUT --> ORCH
    ORCH -->|"Stage 3"| FORGE

    %% --- memory & state (Convex) ---
    ORCH <-->|"status / outputs"| T
    SE -->|"spec gate result"| EV
    WE -->|"fidelity / iteration"| EV
    S1 -.->|"activity"| AC
    S2 -.->|"activity"| AC
    OUT -.->|"approved → store"| MEM
    T --> UI
    EV --> UI
    AC --> UI

    classDef io fill:#eef2ff,stroke:#4f46e5,color:#1e1b4b;
    classDef orch fill:#fef3c7,stroke:#d97706,color:#451a03;
    classDef warn fill:#fee2e2,stroke:#b91c1c,color:#450a0a;
```

**How to read it**

- **Orchestrator** (`orchestrator.ts`) is the control spine: it sequences the stages, owns every Convex read/write, and decides **pass · iterate · halt** at each gate.
- **Agents** — each paired with an **evaluator**:
  - ① **Pixel** — source analyzer (deterministic extraction)
  - ② **Wireframe** — design builder (drives the Pencil CLI)
  - ③ **Forge** — production code *(stub)*
- **Verification loops — the heart of the system:**
  - **Spec loop** — Pixel extracts → *Spec Evaluator* gates it; `iterate` re-extracts with more effort, `fail` **halts before anything builds on a bad spec**.
  - **Fidelity loop** — Wireframe builds in Pencil → *Wireframe Evaluator* (a `claude` **vision judge**) compares the render against Pixel's reference and returns repair findings → the agent repairs and rebuilds until fidelity clears the bar (≤3 iterations, stagnation guard). **This loop is what drives 1:1.**
- **Memory & state — Convex** (real-time): `tasks` (status, outputs, the verified-spec handoff), `evaluations` (every iteration's score / gates / findings), `agents·activity` (live agent log), `memories` (long-term, embedded). The **dashboard** (`app/mirror`) subscribes to Convex for live spec, iteration scorecards, and the activity feed.

## Stages

| Stage | What it does | Gate / loop |
|-------|--------------|-------------|
| **Pixel** | Headless-Chromium extraction of real computed styles, DOM text, and layout geometry + screenshots at 1440/1024/390 → a `DesignSpec` | **Spec evaluator** (`scripts/evaluate-spec.mjs`): schema / tokens / layout / content / no-placeholders → pass·iterate·fail; retries with more extraction effort |
| **Wireframe** | Translates tokens → Pencil variables, then drives the **Pencil CLI** to build a real `.pen` from the spec (reference screenshot attached to the build) | **Wireframe evaluator** (`scripts/evaluate-wireframe.mjs`): a `claude` vision judge compares the render vs the reference → scored, actionable findings → repair loop toward 1:1 |
| **Forge** | *(stub)* production React/Tailwind from the verified design | — |

## Layout

```
orchestrator.ts                  Pipeline controller (runPixelStage → runWireframeStage)
scripts/
  extract-spec.mjs               Pixel: URL→spec (Playwright) / image→template
  evaluate-spec.mjs              Spec quality gate (deterministic)
  spec.schema.json               Shared DesignSpec contract
  spec-to-pencil-vars.mjs        Deterministic tokens → Pencil variables
  evaluate-wireframe.mjs         Vision-judge fidelity evaluator (drives the 1:1 loop)
squad/                           Agent "souls": pixel, wireframe, forge (+ pipeline contract)
skill/frontend-spec-extractor/   Claude skill wrapping the spec extractor + evaluator
ui/                              Mirror dashboard (Next.js, reference): spec, iteration scorecard, outputs
```

## Standalone usage (the deterministic scripts)

```bash
# Pixel: extract a ground-truth spec from a live page
node scripts/extract-spec.mjs --url https://example.com --out ./out

# Spec gate
node scripts/evaluate-spec.mjs ./out/spec.json

# Tokens → Pencil variables
node scripts/spec-to-pencil-vars.mjs ./out/spec.json

# Wireframe fidelity (after building a render with the Pencil CLI)
node scripts/evaluate-wireframe.mjs --reference ./out/screenshots/desktop.png --render ./out/wireframe.png --spec ./out/spec.json
```

## Requirements

- **Playwright** Chromium (`playwright-core`) for extraction
- **Pencil CLI** authenticated (`pencil login`) for the Wireframe build stage
- **`claude`** CLI authenticated for the vision fidelity judge

## How the loop reaches 1:1

The wireframe agent builds with Pixel's reference screenshot attached, then the vision
judge scores fidelity (layout · visual · content · completeness) and emits concrete repair
instructions. Those feed the next `pencil --in … --out …` pass. Iterates until the score
clears the bar or stops improving — every iteration recorded for benchmarking.
