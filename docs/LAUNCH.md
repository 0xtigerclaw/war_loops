# Productization and launch plan

Working plan to take War Loops from a research-grade local pipeline to something the
public can try (and that survives a Product Hunt spike). Quality of the builds is the
gating prerequisite and is tracked separately; this doc is everything else.

## What a public user does

Paste a URL (or upload a screenshot) -> watch the pipeline run live -> get a faithful,
**moving** mirror they can preview, see scored on three axes (static / experiential /
responsive), and **download as self-contained HTML**. That is the whole promise:
"point it at a page, get a moving clone you can edit, with an honest fidelity score."

## The public architecture decision: Forge-only

The local pipeline has two builders. For the public product, the Pencil Wireframe stage
is a problem (see blocker 2), so the public path is **Forge-only**:

```
URL/image -> Pixel (capture + spec + motion) -> Forge (codegen -> animated HTML,
              3-axis scored + repair loop) -> preview + scores + download
```

Pencil stays as the internal "polished static reference" builder and for our own
benchmarking, but the public never touches it. Forge already takes a visual base; for
the public path it uses the captured reference screenshot as that base instead of the
Pencil render. This removes the account dependency entirely and keeps the moving-clone
promise intact.

## The four hard blockers, with concrete solutions

### 1. Economics (the biggest one)
A full run is ~$6-7 and ~27 min on our own credits. Public traffic = hundreds of runs =
a large bill, fast.
- **Forge-only** already drops the Pencil build cost (~half the bill).
- **Model routing** (the dial we built, `models.config.json`): run Forge on a cheaper
  model and measure the quality/cost tradeoff on the benchmark before launch. Target a
  sub-$1 run.
- **Credits + auth**: free tier = N runs, then sign-in / paid. No anonymous unlimited.
- **Async queue**: one run at a time per user, queued; the 27 min becomes a "we will
  email you / it appears in your dashboard" flow, not a blocking wait. Cache results by
  URL so repeated popular URLs are free.

### 2. The Pencil-account dependency
Wireframe needs our authenticated Pencil CLI; we cannot expose that to the public.
- **Solution: Forge-only public path** (above). Pencil is internal-only.

### 3. Server-side browser + bot walls
Genuine capture needs a real browser; on a server, headless gets bot-walled on many
real sites, and headed Chrome is awkward to run.
- Run capture in a **headed-Chrome-in-a-container** (xvfb / a browser farm like
  Browserless or a dedicated capture worker) so the genuine-browser path survives.
- Keep the **`blocked` hard-gate**: if a site bot-walls, fail honestly with "this site
  blocks automated capture, try image mode" rather than building from a challenge page.
- **Image mode** is the universal fallback (user uploads a screenshot; no capture
  needed) and sidesteps both bot walls and most IP concerns.

### 4. Product surface
No hosted app today (the dashboard is internal).
- A thin web app: URL/upload input -> live activity stream (we already log per-stage
  activity to Convex) -> result page (preview iframe of the HTML + three-axis scorecard
  + findings + download). Convex is already the real-time backbone.

## Trust and safety (before public)
- **Auth + rate limits + credits** (also the cost control).
- **IP / ToS**: cloning arbitrary sites is sensitive. Guardrails: an attestation that the
  user has the right to clone the target, a blocklist, and "for design reference, not
  redistribution" framing. Favor image mode and the user's own pages for the demo.
- **Abuse**: no using it to clone login/banking pages for phishing; domain checks.

## Phased roadmap

1. **Quality bar (now).** Baseline across a diverse corpus, then drive all three axes to
   "great." Nothing ships until a stranger's first result reliably impresses.
2. **Cheap + Forge-only.** Route Forge to a cheaper model, prove the quality/cost
   tradeoff, wire the public Forge-only path (reference screenshot as base).
3. **Hosted MVP.** Web app: input -> live run -> preview + scores + download. Auth +
   credits + queue + result caching. Capture worker (headed Chrome in a container) with
   image-mode fallback.
4. **Private beta.** Invite a handful; watch real URLs, fix the long tail of capture and
   quality failures; confirm cost per run.
5. **Product Hunt.** Landing page, 60-second demo (the moving clone is the hook), docs,
   a few hero before/after examples. Launch with credits capped so a spike cannot bankrupt us.

## Open decisions for Swayam
- Free-tier shape: how many free runs, then paid vs sign-in-gated?
- Hosting: where do the capture worker + app + queue live?
- Pencil: internal-only forever, or pursue a multi-tenant Pencil arrangement later for a
  "polished static" premium tier?
- Positioning: "design reference tool" (safer) vs "site cloner" (punchier, riskier)?
