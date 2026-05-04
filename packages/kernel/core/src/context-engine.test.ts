/**
 * Unit tests for L0 context-engine slot contract (issue #1767).
 */

import { describe, expect, test } from "bun:test";
import type {
  ContextEngine,
  ContextEngineIdentity,
  ContextEngineSwapEvent,
  ContextOccupancy,
} from "./context-engine.js";
import { CONTEXT_ENGINE } from "./context-engine.js";
import type { SubsystemToken } from "./ecs.js";
import type { InboundMessage } from "./message.js";
import type { TurnContext } from "./middleware.js";

describe("CONTEXT_ENGINE token", () => {
  test("is branded as SubsystemToken<ContextEngine>", () => {
    const t: SubsystemToken<ContextEngine> = CONTEXT_ENGINE;
    expect(typeof t).toBe("string");
    // Compare via String() to peel the brand for equality assertion.
    expect(String(t)).toBe("context-engine");
  });
});

describe("ContextEngineIdentity", () => {
  test("requires name and version", () => {
    const id: ContextEngineIdentity = {
      name: "@koi/context-manager",
      version: "1.0.0",
    };
    expect(id.name).toBe("@koi/context-manager");
    expect(id.version).toBe("1.0.0");
  });
});

describe("ContextOccupancy", () => {
  test("models pressure derived from estimated/max", () => {
    const occ: ContextOccupancy = {
      estimatedTokens: 50_000,
      maxTokens: 100_000,
      pressure: 0.5,
    };
    expect(occ.pressure).toBeGreaterThanOrEqual(0);
    expect(occ.pressure).toBeLessThanOrEqual(1);
    expect(occ.estimatedTokens).toBeLessThanOrEqual(occ.maxTokens);
  });

  test("permits saturated pressure (1.0) at or above budget", () => {
    const saturated: ContextOccupancy = {
      estimatedTokens: 200_000,
      maxTokens: 100_000,
      pressure: 1,
    };
    expect(saturated.pressure).toBe(1);
  });
});

describe("ContextEngine", () => {
  test("is constructible with only required fields", () => {
    const engine: ContextEngine = {
      identity: { name: "test", version: "0.0.1" },
      prepare: (_ctx, msgs) => msgs,
    };
    expect(engine.identity.name).toBe("test");
    expect(engine.onAfterTurn).toBeUndefined();
    expect(engine.describeOccupancy).toBeUndefined();
  });

  test("prepare may return sync or Promise<readonly InboundMessage[]>", async () => {
    const sync: ContextEngine = {
      identity: { name: "sync", version: "0.0.1" },
      prepare: (_ctx, msgs) => msgs,
    };
    const async_: ContextEngine = {
      identity: { name: "async", version: "0.0.1" },
      prepare: async (_ctx, msgs) => msgs,
    };
    const ctx = {} as TurnContext;
    const msgs: readonly InboundMessage[] = [];
    expect(sync.prepare(ctx, msgs)).toBe(msgs);
    expect(await async_.prepare(ctx, msgs)).toBe(msgs);
  });

  test("describeOccupancy is invoked without arguments", async () => {
    const engine: ContextEngine = {
      identity: { name: "occ", version: "0.0.1" },
      prepare: (_ctx, msgs) => msgs,
      describeOccupancy: () => ({ estimatedTokens: 1, maxTokens: 100, pressure: 0.01 }),
    };
    const occ = await engine.describeOccupancy?.();
    expect(occ?.pressure).toBe(0.01);
  });
});

describe("ContextEngineSwapEvent", () => {
  test("carries from/to identities, reason, and ISO timestamp", () => {
    const evt: ContextEngineSwapEvent = {
      kind: "context-engine-swap",
      turnId: "run-1:t3" as ContextEngineSwapEvent["turnId"],
      from: { name: "@koi/context-manager", version: "1.0.0" },
      to: { name: "@koi/context-engine-passthrough", version: "0.1.0" },
      reason: "operator forced full-context for debugging",
      timestamp: "2026-05-02T12:00:00.000Z",
    };
    expect(evt.kind).toBe("context-engine-swap");
    expect(evt.from.name).not.toBe(evt.to.name);
    expect(() => new Date(evt.timestamp).toISOString()).not.toThrow();
  });

  test("rollbackTarget is optional", () => {
    const withRollback: ContextEngineSwapEvent = {
      kind: "context-engine-swap",
      turnId: "run-1:t3" as ContextEngineSwapEvent["turnId"],
      from: { name: "a", version: "1.0.0" },
      to: { name: "b", version: "1.0.0" },
      reason: "experiment",
      rollbackTarget: { name: "a", version: "1.0.0" },
      timestamp: "2026-05-02T12:00:00.000Z",
    };
    expect(withRollback.rollbackTarget?.name).toBe("a");
  });
});
