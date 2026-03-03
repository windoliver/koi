/**
 * Forge session counter — engine-owned mutable counter that prevents
 * child agents from resetting forgesThisSession to bypass budget limits.
 *
 * Provides:
 * - readForgeCount / incrementForgeCount — closures for the governance contributor
 * - provider — ComponentProvider that attaches the FORGE_GOVERNANCE contributor
 *
 * When spawning a child agent, pass the parent's current count as `initialCount`
 * to prevent the child from starting at 0.
 */

import type { Agent, ComponentProvider } from "@koi/core";
import type { ForgeConfig } from "@koi/forge-types";
import {
  createForgeGovernanceContributor,
  FORGE_GOVERNANCE,
} from "./forge-governance-contributor.js";

// ---------------------------------------------------------------------------
// Public instance type
// ---------------------------------------------------------------------------

export interface ForgeSessionCounterInstance {
  /** Current forge count (live). */
  readonly readForgeCount: () => number;
  /** Increment the counter by `delta` (typically 1). */
  readonly incrementForgeCount: (delta: number) => void;
  /** ComponentProvider that attaches the FORGE_GOVERNANCE contributor. */
  readonly provider: ComponentProvider;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ForgeSessionCounterOptions {
  readonly config: ForgeConfig;
  /** Depth reader — typically () => context.depth. */
  readonly readDepth: () => number;
  /** Starting count. Pass the parent's current count to prevent reset-to-0 bypass. */
  readonly initialCount?: number;
}

export function createForgeSessionCounter(
  options: ForgeSessionCounterOptions,
): ForgeSessionCounterInstance {
  const { config, readDepth, initialCount = 0 } = options;

  if (initialCount < 0) {
    throw new Error(
      `createForgeSessionCounter: initialCount must be non-negative, got ${String(initialCount)}`,
    );
  }

  // let justified: mutable counter owned by the engine, not caller-controlled
  let count = initialCount;

  const readForgeCount = (): number => count;
  const incrementForgeCount = (delta: number): void => {
    count += delta;
  };

  const contributor = createForgeGovernanceContributor(config, readDepth, readForgeCount);

  const provider: ComponentProvider = {
    name: "forge-session-counter",
    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const key: string = FORGE_GOVERNANCE;
      return new Map([[key, contributor]]);
    },
  };

  return { readForgeCount, incrementForgeCount, provider };
}
