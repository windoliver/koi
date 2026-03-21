/**
 * Tests for debug instrumentation — ring buffer, timing wrappers, and inventory.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { TurnContext } from "@koi/core";
import {
  createDebugInstrumentation,
  type DebugInstrumentation,
  type DebugInventoryItem,
  type MiddlewareSource,
} from "./compose-instrumentation.js";

const STUB_CTX = { turnIndex: 0 } as TurnContext;

function stubCtx(turnIndex: number): TurnContext {
  return { turnIndex } as TurnContext;
}

describe("createDebugInstrumentation", () => {
  let instrumentation: DebugInstrumentation;

  beforeEach(() => {
    instrumentation = createDebugInstrumentation({ enabled: true });
  });

  describe("ring buffer", () => {
    test("stores and retrieves turn traces", () => {
      const provMap = new Map<string, MiddlewareSource>([["mw-a", "static"]]);
      const phaseMap = new Map<string, string>([["mw-a", "resolve"]]);
      const priorityMap = new Map<string, number>([["mw-a", 500]]);

      const entry = {
        name: "mw-a",
        hook: (_ctx: TurnContext, req: string, next: (r: string) => string): string => next(req),
      };

      const wrapped = instrumentation.wrapEntries(
        [entry],
        "wrapModelCall",
        provMap,
        phaseMap,
        priorityMap,
      );

      // Simulate turns 0, 1, 2
      for (let i = 0; i < 3; i++) {
        const ctx = stubCtx(i);
        const wrappedHook = wrapped[0];
        if (wrappedHook !== undefined) {
          wrappedHook.hook(ctx, "req", (r) => r);
        }
        instrumentation.onTurnEnd(i);
      }

      const trace1 = instrumentation.getTrace(1);
      expect(trace1).toBeDefined();
      expect(trace1?.turnIndex).toBe(1);
      expect(trace1?.spans).toHaveLength(1);
      expect(trace1?.spans[0]?.name).toBe("mw-a");
    });

    test("evicts oldest when buffer is full", () => {
      const small = createDebugInstrumentation({ enabled: true, bufferSize: 2 });
      const provMap = new Map<string, MiddlewareSource>([["mw-a", "static"]]);
      const phaseMap = new Map<string, string>([["mw-a", "resolve"]]);
      const priorityMap = new Map<string, number>([["mw-a", 500]]);

      const entry = {
        name: "mw-a",
        hook: (_ctx: TurnContext, req: string, next: (r: string) => string): string => next(req),
      };

      const wrapped = small.wrapEntries([entry], "wrapModelCall", provMap, phaseMap, priorityMap);

      // Push turns 0, 1, 2 into a buffer of size 2
      for (let i = 0; i < 3; i++) {
        const ctx = stubCtx(i);
        const wrappedHook = wrapped[0];
        if (wrappedHook !== undefined) {
          wrappedHook.hook(ctx, "req", (r) => r);
        }
        small.onTurnEnd(i);
      }

      // Turn 0 should be evicted
      expect(small.getTrace(0)).toBeUndefined();
      // Turns 1 and 2 should still exist
      expect(small.getTrace(1)).toBeDefined();
      expect(small.getTrace(2)).toBeDefined();
    });

    test("returns undefined for missing turn", () => {
      expect(instrumentation.getTrace(999)).toBeUndefined();
    });
  });

  describe("timing wrappers", () => {
    test("records duration for async hook", async () => {
      const provMap = new Map<string, MiddlewareSource>([["async-mw", "static"]]);
      const phaseMap = new Map<string, string>([["async-mw", "resolve"]]);
      const priorityMap = new Map<string, number>([["async-mw", 500]]);

      const entry = {
        name: "async-mw",
        hook: async (
          _ctx: TurnContext,
          req: string,
          next: (r: string) => Promise<string>,
        ): Promise<string> => {
          // Simulate ~10ms of work
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          return next(req);
        },
      };

      const wrapped = instrumentation.wrapEntries(
        [entry],
        "wrapModelCall",
        provMap,
        phaseMap,
        priorityMap,
      );

      const wrappedHook = wrapped[0];
      if (wrappedHook !== undefined) {
        await wrappedHook.hook(STUB_CTX, "req", async (r) => r);
      }

      instrumentation.onTurnEnd(0);

      const trace = instrumentation.getTrace(0);
      expect(trace).toBeDefined();
      expect(trace?.spans).toHaveLength(1);
      expect(trace?.spans[0]?.durationMs).toBeGreaterThan(0);
    });

    test("records nextCalled correctly", () => {
      const provMap = new Map<string, MiddlewareSource>([
        ["calls-next", "static"],
        ["skips-next", "static"],
      ]);
      const phaseMap = new Map<string, string>([
        ["calls-next", "resolve"],
        ["skips-next", "resolve"],
      ]);
      const priorityMap = new Map<string, number>([
        ["calls-next", 500],
        ["skips-next", 500],
      ]);

      const callsNextEntry = {
        name: "calls-next",
        hook: (_ctx: TurnContext, req: string, next: (r: string) => string): string => next(req),
      };

      const skipsNextEntry = {
        name: "skips-next",
        hook: (_ctx: TurnContext, _req: string, _next: (r: string) => string): string =>
          "short-circuit",
      };

      const wrapped = instrumentation.wrapEntries(
        [callsNextEntry, skipsNextEntry],
        "wrapModelCall",
        provMap,
        phaseMap,
        priorityMap,
      );

      // Call both wrapped hooks
      const first = wrapped[0];
      const second = wrapped[1];
      if (first !== undefined) {
        first.hook(STUB_CTX, "req", (r) => r);
      }
      if (second !== undefined) {
        second.hook(STUB_CTX, "req", (r) => r);
      }

      instrumentation.onTurnEnd(0);

      const trace = instrumentation.getTrace(0);
      expect(trace).toBeDefined();
      expect(trace?.spans).toHaveLength(2);

      const callsNextSpan = trace?.spans.find((s) => s.name === "calls-next");
      const skipsNextSpan = trace?.spans.find((s) => s.name === "skips-next");
      expect(callsNextSpan?.nextCalled).toBe(true);
      expect(skipsNextSpan?.nextCalled).toBe(false);
    });

    test("records error when hook throws", () => {
      const provMap = new Map<string, MiddlewareSource>([["failing-mw", "static"]]);
      const phaseMap = new Map<string, string>([["failing-mw", "resolve"]]);
      const priorityMap = new Map<string, number>([["failing-mw", 500]]);

      const entry = {
        name: "failing-mw",
        hook: (_ctx: TurnContext, _req: string, _next: (r: string) => string): string => {
          throw new Error("hook exploded");
        },
      };

      const wrapped = instrumentation.wrapEntries(
        [entry],
        "wrapModelCall",
        provMap,
        phaseMap,
        priorityMap,
      );

      const wrappedHook = wrapped[0];
      if (wrappedHook !== undefined) {
        try {
          wrappedHook.hook(STUB_CTX, "req", (r) => r);
        } catch {
          // expected
        }
      }

      instrumentation.onTurnEnd(0);

      const trace = instrumentation.getTrace(0);
      expect(trace).toBeDefined();
      expect(trace?.spans).toHaveLength(1);
      expect(trace?.spans[0]?.error).toBe("hook exploded");
    });

    test("records error when async hook rejects", async () => {
      const provMap = new Map<string, MiddlewareSource>([["async-fail", "static"]]);
      const phaseMap = new Map<string, string>([["async-fail", "resolve"]]);
      const priorityMap = new Map<string, number>([["async-fail", 500]]);

      const entry = {
        name: "async-fail",
        hook: async (
          _ctx: TurnContext,
          _req: string,
          _next: (r: string) => Promise<string>,
        ): Promise<string> => {
          throw new Error("async boom");
        },
      };

      const wrapped = instrumentation.wrapEntries(
        [entry],
        "wrapModelCall",
        provMap,
        phaseMap,
        priorityMap,
      );

      const wrappedHook = wrapped[0];
      if (wrappedHook !== undefined) {
        try {
          await wrappedHook.hook(STUB_CTX, "req", async (r) => r);
        } catch {
          // expected
        }
      }

      instrumentation.onTurnEnd(0);

      const trace = instrumentation.getTrace(0);
      expect(trace).toBeDefined();
      expect(trace?.spans[0]?.error).toBe("async boom");
    });
  });

  describe("buildInventory", () => {
    test("builds inventory from middleware + extra items", () => {
      const provMap = new Map<string, MiddlewareSource>([
        ["mw-a", "static"],
        ["mw-b", "forged"],
      ]);
      const phaseMap = new Map<string, string>();
      const priorityMap = new Map<string, number>();

      const entry = {
        name: "mw-a",
        hook: (_ctx: TurnContext, req: string, next: (r: string) => string): string => next(req),
      };

      // wrapEntries populates the provenanceMap
      instrumentation.wrapEntries([entry], "wrapModelCall", provMap, phaseMap, priorityMap);

      const extraItems: readonly DebugInventoryItem[] = [
        {
          name: "my-tool",
          category: "tool",
          enabled: true,
          source: "operator",
        },
        {
          name: "my-skill",
          category: "skill",
          enabled: true,
          source: "manifest",
        },
      ];

      const inventory = instrumentation.buildInventory("agent-1", extraItems);

      expect(inventory.agentId).toBe("agent-1");
      expect(inventory.timestamp).toBeGreaterThan(0);

      // Should contain middleware from provenance map + extra items
      const mwItems = inventory.items.filter((i) => i.category === "middleware");
      const toolItems = inventory.items.filter((i) => i.category === "tool");
      const skillItems = inventory.items.filter((i) => i.category === "skill");

      expect(mwItems.length).toBeGreaterThanOrEqual(1);
      expect(toolItems).toHaveLength(1);
      expect(toolItems[0]?.name).toBe("my-tool");
      expect(skillItems).toHaveLength(1);
      expect(skillItems[0]?.name).toBe("my-skill");
    });
  });

  describe("disabled instrumentation", () => {
    test("wrapEntries still returns entries when enabled is true", () => {
      const provMap = new Map<string, MiddlewareSource>([["mw-a", "static"]]);
      const phaseMap = new Map<string, string>();
      const priorityMap = new Map<string, number>();

      const entry = {
        name: "mw-a",
        hook: (_ctx: TurnContext, req: string, next: (r: string) => string): string => next(req),
      };

      const wrapped = instrumentation.wrapEntries(
        [entry],
        "wrapModelCall",
        provMap,
        phaseMap,
        priorityMap,
      );

      expect(wrapped).toHaveLength(1);
      expect(wrapped[0]?.name).toBe("mw-a");
    });
  });
});
