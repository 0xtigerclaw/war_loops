# War Loops: Autonomous Frontend Designer

**Mirror any web page into a faithful, editable design. Autonomously.**

Point War Loops at a **URL or an image**. It extracts a ground-truth design spec, builds it in
Pencil, and **self-corrects against the original until it's a 1:1 match**. Every stage is guarded
by a verification loop: a deterministic gate on the spec, and a vision-judged fidelity loop on the
build, so it ships *fidelity, not guesses*.

## Architecture

```mermaid
flowchart TB
    SRC(["URL / Image"]):::io
    ORCH{{"Orchestrator<br/>runFrontendMirrorPipeline()"}}:::orch

    subgraph S1["① Pixel · Source Analyzer"]
      direction TB
      EX["extract-spec.mjs<br/>Playwright: computed styles, DOM,<br/>geometry, screenshots @ 1440/1024/390"]
      SE{"Spec Evaluator · evaluate-spec.mjs<br/>schema · tokens · layout · content · placeholders"}
      EX --> SE
      SE -->|"iterate · re-extract, more effort"| EX
    end

    subgraph S2["② Wireframe · Design Builder"]
      direction TB
      VARS["spec-to-pencil-vars.mjs<br/>tokens to Pencil variables"]
      BUILD["Pencil CLI<br/>pencil --in/--out --prompt --export<br/>(reference screenshot attached)"]
      WE{"Wireframe Evaluator · evaluate-wireframe.mjs<br/>claude VISION judge<br/>layout · visual · content · completeness"}
      VARS --> BUILD --> WE
      WE -->|"iterate · repair findings (≤3, stagnation guard)"| BUILD
    end

    FORGE["③ Forge · production React / Tailwind"]
    HAND[/"Verified DesignSpec · handoff"/]:::io
    OUT[/"wireframe.pen + render + preview"/]:::io
    REV["⛔ Halt to human review"]:::warn

    subgraph CVX["🗄️ Convex · Memory and State (real-time)"]
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

    %% --- memory and state (Convex) ---
    ORCH <-->|"status / outputs"| T
    SE -->|"spec gate result"| EV
    WE -->|"fidelity / iteration"| EV
    S1 -.->|"activity"| AC
    S2 -.->|"activity"| AC
    OUT -.->|"approved, store"| MEM
    T --> UI
    EV --> UI
    AC --> UI

    classDef io fill:#eef2ff,stroke:#4f46e5,color:#1e1b4b;
    classDef orch fill:#fef3c7,stroke:#d97706,color:#451a03;
    classDef warn fill:#fee2e2,stroke:#b91c1c,color:#450a0a;
```

**The pieces**

- **Orchestrator** (`orchestrator.ts`): the control spine. Sequences the stages, owns every Convex read/write, and makes the **pass · iterate · halt** decision at each gate.
- **Agents**, each paired with an **evaluator**:
  - ① **Pixel**: source analyzer; deterministic extraction of the real page.
  - ② **Wireframe**: design builder; drives the Pencil CLI to build the `.pen`.
  - ③ **Forge**: production React/Tailwind from the verified design.
- **Verification loops** (the heart of the system):
  - **Spec loop**: Pixel extracts, the *Spec Evaluator* gates it; `iterate` re-extracts with more effort, `fail` **halts before anything builds on a bad spec**.
  - **Fidelity loop**: Wireframe builds in Pencil, the *Wireframe Evaluator* (a `claude` **vision judge**) compares the render against the original and returns concrete repair findings, and the agent repairs and rebuilds until fidelity clears the bar (≤3 iterations, stagnation guard). **This is what drives 1:1.**
- **Memory and state** with **Convex** (real-time): `tasks` (status, outputs, the verified-spec handoff), `evaluations` (every iteration's score / gates / findings), `agents·activity` (live agent log), `memories` (long-term, embedded). The **dashboard** subscribes to Convex for live spec, iteration scorecards, and the activity feed.

## The loop stack: loops all the way down

War Loops is **recursive by design**: every loop wraps the one beneath it, adds a *judge*, and
only exits when that judge is satisfied. A token loop produces a tool turn; tool turns produce a
build; a judge bounces the build back until it's faithful; the pipeline chains judged stages; and
a benchmark loop tunes the whole machine over time. The nesting *is* the architecture.

```mermaid
flowchart TB
  subgraph L5["⑤ Benchmark loop · score and tune · exit: none · ∞"]
    subgraph L4["④ Pipeline · Pixel to Wireframe to Forge · exit: 1:1 deliverable or review · ~hours"]
      subgraph L3["③ Verify loop · build · judge · repair · exit: gate passes / stagnation · ~minutes"]
        subgraph L2["② Tool turn · call tool · feed result · exit: no more tool calls · ~seconds to min"]
          subgraph L1["① Token loop · sample · append · repeat · exit: stop token · ~seconds"]
            TOK["the · cat · sat · ▮"]:::tok
          end
        end
      end
    end
  end
  classDef tok fill:#fff7ed,stroke:#c2410c,color:#7c2d12;
```

| # | Loop | Each cycle | Judge / exit | Timescale | In War Loops |
|---|------|-----------|--------------|-----------|--------------|
| ① | **Token loop** | sample, append, repeat | stop token | ~seconds | the substrate of every agent and judge call |
| ② | **Tool turn** | call tool, feed result | no more tool calls | ~seconds to min | Pencil `batch_design`/`get_screenshot`; Playwright extraction steps |
| ③ | **Verify loop** ⭐ | build/extract, **judge**, repair | gate passes (spec valid · fidelity ≥ bar) **or** stagnation | ~minutes | the **spec gate** *and* the **vision-judged fidelity loop** |
| ④ | **Pipeline** | Pixel, Wireframe, Forge, each a verify loop, handed off | 1:1 deliverable, or halt to human review | ~min to hours | the **orchestrator** |
| ⑤ | **Benchmark loop** | run many targets, score fidelity, tune gates/prompts | none, continuous improvement | ∞ | "eval on our UI": measurable fidelity over time |

⭐ **Level ③ is War Loops' signature.** Most pipelines stop at level ④ (chain the stages and hope).
War Loops wraps *each* stage in a judge-gated repair loop, so a stage cannot advance until its
output is verified: a thin spec never reaches the build, and an unfaithful build never reaches you.

## How it works

| Stage | What it does | Gate / loop |
|-------|--------------|-------------|
| **① Pixel** | Headless-Chromium extraction of real computed styles, DOM text, and layout geometry + screenshots at 1440/1024/390 into a `DesignSpec` | **Spec evaluator**: schema · tokens · layout · content · no-placeholders, returning pass·iterate·fail; retries with more extraction effort |
| **② Wireframe** | Translates tokens to Pencil variables, then drives the **Pencil CLI** to build a real `.pen` from the spec (with the reference screenshot attached to the build) | **Wireframe evaluator**: a `claude` vision judge compares the render vs the original, returning scored, actionable findings into a repair loop toward 1:1 |
| **③ Forge** | Production React / Tailwind generated from the verified design | (none yet) |

## Repo layout

```
orchestrator.ts                  Pipeline controller (runPixelStage, runWireframeStage, Forge)
scripts/
  extract-spec.mjs               Pixel: URL to spec (Playwright) / image to template
  evaluate-spec.mjs              Spec quality gate (deterministic)
  spec.schema.json               The DesignSpec contract
  spec-to-pencil-vars.mjs        Tokens to Pencil variables
  evaluate-wireframe.mjs         Vision-judge fidelity evaluator (drives the 1:1 loop)
squad/                           Agent definitions: pixel, wireframe, forge (+ pipeline contract)
skill/frontend-spec-extractor/   Claude skill wrapping the spec extractor + evaluator
ui/                              Mirror dashboard: live spec, iteration scorecard, agent activity
```

## Usage

```bash
# Pixel: extract a ground-truth spec from a live page
node scripts/extract-spec.mjs --url https://example.com --out ./out

# Spec gate
node scripts/evaluate-spec.mjs ./out/spec.json

# Tokens to Pencil variables
node scripts/spec-to-pencil-vars.mjs ./out/spec.json

# Fidelity: score a build against the original
node scripts/evaluate-wireframe.mjs --reference ./out/screenshots/desktop.png --render ./out/wireframe.png --spec ./out/spec.json
```

## Requirements

- **Playwright** Chromium (`playwright-core`) for page extraction
- **Pencil CLI** authenticated (`pencil login`) for the Wireframe build stage
- **`claude`** CLI authenticated for the vision fidelity judge

## How the loop reaches 1:1

The Wireframe agent builds with the original's screenshot attached, then the vision judge scores
fidelity across **layout · visual · content · completeness** and emits concrete repair
instructions. Those feed the next `pencil --in ... --out ...` pass. It iterates until the score
clears the bar or stops improving, and every iteration is recorded, so fidelity is measurable and
regressions are caught.
