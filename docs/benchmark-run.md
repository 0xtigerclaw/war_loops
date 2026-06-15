# Benchmark run: full pipeline, three axes

A full live run of the complete pipeline on `linear` (Pixel to Pencil Wireframe to Forge), captured
cleanly with the genuine browser (no bot-wall). Every number is **measured by the tools, not
estimated** (Pencil and Forge self-report via `--usage` / `claude --output-format json`).

## Results

| build | static | experiential | responsive | iterations |
|-------|--------|--------------|------------|------------|
| Wireframe (Pencil static mirror) | 68 | n/a | n/a | 2 |
| Forge (code, moving) | 69 | 66 | 83 | 3 |

Wireframe per-signal (static panel): content 57, gist 66, layout 63, perceptual 24, structure 88,
tokens 80, vision 71.

Two things this shows:

1. **Forge matches the Pencil mirror on design (69 vs 68) and adds what a static file cannot.** The
   verbatim-text injection plus the repair loop closed the gap that an early single-pass Forge had
   (static 53). On top of that it carries motion (experiential 66) and reflow (responsive 83).
2. **The experiential number is honest.** A count-based richness proxy reads about 87 on builds like
   this ("has comparable motion vocabulary"); the frame-based motion-match reports 66 ("moves the same
   way, at the same moments, in the same places"). The lower, true number is the one we keep.

## Where the money goes

The run was **$6.62 over 27 minutes, 4.8M input / 81k output tokens**. It splits cleanly between the
two LLM build stages; everything else is free.

| stage | cost | note |
|-------|------|------|
| Pencil Wireframe | ≈$3.5 | 2 build iterations ($1.25 + $1.20) + read-backs + evals |
| Forge codegen | ≈$3.1 | 3 codegen iterations ($0.73 + $1.24 + $1.11) |
| vision judge | ≈$0.4 | a small fraction of a run |
| capture, motion capture (x4), renders | **$0** | deterministic |
| the 6 static signals + motion-match + responsiveness | **$0** | local code, no tokens |

The cost is the two build models, and both are routing dials (`models.config.json`: the `build` and
`forge` roles). Send either to a cheaper model and the dominant line item drops, at a quality tradeoff
you can measure on this same benchmark. The measurement that grounds the whole thing costs nothing.

## Broader static fidelity

Across `tailwind / vercel / linear`, the seven-signal static panel runs a mean of about **74/100**
(tight band; a few points of run-to-run variance on the build model). The three-axis run above is the
end-to-end validation that the Forge stage, the experiential motion-match, and the responsiveness axis
all run live in the pipeline.

*(Wall times are approximate; the two build stages, each with image generation, are the slow steps and
are separate from cost.)*
