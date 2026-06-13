# Frontend Mirror Pipeline

## Mandatory Flow

```
Pixel (Source Analyzer) → Wireframe (Design Builder) ⟳ [Evaluator] → Forge (Frontend Builder)
```

> **Sequential flow with an evaluation loop between Wireframe and Forge.**

---

## Pipeline Stages

### Stage 1: Pixel (Source Analyzer)
**Input**: Source URL or image path (from task description)
**Output**: `design_spec` (structured JSON)
**Runtime**: Claude Code with Claude Preview MCP (for URL sources)

- Loads source in browser (URLs) or analyzes via vision (images)
- Captures multi-viewport screenshots (1440, 1024, 390)
- Extracts layout structure, design tokens, content, interaction states
- Outputs machine-readable design spec

**Handoff Condition**: Spec includes at minimum: layout regions, color tokens, typography scale, required content list

---

### Stage 2: Wireframe (Design Builder) ← LOOP START
**Input**: `design_spec` from Pixel (iteration 0) or evaluator `findings` (iteration 1+)
**Output**: `.pen` wireframe file
**Runtime**: Claude Code with Pencil MCP

- Builds wireframe in Pencil matching the design spec
- On repair iterations, fixes only flagged findings
- Captures screenshot + layout snapshot after each build

**Handoff Condition**: Evaluator returns `pass` decision

---

### Stage 2.5: Orchestrator Evaluation
**Input**: Wireframe screenshot + layout snapshot + design spec
**Output**: `evaluation` (decision + gates + findings)
**Runtime**: Claude Code (orchestrator module)

Evaluates wireframe against design spec using subset of gates:
- G04: Primary content fidelity
- G05: Layout integrity
- G06: Responsive structure
- G08: Semantic editability
- G09: Typography hierarchy

**Decision**:
- `pass` → proceed to Forge
- `iterate` → return to Wireframe with repair instructions
- `fail` → stop pipeline

---

### Stage 3: Forge (Frontend Builder)
**Input**: Verified wireframe (screenshot + layout + tokens) + original design spec
**Output**: Production React + Tailwind code in `output/mirror-{taskId}/`
**Runtime**: Claude Code

- Converts verified wireframe into production frontend code
- Uses design tokens from Pencil for Tailwind config
- Implements all viewport breakpoints
- One-shot build — wireframe is pre-verified

**Handoff Condition**: Code builds without errors

---

### Stage 4: Tigerclaw Review
**Input**: Built frontend + evaluation history
**Output**: Final review synthesis

Standard Tigerclaw synthesis pass (same as other pipelines).

---

## Flow Enforcement

```json
{
  "pipeline_id": "frontend_mirror",
  "version": "1.0",
  "mandatory": true,
  "runtime": "claude-code",
  "stages": [
    {
      "stage": 1,
      "agent": "Pixel",
      "skill": "SourceAnalyzer",
      "input_type": "source_ref",
      "output_type": "design_spec",
      "next_stage": 2,
      "mcp_required": ["Claude Preview"]
    },
    {
      "stage": 2,
      "agent": "Wireframe",
      "skill": "DesignBuilder",
      "input_type": "design_spec",
      "output_type": "pen_wireframe",
      "requires_stage": 1,
      "next_stage": 2.5,
      "loop": true,
      "max_iterations": 5,
      "mcp_required": ["Pencil"]
    },
    {
      "stage": 2.5,
      "agent": "Orchestrator",
      "skill": "WireframeEvaluator",
      "input_type": "pen_wireframe",
      "output_type": "evaluation",
      "requires_stage": 2,
      "next_stage_pass": 3,
      "next_stage_iterate": 2,
      "mcp_required": ["Pencil"]
    },
    {
      "stage": 3,
      "agent": "Forge",
      "skill": "FrontendBuilder",
      "input_type": "verified_wireframe",
      "output_type": "frontend_code",
      "requires_stage": 2.5,
      "next_stage": null
    }
  ],
  "skip_allowed": false,
  "parallel_allowed": false
}
```

---

## Loop Rules

| Rule | Value |
|------|-------|
| Max wireframe iterations | 5 |
| Pass threshold | All applicable gates pass + overall score >= 75 |
| Stagnation detection | Score improves < 5 points for 2 consecutive iterations |
| Stagnation action | `fail` — stop pipeline |
| Regression detection | New P1 finding appears after repair |
| Regression action | Prioritize regression fix before continuing polish |

---

## Task Assignment Rules

1. **Frontend-mirror tasks MUST start with Pixel**
2. **Wireframe cannot run without Pixel's design spec**
3. **Forge cannot run without evaluation `pass` on wireframe**
4. **Gateway routes these tasks to Claude Code, not clawdbot agents**
5. **Evaluations are recorded in the `evaluations` table for every iteration**

---

## Triggers

| Trigger | Starts At |
|---------|-----------|
| Manual task with `pipelineType: "frontend-mirror"` | Pixel |
| Mirror dashboard "New" button | Pixel |
