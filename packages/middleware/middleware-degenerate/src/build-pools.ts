/**
 * Builds variant pools from ForgeStore queries.
 *
 * For each capability in the config, queries the forge store for matching
 * bricks and builds executable ToolHandler entries with fitness scores.
 */

import type { BrickArtifact, DegeneracyConfig, ForgeStore, ToolHandler } from "@koi/core";
import { computeBrickFitness } from "@koi/validation";
import type { VariantEntry, VariantPool } from "@koi/variant-selection";

export interface BuildPoolsOptions {
  readonly forgeStore: ForgeStore;
  readonly capabilityConfigs: ReadonlyMap<string, DegeneracyConfig>;
  readonly createToolExecutor: (brick: BrickArtifact) => ToolHandler | Promise<ToolHandler>;
  readonly clock: () => number;
}

/**
 * Queries the forge store for variants of each capability and builds
 * executable variant pools.
 *
 * Also returns a mapping from tool name → capability name for fast lookup.
 */
export async function buildVariantPools(options: BuildPoolsOptions): Promise<{
  readonly pools: ReadonlyMap<string, VariantPool<ToolHandler>>;
  readonly toolToCapability: ReadonlyMap<string, string>;
}> {
  const { forgeStore, capabilityConfigs, createToolExecutor, clock } = options;
  const nowMs = clock();
  const pools = new Map<string, VariantPool<ToolHandler>>();
  const toolToCapability = new Map<string, string>();

  for (const [capability, config] of capabilityConfigs) {
    // Query forge store for bricks tagged with this capability
    const searchResult = await forgeStore.search({
      kind: "tool",
      lifecycle: "active",
      tags: [`capability:${capability}`],
    });

    if (!searchResult.ok) continue;

    const bricks = searchResult.value;
    if (bricks.length === 0) continue;

    // Score and sort bricks by fitness, cap at maxVariants
    const scored: { readonly brick: BrickArtifact; readonly fitness: number }[] = bricks
      .map((brick) => ({
        brick,
        fitness: brick.fitness !== undefined ? computeBrickFitness(brick.fitness, nowMs) : 0,
      }))
      .sort((a, b) => b.fitness - a.fitness)
      .slice(0, config.maxVariants);

    // Build executable entries
    const entries: VariantEntry<ToolHandler>[] = [];
    for (const { brick, fitness } of scored) {
      const handler = await createToolExecutor(brick);
      entries.push({
        id: brick.id,
        value: handler,
        fitnessScore: fitness,
      });
      // Map brick name to capability for wrapToolCall lookup
      toolToCapability.set(brick.name, capability);
    }

    pools.set(capability, {
      capability,
      variants: entries,
      config,
    });
  }

  return { pools, toolToCapability };
}
