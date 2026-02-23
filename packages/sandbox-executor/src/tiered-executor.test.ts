import { describe, expect, test } from "bun:test";
import type { SandboxExecutor, TierResolution, TrustTier } from "@koi/core";
import { buildExecutorFromMap, createTieredExecutor } from "./tiered-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExecutor(label: string): SandboxExecutor {
  return {
    execute: async (_code, _input, _timeout) => ({
      ok: true as const,
      value: { output: label, durationMs: 1 },
    }),
  };
}

// ---------------------------------------------------------------------------
// Routing tests
// ---------------------------------------------------------------------------

describe("createTieredExecutor — routing", () => {
  test("routes sandbox tier to sandbox backend", () => {
    const result = createTieredExecutor({
      sandbox: mockExecutor("sandbox"),
      verified: mockExecutor("verified"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolution = result.value.forTier("sandbox");
    expect(resolution.resolvedTier).toBe("sandbox");
    expect(resolution.fallback).toBe(false);
  });

  test("routes verified tier to verified backend", () => {
    const result = createTieredExecutor({
      verified: mockExecutor("verified"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolution = result.value.forTier("verified");
    expect(resolution.resolvedTier).toBe("verified");
    expect(resolution.fallback).toBe(false);
  });

  test("routes promoted tier to built-in executor by default", () => {
    const result = createTieredExecutor({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolution = result.value.forTier("promoted");
    expect(resolution.resolvedTier).toBe("promoted");
    expect(resolution.fallback).toBe(false);
  });

  test("routes promoted tier to custom override", () => {
    const result = createTieredExecutor({
      promoted: mockExecutor("custom-promoted"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolution = result.value.forTier("promoted");
    expect(resolution.resolvedTier).toBe("promoted");
    expect(resolution.fallback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fallback tests (table-driven)
// ---------------------------------------------------------------------------

describe("createTieredExecutor — fallback", () => {
  const fallbackCases: ReadonlyArray<{
    readonly name: string;
    readonly config: {
      readonly sandbox?: SandboxExecutor;
      readonly verified?: SandboxExecutor;
    };
    readonly requestedTier: "sandbox" | "verified" | "promoted";
    readonly expectedTier: "sandbox" | "verified" | "promoted";
    readonly expectedFallback: boolean;
  }> = [
    {
      name: "sandbox with sandbox configured → no fallback",
      config: { sandbox: mockExecutor("s") },
      requestedTier: "sandbox",
      expectedTier: "sandbox",
      expectedFallback: false,
    },
    {
      name: "sandbox without sandbox, with verified → fallback to verified",
      config: { verified: mockExecutor("v") },
      requestedTier: "sandbox",
      expectedTier: "verified",
      expectedFallback: true,
    },
    {
      name: "sandbox without sandbox or verified → fallback to promoted (built-in)",
      config: {},
      requestedTier: "sandbox",
      expectedTier: "promoted",
      expectedFallback: true,
    },
    {
      name: "verified with verified configured → no fallback",
      config: { verified: mockExecutor("v") },
      requestedTier: "verified",
      expectedTier: "verified",
      expectedFallback: false,
    },
    {
      name: "verified without verified → fallback to promoted (built-in)",
      config: {},
      requestedTier: "verified",
      expectedTier: "promoted",
      expectedFallback: true,
    },
    {
      name: "promoted always resolves → built-in",
      config: {},
      requestedTier: "promoted",
      expectedTier: "promoted",
      expectedFallback: false,
    },
  ];

  for (const tc of fallbackCases) {
    test(tc.name, () => {
      const result = createTieredExecutor(tc.config);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const resolution = result.value.forTier(tc.requestedTier);
      expect(resolution.resolvedTier).toBe(tc.expectedTier);
      expect(resolution.fallback).toBe(tc.expectedFallback);
      expect(resolution.requestedTier).toBe(tc.requestedTier);
    });
  }
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("createTieredExecutor — validation", () => {
  test("empty config is valid (promoted is built-in)", () => {
    const result = createTieredExecutor({});
    expect(result.ok).toBe(true);
  });

  test("config with all tiers resolves all", () => {
    const result = createTieredExecutor({
      sandbox: mockExecutor("s"),
      verified: mockExecutor("v"),
      promoted: mockExecutor("p"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const s = result.value.forTier("sandbox");
    const v = result.value.forTier("verified");
    const p = result.value.forTier("promoted");

    expect(s.resolvedTier).toBe("sandbox");
    expect(v.resolvedTier).toBe("verified");
    expect(p.resolvedTier).toBe("promoted");
    expect(s.fallback).toBe(false);
    expect(v.fallback).toBe(false);
    expect(p.fallback).toBe(false);
  });

  test("config with only sandbox → sandbox OK, verified/promoted fall through", () => {
    const result = createTieredExecutor({
      sandbox: mockExecutor("s"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const s = result.value.forTier("sandbox");
    expect(s.resolvedTier).toBe("sandbox");
    expect(s.fallback).toBe(false);

    // verified has no configured backend, falls to promoted (built-in)
    const v = result.value.forTier("verified");
    expect(v.resolvedTier).toBe("promoted");
    expect(v.fallback).toBe(true);

    // promoted always resolves to built-in
    const p = result.value.forTier("promoted");
    expect(p.resolvedTier).toBe("promoted");
    expect(p.fallback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

describe("buildExecutorFromMap — error handling", () => {
  test("returns validation error for empty resolution map", () => {
    const emptyMap = new Map<TrustTier, TierResolution>();
    const result = buildExecutorFromMap(emptyMap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("no tiers could be resolved");
    }
  });

  test("forTier throws for tier not in resolution map", () => {
    // Build a map with only promoted — sandbox and verified are missing
    const partialMap = new Map<TrustTier, TierResolution>();
    partialMap.set("promoted", {
      executor: mockExecutor("p"),
      requestedTier: "promoted",
      resolvedTier: "promoted",
      fallback: false,
    });

    const result = buildExecutorFromMap(partialMap);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // promoted resolves fine
    expect(() => result.value.forTier("promoted")).not.toThrow();

    // sandbox is not in the map — throws
    expect(() => result.value.forTier("sandbox")).toThrow(
      /no executor available for tier "sandbox"/,
    );

    // verified is not in the map — throws
    expect(() => result.value.forTier("verified")).toThrow(
      /no executor available for tier "verified"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Contract smoke tests
// ---------------------------------------------------------------------------

describe("createTieredExecutor — contract", () => {
  test("forTier returns TierResolution with all required fields", () => {
    const result = createTieredExecutor({
      sandbox: mockExecutor("s"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolution: TierResolution = result.value.forTier("sandbox");
    expect(resolution.executor).toBeDefined();
    expect(typeof resolution.executor.execute).toBe("function");
    expect(resolution.requestedTier).toBe("sandbox");
    expect(resolution.resolvedTier).toBe("sandbox");
    expect(typeof resolution.fallback).toBe("boolean");
  });

  test("returned executor is callable and returns Result", async () => {
    const result = createTieredExecutor({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolution = result.value.forTier("promoted");
    const execResult = await resolution.executor.execute("return 42;", {}, 5_000);
    expect(execResult.ok).toBe(true);
    if (execResult.ok) {
      expect(execResult.value.output).toBe(42);
    }
  });
});
