/**
 * PRESET phase — infer and resolve runtime preset from manifest.
 */

import { readFile } from "node:fs/promises";
import type { PresetId } from "@koi/runtime-presets";

/**
 * Infers the runtime preset from raw manifest YAML.
 *
 * Reads the raw file because `preset` and `demo` are extension fields
 * that the manifest parser strips from the parsed object.
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

/**
 * Extracts the demo pack ID from manifest YAML.
 * Returns undefined if no `demo.pack` field is present.
 */
export async function extractDemoPack(manifestPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const match = /^demo:\s*\n\s+pack:\s*(\S+)/m.exec(raw);
    return match?.[1];
  } catch {
    return undefined;
  }
}
