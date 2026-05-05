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
  ContextOccupancy,
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
  getEngine: (turnId?: import("@koi/core").TurnId) => ContextEngine,
  options: ContextEngineProviderOptions & {
    /**
     * Optional accessor for the full set of engines currently pinned to
     * in-flight turns (typically `controller.pinnedEngines()`). When
     * supplied, `describeOccupancy` aggregates across `active` + every
     * pinned engine and reports the PEAK pressure observed, so a
     * mid-turn swap cannot make the slot's occupancy view drop to the
     * post-swap engine while older turns are still carrying real load.
     * When omitted, occupancy reads only the engine `getEngine()`
     * returns.
     */
    readonly getPinnedEngines?: () => readonly ContextEngine[];
  } = {},
): ContextEngineProxyProvider {
  const getPinnedEngines = options.getPinnedEngines;
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
    // Resolve through the caller's ctx.turnId so prepare()/onAfterTurn()
    // hit the engine pinned for THIS turn — not the most-recently-pinned
    // engine globally, which under overlapping turns would route an
    // earlier in-flight turn onto a later turn's pinned engine.
    prepare: (
      ctx: TurnContext,
      messages: readonly InboundMessage[],
    ): readonly InboundMessage[] | Promise<readonly InboundMessage[]> =>
      getEngine(ctx.turnId).prepare(ctx, messages),
    onAfterTurn: (ctx: TurnContext): void | Promise<void> => {
      const e = getEngine(ctx.turnId);
      return e.onAfterTurn?.(ctx);
    },
  };
  // Build the dedup'd set of engines whose occupancy contributes to the
  // slot view: `active` plus every pinned engine. Without this, a
  // mid-turn swap would let occupancy follow the post-swap engine
  // (often empty) while older turns are still carrying real load on
  // the pre-swap engine.
  const occupancyEngines = (): readonly ContextEngine[] => {
    const active = getEngine();
    const pinned = getPinnedEngines?.() ?? [];
    if (pinned.length === 0) return [active];
    const seen = new Set<ContextEngine>([active]);
    const out: ContextEngine[] = [active];
    for (const e of pinned) {
      if (!seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }
    return out;
  };
  const anyOccupancyAvailable = (): boolean => {
    for (const e of occupancyEngines()) {
      if (e.describeOccupancy !== undefined) return true;
    }
    return false;
  };
  const pickPeak = (
    peak: ContextOccupancy | undefined,
    occ: ContextOccupancy,
  ): ContextOccupancy => {
    if (
      peak === undefined ||
      occ.pressure > peak.pressure ||
      (occ.pressure === peak.pressure && occ.estimatedTokens > peak.estimatedTokens)
    ) {
      return occ;
    }
    return peak;
  };
  // Returns sync when every contributing engine returns sync, otherwise
  // a Promise. Engines may declare describeOccupancy as either form per
  // the L0 contract (`ContextOccupancy | Promise<ContextOccupancy>`),
  // so the proxy must preserve the synchronous shape when it can —
  // forcing an unconditional Promise would break sync consumers.
  const aggregateOccupancy = (): ContextOccupancy | Promise<ContextOccupancy> => {
    const engines = occupancyEngines();
    let peak: ContextOccupancy | undefined;
    const pending: { occ: ContextOccupancy | Promise<ContextOccupancy> }[] = [];
    for (const e of engines) {
      if (e.describeOccupancy === undefined) continue;
      const result = e.describeOccupancy();
      if (result instanceof Promise) {
        pending.push({ occ: result });
      } else {
        peak = pickPeak(peak, result);
      }
    }
    if (pending.length === 0) {
      return peak ?? { estimatedTokens: 0, maxTokens: 0, pressure: 0 };
    }
    return (async (): Promise<ContextOccupancy> => {
      let asyncPeak = peak;
      for (const p of pending) {
        const occ = await p.occ;
        asyncPeak = pickPeak(asyncPeak, occ);
      }
      return asyncPeak ?? { estimatedTokens: 0, maxTokens: 0, pressure: 0 };
    })();
  };

  const proxy = new Proxy(baseProxy, {
    has(target, prop): boolean {
      if (prop === "describeOccupancy") return anyOccupancyAvailable();
      return prop in target;
    },
    get(target, prop, receiver): unknown {
      if (prop === "describeOccupancy") {
        if (!anyOccupancyAvailable()) return undefined;
        return aggregateOccupancy;
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
