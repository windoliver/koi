/**
 * Context-engine ComponentProvider — wires a `ContextEngine` instance onto the
 * agent's CONTEXT_ENGINE singleton subsystem token.
 *
 * Phase 3 of issue #1767. Generic over the engine instance — implementations
 * (default `@koi/context-manager`, future `@koi/context-engine-passthrough`)
 * are passed in by the caller.
 */

import type { Agent, ComponentProvider, ContextEngine } from "@koi/core";
import { COMPONENT_PRIORITY, CONTEXT_ENGINE } from "@koi/core";

export interface ContextEngineProviderOptions {
  /** Override assembly priority. Defaults to BUNDLED so user providers win. */
  readonly priority?: number;
}

/**
 * Build a ComponentProvider that attaches `engine` under the `CONTEXT_ENGINE`
 * singleton token. Multiple providers may attach to the same token —
 * lowest-priority wins per ECS first-write rules.
 */
export function createContextEngineProvider(
  engine: ContextEngine,
  options: ContextEngineProviderOptions = {},
): ComponentProvider {
  const priority = options.priority ?? COMPONENT_PRIORITY.BUNDLED;
  return {
    name: "context-engine",
    priority,
    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      return new Map<string, unknown>([[CONTEXT_ENGINE as string, engine]]);
    },
  };
}
