# Benchmark run: first corpus (3 targets)

First run of the fidelity benchmark across a small corpus. All three pages **captured cleanly** with
the genuine-browser path (no bot-wall). Fidelity uses the calibrated signal weights
(`vision 0.30 · tokens 0.20 · content 0.18 · gist 0.15 · structure 0.12 · perceptual 0.05`). Cost is
**real and self-reported** by the tools, not estimated.

| target | fidelity | build cost (measured) | vision evals | total | wall time |
|--------|----------|-----------------------|--------------|-------|-----------|
| vercel | 72 / 100 | $4.34 | ~$0.85 | **~$5.2** | ~17 min |
| linear | 72 / 100 | $2.10 | ~$0.85 | **~$3.0** | ~12 min |
| tailwind | 70 / 100 | $5.51 | ~$0.76 | **~$6.3** | ~26 min |

Mean fidelity **71 / 100**. The band is tight (70-72): three comparable, recognizable-but-imperfect
mirrors. The score also held steady when the vision judge drifted ~10 points between runs, because
the deterministic signals dominate the blend (the grounding working).

## Where the money goes

- **The 5 deterministic signals** (SSIM, gist, tokens, structure, content): **$0**. Local code, no tokens.
- **The vision judge**: about **$0.27 per evaluation**, a small fraction of a run.
- **The Pencil build agent**: the dominant cost. Each build runs Claude **opus-4-6**, ~20 turns, with
  1-5M cache-read tokens, at roughly **$1.5-$2 per build**. With up to three build iterations, this is
  essentially the whole bill.

## The lever

This is the real point about loop economics. The cost is not the looping; it is the **build model**.
It is opus-4-6 here. Routing that one step to a cheaper model (Sonnet) would cut the dominant line
item sharply, at a quality tradeoff you can then measure on this same benchmark. Cost is a routing
decision, not a fixed tax, and the measurement that grounds the whole loop costs nothing.

*(Measured via the pipeline's own metrics: Pencil builds report usage via `--usage`, the vision judge
via `claude --output-format json`. Wall times are approximate; builds with image generation are the
slow step, separate from cost.)*
