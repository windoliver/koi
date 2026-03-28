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
      // Top-level: one parent span per hook group ("wrapModelCall")
      expect(trace1?.spans).toHaveLength(1);
      expect(trace1?.spans[0]?.name).toBe("wrapModelCall");
      // Children contain the actual middleware spans
      expect(trace1?.spans[0]?.children).toHaveLength(1);
      expect(trace1?.spans[0]?.children?.[0]?.name).toBe("mw-a");
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
      // Top-level: one parent span for "wrapModelCall" group
      expect(trace?.spans).toHaveLength(1);
      // Children contain the individual middleware spans
      const children = trace?.spans[0]?.children ?? [];
      expect(children).toHaveLength(2);

      const callsNextSpan = children.find((s) => s.name === "calls-next");
      const skipsNextSpan = children.find((s) => s.name === "skips-next");
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
      // Top-level: one parent span for "wrapModelCall" group
      expect(trace?.spans).toHaveLength(1);
      // Error is on the child middleware span
      expect(trace?.spans[0]?.children).toHaveLength(1);
      expect(trace?.spans[0]?.children?.[0]?.error).toBe("hook exploded");
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
      // Error is on the child middleware span inside the group
      expect(trace?.spans[0]?.children?.[0]?.error).toBe("async boom");
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

  describe("recordToolChildSpans", () => {
    test("attaches child spans to wrapToolCall group", () => {
      const provMap = new Map<string, MiddlewareSource>([["sandbox", "static"]]);
      const phaseMap = new Map<string, string>([["sandbox", "intercept"]]);
      const priorityMap = new Map<string, number>([["sandbox", 100]]);

      const entry = {
        name: "sandbox",
        hook: (_ctx: TurnContext, req: string, next: (r: string) => string): string => next(req),
      };

      const wrapped = instrumentation.wrapEntries(
        [entry],
        "wrapToolCall",
        provMap,
        phaseMap,
        priorityMap,
      );

      const ctx = stubCtx(0);
      const wrappedHook = wrapped[0];
      if (wrappedHook !== undefined) {
        wrappedHook.hook(ctx, "req", (r) => r);
      }

      // Record child spans from tool execution
      instrumentation.recordToolChildSpans({
        turnIndex: 0,
        toolId: "exec",
        children: [
          { label: "tool-exec:validate", durationMs: 0.5 },
          { label: "sandbox-wasm", durationMs: 12.3 },
        ],
      });

      instrumentation.onTurnEnd(0);

      const trace = instrumentation.getTrace(0);
      expect(trace).toBeDefined();
      expect(trace?.spans).toHaveLength(1);

      const toolCallGroup = trace?.spans[0];
      expect(toolCallGroup?.name).toBe("wrapToolCall");

      // Should have middleware span + tool exec span
      const children = toolCallGroup?.children ?? [];
      expect(children).toHaveLength(2); // sandbox mw + exec tool child
      expect(children[0]?.name).toBe("sandbox");

      const execSpan = children[1];
      expect(execSpan?.name).toBe("exec");
      expect(execSpan?.hook).toBe("toolExec");
      expect(execSpan?.children).toHaveLength(2);
      expect(execSpan?.children?.[0]?.label ?? execSpan?.children?.[0]?.name).toBe(
        "tool-exec:validate",
      );
      expect(execSpan?.children?.[1]?.label ?? execSpan?.children?.[1]?.name).toBe("sandbox-wasm");
    });

    test("handles tool child spans with errors", () => {
      // No middleware for this test — just child spans
      instrumentation.recordToolChildSpans({
        turnIndex: 0,
        toolId: "exec",
        children: [{ label: "sandbox-wasm", durationMs: 5.0, error: "TIMEOUT" }],
      });

      // Need at least one wrapToolCall span for the group to exist
      const provMap = new Map<string, MiddlewareSource>([["mw", "static"]]);
      const phaseMap = new Map<string, string>();
      const priorityMap = new Map<string, number>();
      const entry = {
        name: "mw",
        hook: (_ctx: TurnContext, req: string, next: (r: string) => string): string => next(req),
      };
      const wrapped = instrumentation.wrapEntries(
        [entry],
        "wrapToolCall",
        provMap,
        phaseMap,
        priorityMap,
      );
      wrapped[0]?.hook(stubCtx(0), "req", (r) => r);

      instrumentation.onTurnEnd(0);

      const trace = instrumentation.getTrace(0);
      const toolCallGroup = trace?.spans[0];
      const execSpan = toolCallGroup?.children?.find((c) => c.name === "exec");
      expect(execSpan?.children?.[0]?.error).toBe("TIMEOUT");
    });

    test("ignores child spans when no wrapToolCall group exists", () => {
      // Record child spans without any middleware executing
      instrumentation.recordToolChildSpans({
        turnIndex: 0,
        toolId: "exec",
        children: [{ label: "sandbox-wasm", durationMs: 10 }],
      });

      // Only a model call, not a tool call
      const provMap = new Map<string, MiddlewareSource>([["mw", "static"]]);
      const phaseMap = new Map<string, string>();
      const priorityMap = new Map<string, number>();
      const entry = {
        name: "mw",
        hook: (_ctx: TurnContext, req: string, next: (r: string) => string): string => next(req),
      };
      const wrapped = instrumentation.wrapEntries(
        [entry],
        "wrapModelCall",
        provMap,
        phaseMap,
        priorityMap,
      );
      wrapped[0]?.hook(stubCtx(0), "req", (r) => r);

      instrumentation.onTurnEnd(0);

      const trace = instrumentation.getTrace(0);
      // Only the model call group, no tool exec children injected
      expect(trace?.spans).toHaveLength(1);
      expect(trace?.spans[0]?.name).toBe("wrapModelCall");
      expect(trace?.spans[0]?.children).toHaveLength(1);
      expect(trace?.spans[0]?.children?.[0]?.name).toBe("mw");
    });

    test("handles multiple tool calls in same turn", () => {
      const provMap = new Map<string, MiddlewareSource>([["mw", "static"]]);
      const phaseMap = new Map<string, string>();
      const priorityMap = new Map<string, number>();
      const entry = {
        name: "mw",
        hook: (_ctx: TurnContext, req: string, next: (r: string) => string): string => next(req),
      };
      const wrapped = instrumentation.wrapEntries(
        [entry],
        "wrapToolCall",
        provMap,
        phaseMap,
        priorityMap,
      );
      // Two tool calls in the same turn
      wrapped[0]?.hook(stubCtx(0), "req1", (r) => r);
      wrapped[0]?.hook(stubCtx(0), "req2", (r) => r);

      instrumentation.recordToolChildSpans({
        turnIndex: 0,
        toolId: "exec",
        children: [{ label: "sandbox-wasm", durationMs: 10 }],
      });
      instrumentation.recordToolChildSpans({
        turnIndex: 0,
        toolId: "browser",
        children: [{ label: "puppeteer", durationMs: 200 }],
      });

      instrumentation.onTurnEnd(0);

      const trace = instrumentation.getTrace(0);
      const toolCallGroup = trace?.spans[0];
      // 2 middleware spans + 2 tool exec spans
      expect(toolCallGroup?.children).toHaveLength(4);
      const execSpan = toolCallGroup?.children?.find((c) => c.name === "exec");
      const browserSpan = toolCallGroup?.children?.find((c) => c.name === "browser");
      expect(execSpan?.children?.[0]?.name).toBe("sandbox-wasm");
      expect(browserSpan?.children?.[0]?.name).toBe("puppeteer");
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
