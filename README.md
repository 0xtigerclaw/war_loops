# war_loops

**Mirror any web page into a faithful, editable design — autonomously.**

Point war_loops at a **URL or an image**. It extracts a ground-truth design spec, builds it in
Pencil, and **self-corrects against the original until it's a 1:1 match**. Every stage is guarded
by a verification loop — a deterministic gate on the spec, and a vision-judged fidelity loop on
the build — so it ships *fidelity, not guesses*.

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

    FORGE["③ Forge · production React / Tailwind"]
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

    UI[/"Mirror Dashboard<br/>subscribes to Convex (live)"/]:::io

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

**The pieces**

- **Orchestrator** (`orchestrator.ts`) — the control spine. Sequences the stages, owns every Convex read/write, and makes the **pass · iterate · halt** decision at each gate.
- **Agents**, each paired with an **evaluator**:
  - ① **Pixel** — source analyzer; deterministic extraction of the real page.
  - ② **Wireframe** — design builder; drives the Pencil CLI to build the `.pen`.
  - ③ **Forge** — production React/Tailwind from the verified design.
- **Verification loops — the heart of the system:**
  - **Spec loop** — Pixel extracts → the *Spec Evaluator* gates it; `iterate` re-extracts with more effort, `fail` **halts before anything builds on a bad spec**.
  - **Fidelity loop** — Wireframe builds in Pencil → the *Wireframe Evaluator* (a `claude` **vision judge**) compares the render against the original and returns concrete repair findings → the agent repairs and rebuilds until fidelity clears the bar (≤3 iterations, stagnation guard). **This is what drives 1:1.**
- **Memory & state — Convex** (real-time): `tasks` (status, outputs, the verified-spec handoff), `evaluations` (every iteration's score / gates / findings), `agents·activity` (live agent log), `memories` (long-term, embedded). The **dashboard** subscribes to Convex for live spec, iteration scorecards, and the activity feed.

## How it works

| Stage | What it does | Gate / loop |
|-------|--------------|-------------|
| **① Pixel** | Headless-Chromium extraction of real computed styles, DOM text, and layout geometry + screenshots at 1440/1024/390 → a `DesignSpec` | **Spec evaluator** — schema · tokens · layout · content · no-placeholders → pass·iterate·fail; retries with more extraction effort |
| **② Wireframe** | Translates tokens → Pencil variables, then drives the **Pencil CLI** to build a real `.pen` from the spec (with the reference screenshot attached to the build) | **Wireframe evaluator** — a `claude` vision judge compares the render vs the original → scored, actionable findings → repair loop toward 1:1 |
| **③ Forge** | Production React / Tailwind generated from the verified design | — |

## Repo layout

```
orchestrator.ts                  Pipeline controller (runPixelStage → runWireframeStage → Forge)
scripts/
  extract-spec.mjs               Pixel: URL→spec (Playwright) / image→template
  evaluate-spec.mjs              Spec quality gate (deterministic)
  spec.schema.json               The DesignSpec contract
  spec-to-pencil-vars.mjs        Tokens → Pencil variables
  evaluate-wireframe.mjs         Vision-judge fidelity evaluator (drives the 1:1 loop)
squad/                           Agent definitions: pixel, wireframe, forge (+ pipeline contract)
skill/frontend-spec-extractor/   Claude skill wrapping the spec extractor + evaluator
ui/                              Mirror dashboard: live spec, iteration scorecard, agent activity
```

## Usage

```bash
# ① Pixel — extract a ground-truth spec from a live page
node scripts/extract-spec.mjs --url https://example.com --out ./out

# Spec gate
node scripts/evaluate-spec.mjs ./out/spec.json

# Tokens → Pencil variables
node scripts/spec-to-pencil-vars.mjs ./out/spec.json

# ② Fidelity — score a build against the original
node scripts/evaluate-wireframe.mjs --reference ./out/screenshots/desktop.png --render ./out/wireframe.png --spec ./out/spec.json
```

## Requirements

- **Playwright** Chromium (`playwright-core`) — page extraction
- **Pencil CLI** authenticated (`pencil login`) — the Wireframe build stage
- **`claude`** CLI authenticated — the vision fidelity judge

## How the loop reaches 1:1

The Wireframe agent builds with the original's screenshot attached, then the vision judge scores
fidelity across **layout · visual · content · completeness** and emits concrete repair
instructions. Those feed the next `pencil --in … --out …` pass. It iterates until the score clears
the bar or stops improving — and every iteration is recorded, so fidelity is measurable and
regressions are caught.
