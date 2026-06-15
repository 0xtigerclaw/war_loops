// War Loops - signal registry. Discovers enabled signals from the config and
// loads each `<name>.mjs` module. Pluggable: a new signal = a file + a config line.
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function loadSignals(config) {
  const loaded = [];
  for (const s of config.signals || []) {
    if (s.enabled === false) continue;
    try {
      const mod = await import(path.join(__dirname, `${s.name}.mjs`));
      if (typeof mod.score === "function") {
        loaded.push({ name: s.name, weight: typeof s.weight === "number" ? s.weight : 1, score: mod.score, axis: mod.axis || s.axis || null });
      }
    } catch (e) {
      console.error(`[registry] signal "${s.name}" failed to load: ${e.message}`);
    }
  }
  return loaded;
}
