/**
 * Minimal agent manifest loader for #1264.
 *
 * Loads a YAML manifest file and extracts the fields needed for basic
 * agent customization: model name, behavioral instructions, and the
 * opt-in preset stack list.
 *
 * Intentionally minimal — full AgentManifest assembly is out of scope.
 *
 * Manifest format (koi.yaml):
 *   name: my-agent          # optional, informational
 *   model:
 *     name: google/gemini-2.0-flash-001
 *   instructions: |         # optional — injected as system prompt
 *     You are a helpful coding assistant.
 *   stacks:                 # optional — opt into a subset of preset stacks
 *     - notebook            #   (omit to activate every stack in DEFAULT_STACKS)
 *     - rules
 *     - skills
 */

import { loadConfig } from "@koi/config";

export interface ManifestConfig {
  readonly modelName: string;
  readonly instructions: string | undefined;
  /**
   * Opt-in subset of preset stack ids. `undefined` means "activate every
   * stack in `DEFAULT_STACKS`" (v1's default posture). An empty array
   * means "deactivate every stack" (the host runs core middleware only).
   */
  readonly stacks: readonly string[] | undefined;
}

/**
 * Load a minimal agent manifest from a YAML or JSON file.
 *
 * Validates eagerly — call before creating any adapters so errors surface
 * before any API calls are made.
 *
 * Returns `{ ok: false, error }` for file-not-found, parse errors, or
 * missing required fields. Never throws.
 */
export async function loadManifestConfig(
  path: string,
): Promise<
  | { readonly ok: true; readonly value: ManifestConfig }
  | { readonly ok: false; readonly error: string }
> {
  const result = await loadConfig(path);
  if (!result.ok) {
    return { ok: false, error: result.error.message };
  }

  const raw = result.value;

  const model = raw.model;
  if (typeof model !== "object" || model === null) {
    return {
      ok: false,
      error: "manifest.model is required — add:\n  model:\n    name: google/gemini-2.0-flash-001",
    };
  }

  const modelName = (model as Record<string, unknown>).name;
  if (typeof modelName !== "string" || modelName.trim().length === 0) {
    return {
      ok: false,
      error: "manifest.model.name is required and must be a non-empty string",
    };
  }

  const instructions = raw.instructions;
  if (instructions !== undefined && typeof instructions !== "string") {
    return {
      ok: false,
      error: "manifest.instructions must be a string (use a YAML block scalar: instructions: |)",
    };
  }

  const stacksRaw = raw.stacks;
  let stacks: readonly string[] | undefined;
  if (stacksRaw === undefined) {
    stacks = undefined;
  } else if (!Array.isArray(stacksRaw)) {
    return {
      ok: false,
      error: "manifest.stacks must be a list of stack ids, e.g. stacks: [notebook, rules, skills]",
    };
  } else {
    const invalid = stacksRaw.find((s) => typeof s !== "string" || s.length === 0);
    if (invalid !== undefined) {
      return {
        ok: false,
        error: "manifest.stacks entries must all be non-empty strings",
      };
    }
    stacks = stacksRaw as readonly string[];
  }

  return {
    ok: true,
    value: {
      modelName: modelName.trim(),
      instructions: instructions as string | undefined,
      stacks,
    },
  };
}
