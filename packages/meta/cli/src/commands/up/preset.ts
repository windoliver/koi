/**
 * PRESET phase — infer and resolve runtime preset from manifest.
 */

import { readFile } from "node:fs/promises";
import type { PresetId, PresetStacks } from "@koi/runtime-presets";

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
      if (id === "local" || id === "demo" || id === "mesh" || id === "sqlite") return id;
    }
    // Infer demo from demo.pack presence
    if (/^demo:\s*\n\s+pack:/m.test(raw)) return "demo";
    return "local";
  } catch {
    return "local";
  }
}

/** Known stack keys that can appear in the `stacks:` section of koi.yaml. */
const STACK_KEYS = [
  "toolStack",
  "retryStack",
  "qualityGate",
  "contextArena",
  "contextHub",
  "ace",
  "goalStack",
  "forge",
  "autoHarness",
  "governance",
] as const;

/** String-keyed backend fields in the stacks section. */
const STACK_BACKEND_KEYS = ["threadStoreBackend", "aceStoreBackend"] as const;

/**
 * Extracts stacks config from raw manifest YAML.
 * Returns a partial PresetStacks with boolean flags and backend strings.
 */
export async function extractStacks(manifestPath: string): Promise<Partial<PresetStacks>> {
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const stacksBlock = /^stacks:\s*\n((?:\s{2}\S.*\n?)*)/m.exec(raw);
    if (stacksBlock?.[1] === undefined) return {};

    const block = stacksBlock[1];
    const stacks: Record<string, unknown> = {};

    for (const key of STACK_KEYS) {
      const match = new RegExp(`^\\s{2}${key}:\\s*true`, "m").exec(block);
      if (match !== null) stacks[key] = true;
    }

    for (const key of STACK_BACKEND_KEYS) {
      const match = new RegExp(`^\\s{2}${key}:\\s*(\\S+)`, "m").exec(block);
      if (match?.[1] !== undefined) stacks[key] = match[1];
    }

    return stacks as Partial<PresetStacks>;
  } catch {
    return {};
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
