/**
 * Minimal ComponentProvider factory for single-tool providers.
 *
 * Eliminates copy-paste between TaskSpawnProvider, ParallelMinionsProvider,
 * and similar providers that attach exactly one tool with lazy caching.
 *
 * Exception: permitted in L0 as a pure function operating only on L0 types.
 */

import type { Agent, ComponentProvider, Tool } from "./ecs.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SingleToolProviderConfig {
  /** Provider name (e.g., "task-spawn", "parallel-minions"). */
  readonly name: string;

  /** Tool name without the "tool:" prefix (e.g., "task", "parallel_task"). */
  readonly toolName: string;

  /** Factory function that creates the Tool instance. Called once (cached). */
  readonly createTool: () => Tool;

  /** Assembly priority. Lower = higher precedence. */
  readonly priority?: number | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ComponentProvider that attaches a single `tool:<toolName>` component.
 * The tool is created once on first attach and cached for subsequent calls.
 */
export function createSingleToolProvider(config: SingleToolProviderConfig): ComponentProvider {
  const { name, toolName, createTool, priority } = config;

  // let justified: mutable cache (set once on first attach)
  let cached: ReadonlyMap<string, unknown> | undefined;

  return {
    name,
    ...(priority !== undefined ? { priority } : {}),

    async attach(_agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      if (cached !== undefined) return cached;

      const tool = createTool();
      cached = new Map<string, unknown>([[`tool:${toolName}`, tool]]);
      return cached;
    },
  };
}
