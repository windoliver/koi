/**
 * Context-engine ComponentProvider — wires a `ContextEngine` instance onto the
 * agent's CONTEXT_ENGINE singleton subsystem token.
 *
 * Phase 3 of issue #1767. Generic over the engine instance — implementations
 * (default `@koi/context-manager`, future `@koi/context-engine-passthrough`)
 * are passed in by the caller.
 */

import type {
  Agent,
  ComponentProvider,
  ContextEngine,
  InboundMessage,
  TurnContext,
} from "@koi/core";
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

/**
 * Build a ComponentProvider that attaches a stable proxy under
 * `CONTEXT_ENGINE`. The proxy delegates every method to whichever engine
 * `getEngine()` currently returns, so post-swap reads of
 * `agent.component(CONTEXT_ENGINE)` always reflect the active engine instead
 * of the boot-time instance frozen by AgentEntity assembly.
 *
 * Used internally by `createKoi` when a `contextEngineFactory` is supplied;
 * external callers attaching their own engine should use
 * `createContextEngineProvider` and manage swapping themselves.
 */
export function createContextEngineProxyProvider(
  getEngine: () => ContextEngine,
  options: ContextEngineProviderOptions = {},
): ComponentProvider {
  const priority = options.priority ?? COMPONENT_PRIORITY.BUNDLED;
  // describeOccupancy is intentionally omitted: it is optional in the
  // contract, the underlying engine may flip between providing/omitting it
  // across swaps, and callers wanting authoritative occupancy should resolve
  // it through the swap controller (`controller.current().describeOccupancy`).
  const proxy: ContextEngine = {
    get identity() {
      return getEngine().identity;
    },
    prepare: (
      ctx: TurnContext,
      messages: readonly InboundMessage[],
    ): readonly InboundMessage[] | Promise<readonly InboundMessage[]> =>
      getEngine().prepare(ctx, messages),
    onAfterTurn: (ctx: TurnContext): void | Promise<void> => {
      const e = getEngine();
      return e.onAfterTurn?.(ctx);
    },
  };
  return {
    name: "context-engine",
    priority,
    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      return new Map<string, unknown>([[CONTEXT_ENGINE as string, proxy]]);
    },
  };
}
