// War Loops - signal contract.
//
// A "signal" is one fidelity scorer. Each signal module exports:
//   export const name = "<id>";
//   export async function score(ctx) -> { score: 0..100, detail: string, findings: [] } | null
//
// ctx = { referencePath, renderPath, specPath, penPath }
//   referencePath : Pixel's reference screenshot (the original)
//   renderPath    : the built wireframe render
//   specPath      : the verified DesignSpec JSON
//   penPath       : the built .pen file (optional; for token/structure signals)
//
// Return null to abstain (e.g. inputs missing) - the aggregator drops it and
// renormalizes the remaining weights. A finding is:
//   { severity: "P0"|"P1"|"P2", area: string, observed: string, fix: string }

export const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
