/**
 * PRESET phase — infer and resolve runtime preset from manifest.
 */

import type { PresetId } from "@koi/runtime-presets";

/** Minimal manifest shape needed for preset inference. */
interface ManifestLike {
  readonly preset?: string | undefined;
  readonly demo?: { readonly pack?: string | undefined } | undefined;
}

/**
 * Infers the runtime preset from a parsed manifest object.
 * Reads `preset` field if present, falls back to heuristics.
 */
export function inferPresetId(manifest: ManifestLike): PresetId {
  const id = manifest.preset;
  if (id === "local" || id === "demo" || id === "mesh") return id;
  // Infer demo from demo.pack presence
  if (manifest.demo?.pack !== undefined) return "demo";
  return "local";
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
