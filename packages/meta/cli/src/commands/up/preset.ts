/**
 * PRESET phase — infer and resolve runtime preset from manifest.
 */

import { readFile } from "node:fs/promises";
import type { PresetId } from "@koi/runtime-presets";

/**
 * Infers the runtime preset from manifest YAML.
 * Reads `preset:` field if present, falls back to heuristics.
 */
export async function inferPresetId(manifestPath: string): Promise<PresetId> {
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const presetMatch = /^preset:\s*(\S+)/m.exec(raw);
    if (presetMatch?.[1] !== undefined) {
      const id = presetMatch[1];
      if (id === "local" || id === "demo" || id === "mesh") return id;
    }
    // Infer demo from demo.pack presence
    if (/^demo:\s*\n\s+pack:/m.test(raw)) return "demo";
    return "local";
  } catch {
    return "local";
  }
}
