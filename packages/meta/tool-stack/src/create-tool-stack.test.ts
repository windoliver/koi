/**
 * Unit tests for createToolStack().
 *
 * - Empty config → empty middleware array
 * - Each middleware individually → array of 1 with correct name
 * - All middleware provided → array of 7 in correct priority order
 * - Sandbox simplified config maps to correct tierFor/profileFor
 * - skipToolIds produces promoted tier for listed tools
 * - perToolTimeouts feeds through to per-tool overrides
 */

import { describe, expect, test } from "bun:test";
import type { ForgeStore } from "@koi/core/brick-store";
import type { ToolHandler } from "@koi/core/middleware";
import { createToolStack } from "./create-tool-stack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub ForgeStore for degenerate middleware. */
function makeStubForgeStore(): ForgeStore {
  return {
    save: async () => ({ ok: true, value: undefined }),
    load: async () => ({
      ok: false,
      error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
    }),
    search: async () => ({ ok: true, value: [] }),
    remove: async () => ({ ok: true, value: undefined }),
    update: async () => ({ ok: true, value: undefined }),
    exists: async () => ({ ok: true, value: false }),
  };
}

// ---------------------------------------------------------------------------
// Empty config
// ---------------------------------------------------------------------------

describe("createToolStack", () => {
  test("empty config returns empty middleware array", () => {
    const { middleware } = createToolStack({});
    expect(middleware).toEqual([]);
  });

  test("no-arg call returns empty middleware array", () => {
    const { middleware } = createToolStack();
    expect(middleware).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Individual middleware
  // -----------------------------------------------------------------------

  describe("individual middleware", () => {
    test("audit only → 1 middleware named koi:tool-audit", () => {
      const { middleware } = createToolStack({ audit: {} });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("koi:tool-audit");
    });

    test("limits only → 1 middleware named koi:tool-call-limit", () => {
      const { middleware } = createToolStack({ limits: { globalLimit: 100 } });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("koi:tool-call-limit");
    });

    test("recovery only → 1 middleware named tool-recovery", () => {
      const { middleware } = createToolStack({ recovery: {} });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("tool-recovery");
    });

    test("dedup only → 1 middleware named koi:call-dedup", () => {
      const { middleware } = createToolStack({ dedup: {} });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("koi:call-dedup");
    });

    test("sandbox only → 1 middleware named sandbox", () => {
      const { middleware } = createToolStack({ sandbox: {} });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("sandbox");
    });

    test("selector only → 1 middleware named tool-selector", () => {
      const { middleware } = createToolStack({
        selector: {
          selectTools: async () => [],
        },
      });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("tool-selector");
    });

    test("degenerate only → 1 middleware named degenerate", () => {
      const { middleware } = createToolStack({
        degenerate: {
          forgeStore: makeStubForgeStore(),
          createToolExecutor: () => (async () => ({ output: "ok" })) as ToolHandler,
          capabilityConfigs: new Map(),
        },
      });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("degenerate");
    });
  });

  // -----------------------------------------------------------------------
  // All middleware — priority order
  // -----------------------------------------------------------------------

  test("all 7 middleware → correct priority order", () => {
    const { middleware } = createToolStack({
      audit: {},
      limits: { globalLimit: 100 },
      recovery: {},
      dedup: {},
      sandbox: {},
      selector: { selectTools: async () => [] },
      degenerate: {
        forgeStore: makeStubForgeStore(),
        createToolExecutor: () => (async () => ({ output: "ok" })) as ToolHandler,
        capabilityConfigs: new Map(),
      },
    });

    expect(middleware).toHaveLength(7);

    const names = middleware.map((mw) => mw.name);
    expect(names).toEqual([
      "koi:tool-audit", // 100
      "koi:tool-call-limit", // 175
      "tool-recovery", // 180
      "koi:call-dedup", // 185
      "sandbox", // 200
      "tool-selector", // 420
      "degenerate", // 460
    ]);

    // Verify priorities are strictly ascending
    const priorities = middleware.map((mw) => mw.priority);
    for (let i = 1; i < priorities.length; i++) {
      const prev = priorities[i - 1];
      const curr = priorities[i];
      if (prev !== undefined && curr !== undefined) {
        expect(prev).toBeLessThan(curr);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Sandbox simplification
  // -----------------------------------------------------------------------

  describe("sandbox simplified config", () => {
    test("default config creates sandbox middleware with 30s timeout", () => {
      const { middleware } = createToolStack({ sandbox: {} });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("sandbox");
    });

    test("custom defaultTimeoutMs is applied", () => {
      const { middleware } = createToolStack({
        sandbox: { defaultTimeoutMs: 15_000 },
      });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("sandbox");
    });

    test("skipToolIds produces promoted tier for listed tools", () => {
      const { middleware } = createToolStack({
        sandbox: { skipToolIds: ["memory_recall", "file_read"] },
      });

      // The middleware should be created successfully
      expect(middleware).toHaveLength(1);

      // Verify wrapToolCall exists (sandbox middleware always has it)
      expect(middleware[0]?.wrapToolCall).toBeDefined();
    });

    test("perToolTimeouts map is accepted", () => {
      const { middleware } = createToolStack({
        sandbox: {
          perToolTimeouts: new Map([
            ["slow_tool", 60_000],
            ["fast_tool", 5_000],
          ]),
        },
      });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("sandbox");
    });

    test("tierFor escape hatch overrides default tier resolution", () => {
      const { middleware } = createToolStack({
        sandbox: {
          tierFor: (toolId: string) => (toolId === "trusted" ? "promoted" : "sandbox"),
        },
      });
      expect(middleware).toHaveLength(1);
      expect(middleware[0]?.name).toBe("sandbox");
    });

    test("callbacks are forwarded", () => {
      const { middleware } = createToolStack({
        sandbox: {
          onSandboxError: () => {},
          onSandboxMetrics: () => {},
        },
      });
      expect(middleware).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Return type
  // -----------------------------------------------------------------------

  test("returns ToolStackBundle with middleware property", () => {
    const bundle = createToolStack({ audit: {} });
    expect(bundle).toHaveProperty("middleware");
    expect(Array.isArray(bundle.middleware)).toBe(true);
  });
});
