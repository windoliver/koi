/**
 * Brick-based agent manifest assembly.
 *
 * Given a list of brick IDs, loads them from the store and generates
 * a `koi.yaml`-style manifest YAML string. Returns both the YAML and
 * the loaded brick artifacts for reuse by callers (e.g. trust propagation).
 */

import type { BrickArtifact, ForgeStore, Result } from "@koi/core";
import { brickId } from "@koi/core";
import type { ForgeError } from "@koi/forge-types";
import { isVisibleToAgent, staticError } from "@koi/forge-types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Optional visibility context for brick access checks. */
export interface AssembleVisibility {
  readonly agentId: string;
  readonly zoneId?: string | undefined;
}

export interface AssembleManifestOptions {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly agentType?: string;
}

export interface AssembleManifestResult {
  readonly manifestYaml: string;
  readonly loadedBricks: readonly BrickArtifact[];
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function yamlQuote(value: string): string {
  if (/[:#[\]{}&*!|>'"%@`]/.test(value) || value.trim() !== value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function assembleManifest(
  brickIds: readonly string[],
  store: ForgeStore,
  options: AssembleManifestOptions,
  visibility?: AssembleVisibility,
): Promise<Result<AssembleManifestResult, ForgeError>> {
  if (brickIds.length === 0) {
    return {
      ok: false,
      error: staticError("MISSING_FIELD", "brickIds must not be empty"),
    };
  }

  // Load all bricks in parallel (14A) — use allSettled to handle store implementations
  // that throw instead of returning Result
  const settled = await Promise.allSettled(brickIds.map((id) => store.load(brickId(id))));
  const loadResults = settled.map((s) => (s.status === "fulfilled" ? s.value : undefined));

  // Validate all exist, collect missing IDs
  const loadedBricks: BrickArtifact[] = [];
  const missingIds: string[] = [];

  for (let i = 0; i < loadResults.length; i++) {
    const result = loadResults[i];
    if (result === undefined || !result.ok) {
      const id = brickIds[i];
      if (id !== undefined) {
        missingIds.push(id);
      }
    } else if (
      visibility !== undefined &&
      !isVisibleToAgent(result.value, visibility.agentId, visibility.zoneId)
    ) {
      const id = brickIds[i];
      if (id !== undefined) {
        missingIds.push(id);
      }
    } else {
      loadedBricks.push(result.value);
    }
  }

  if (missingIds.length > 0) {
    return {
      ok: false,
      error: staticError("MISSING_FIELD", `Brick(s) not found: ${missingIds.join(", ")}`),
    };
  }

  // Categorize bricks
  const toolNames: string[] = [];
  const skillNames: string[] = [];

  for (const brick of loadedBricks) {
    if (brick.kind === "tool") {
      toolNames.push(brick.name);
    } else if (brick.kind === "skill") {
      skillNames.push(brick.name);
    }
    // agent, middleware, channel bricks are noted but not rejected
  }

  // Generate manifest YAML
  const manifestYaml = buildManifestYaml(options, toolNames, skillNames);

  return { ok: true, value: { manifestYaml, loadedBricks } };
}

// ---------------------------------------------------------------------------
// YAML builder
// ---------------------------------------------------------------------------

function buildManifestYaml(
  options: AssembleManifestOptions,
  toolNames: readonly string[],
  skillNames: readonly string[],
): string {
  const lines: string[] = [];

  lines.push(`name: ${yamlQuote(options.name)}`);
  lines.push(`description: ${yamlQuote(options.description)}`);

  if (options.model !== undefined) {
    lines.push(`model: ${yamlQuote(options.model)}`);
  }
  if (options.agentType !== undefined) {
    lines.push(`agentType: ${yamlQuote(options.agentType)}`);
  }

  if (toolNames.length > 0) {
    lines.push("tools:");
    for (const name of toolNames) {
      if (name.startsWith("# ")) {
        lines.push(`  ${name}`);
      } else {
        lines.push(`  - name: ${yamlQuote(name)}`);
      }
    }
  }

  if (skillNames.length > 0) {
    lines.push("metadata:");
    lines.push("  skills:");
    for (const name of skillNames) {
      lines.push(`    - ${yamlQuote(name)}`);
    }
  }

  return lines.join("\n");
}
