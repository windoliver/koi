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
export interface ContextEngineProxyProvider {
  readonly provider: ComponentProvider;
  /**
   * The proxy instance the provider attaches under `CONTEXT_ENGINE`. Exposed
   * so `createKoi` can compare it against the post-assembly slot occupant
   * and reject silent collisions (an external provider with lower priority
   * shadowing the controller-backed proxy).
   */
  readonly proxy: ContextEngine;
}

export function createContextEngineProxyProvider(
  getEngine: () => ContextEngine,
  options: ContextEngineProviderOptions = {},
): ContextEngineProxyProvider {
  const priority = options.priority ?? COMPONENT_PRIORITY.BUNDLED;
  // The proxy forwards every method the underlying engine implements,
  // including the optional `describeOccupancy` — slot consumers reading
  // through `agent.component(CONTEXT_ENGINE)` must not lose pressure
  // visibility just because `createKoi` owns the slot. `describeOccupancy`
  // checks the live engine on each call so engines that flip between
  // providing/omitting it across swaps stay accurate.
  // Base proxy exposes always-present methods. `describeOccupancy` is the
  // only optional method on the contract; we expose it through a Proxy `has`
  // trap so `'describeOccupancy' in engine` reflects the current engine and
  // so `engine.describeOccupancy?.()` correctly observes absence under
  // exactOptionalPropertyTypes (no `describeOccupancy: undefined` property).
  const baseProxy: Omit<ContextEngine, "describeOccupancy"> = {
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
  const proxy = new Proxy(baseProxy, {
    has(target, prop): boolean {
      if (prop === "describeOccupancy") return getEngine().describeOccupancy !== undefined;
      return prop in target;
    },
    get(target, prop, receiver): unknown {
      if (prop === "describeOccupancy") {
        // Snapshot the engine ONCE so a swap landing between method
        // resolution and `this`-binding cannot return engine A's method
        // bound to engine B. Custom engines are allowed to implement
        // describeOccupancy as a `this`-using instance method.
        const engine = getEngine();
        const fn = engine.describeOccupancy;
        return fn === undefined ? undefined : fn.bind(engine);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as ContextEngine;
  const provider: ComponentProvider = {
    name: "context-engine",
    priority,
    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      return new Map<string, unknown>([[CONTEXT_ENGINE as string, proxy]]);
    },
  };
  return { provider, proxy };
}
