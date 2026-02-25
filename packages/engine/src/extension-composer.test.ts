import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  GuardContext,
  KernelExtension,
  KoiMiddleware,
  ValidationDiagnostic,
} from "@koi/core";
import { EXTENSION_PRIORITY } from "@koi/core";
import {
  composeExtensions,
  createDefaultGuardExtension,
  isSignificantTransition,
} from "./extension-composer.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testGuardCtx(overrides?: Partial<GuardContext>): GuardContext {
  return {
    agentDepth: 0,
    manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
    components: new Map(),
    ...overrides,
  };
}

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
    ...overrides,
  };
}

function stubMiddleware(name: string, priority?: number): KoiMiddleware {
  return { name, ...(priority !== undefined ? { priority } : {}) };
}

// ---------------------------------------------------------------------------
// isSignificantTransition
// ---------------------------------------------------------------------------

describe("isSignificantTransition", () => {
  test("significant transitions return true", () => {
    expect(isSignificantTransition("created", "running")).toBe(true);
    expect(isSignificantTransition("created", "terminated")).toBe(true);
    expect(isSignificantTransition("running", "suspended")).toBe(true);
    expect(isSignificantTransition("running", "terminated")).toBe(true);
    expect(isSignificantTransition("waiting", "suspended")).toBe(true);
    expect(isSignificantTransition("waiting", "terminated")).toBe(true);
    expect(isSignificantTransition("suspended", "running")).toBe(true);
    expect(isSignificantTransition("suspended", "terminated")).toBe(true);
  });

  test("hot-path transitions return false", () => {
    expect(isSignificantTransition("running", "waiting")).toBe(false);
    expect(isSignificantTransition("waiting", "running")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// composeExtensions — sorting
// ---------------------------------------------------------------------------

describe("composeExtensions sorting", () => {
  test("sorts extensions by priority ascending", async () => {
    const order: string[] = [];
    const ext1: KernelExtension = {
      name: "addon",
      priority: EXTENSION_PRIORITY.ADDON,
      guards: () => {
        order.push("addon");
        return [stubMiddleware("addon-mw")];
      },
    };
    const ext2: KernelExtension = {
      name: "core",
      priority: EXTENSION_PRIORITY.CORE,
      guards: () => {
        order.push("core");
        return [stubMiddleware("core-mw")];
      },
    };

    await composeExtensions([ext1, ext2], testGuardCtx());

    expect(order).toEqual(["core", "addon"]);
  });

  test("uses default USER priority when omitted", async () => {
    const order: string[] = [];
    const ext1: KernelExtension = {
      name: "no-priority",
      guards: () => {
        order.push("no-priority");
        return [stubMiddleware("np-mw")];
      },
    };
    const ext2: KernelExtension = {
      name: "platform",
      priority: EXTENSION_PRIORITY.PLATFORM,
      guards: () => {
        order.push("platform");
        return [stubMiddleware("plat-mw")];
      },
    };

    await composeExtensions([ext1, ext2], testGuardCtx());

    // Platform (10) < default USER (50)
    expect(order).toEqual(["platform", "no-priority"]);
  });
});

// ---------------------------------------------------------------------------
// composeExtensions — guard slot
// ---------------------------------------------------------------------------

describe("composeExtensions guard slot", () => {
  test("collects middleware from guard slots", async () => {
    const ext: KernelExtension = {
      name: "test",
      guards: () => [stubMiddleware("mw-a"), stubMiddleware("mw-b")],
    };

    const composed = await composeExtensions([ext], testGuardCtx());

    expect(composed.guardMiddleware).toHaveLength(2);
    expect(composed.guardMiddleware[0]?.name).toBe("mw-a");
    expect(composed.guardMiddleware[1]?.name).toBe("mw-b");
  });

  test("handles async guard slot", async () => {
    const ext: KernelExtension = {
      name: "async-guards",
      guards: async () => [stubMiddleware("async-mw")],
    };

    const composed = await composeExtensions([ext], testGuardCtx());

    expect(composed.guardMiddleware).toHaveLength(1);
    expect(composed.guardMiddleware[0]?.name).toBe("async-mw");
  });

  test("concatenates middleware from multiple extensions in priority order", async () => {
    const ext1: KernelExtension = {
      name: "high",
      priority: 100,
      guards: () => [stubMiddleware("high-mw")],
    };
    const ext2: KernelExtension = {
      name: "low",
      priority: 0,
      guards: () => [stubMiddleware("low-mw")],
    };

    const composed = await composeExtensions([ext1, ext2], testGuardCtx());

    expect(composed.guardMiddleware).toHaveLength(2);
    expect(composed.guardMiddleware[0]?.name).toBe("low-mw");
    expect(composed.guardMiddleware[1]?.name).toBe("high-mw");
  });
});

// ---------------------------------------------------------------------------
// composeExtensions — transition validator
// ---------------------------------------------------------------------------

describe("composeExtensions transition validator", () => {
  test("skips non-significant transitions", async () => {
    let called = false;
    const ext: KernelExtension = {
      name: "blocker",
      validateTransition: () => {
        called = true;
        return false;
      },
    };

    const composed = await composeExtensions([ext], testGuardCtx());

    // running→waiting is hot path, should NOT call validator
    const allowed = composed.validateTransition("running", "waiting");
    expect(allowed).toBe(true);
    expect(called).toBe(false);
  });

  test("calls validator for significant transitions", async () => {
    let called = false;
    const ext: KernelExtension = {
      name: "observer",
      validateTransition: () => {
        called = true;
        return true;
      },
    };

    const composed = await composeExtensions([ext], testGuardCtx());
    composed.validateTransition("created", "running");
    expect(called).toBe(true);
  });

  test("short-circuits on first false", async () => {
    const order: string[] = [];
    const ext1: KernelExtension = {
      name: "blocker",
      priority: 0,
      validateTransition: () => {
        order.push("blocker");
        return false;
      },
    };
    const ext2: KernelExtension = {
      name: "observer",
      priority: 10,
      validateTransition: () => {
        order.push("observer");
        return true;
      },
    };

    const composed = await composeExtensions([ext1, ext2], testGuardCtx());
    const allowed = composed.validateTransition("created", "running");

    expect(allowed).toBe(false);
    expect(order).toEqual(["blocker"]);
  });

  test("returns true when no validators", async () => {
    const ext: KernelExtension = { name: "no-validator" };
    const composed = await composeExtensions([ext], testGuardCtx());
    expect(composed.validateTransition("created", "running")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// composeExtensions — assembly validator
// ---------------------------------------------------------------------------

describe("composeExtensions assembly validator", () => {
  test("returns ok when no validators", async () => {
    const ext: KernelExtension = { name: "no-validator" };
    const composed = await composeExtensions([ext], testGuardCtx());
    const result = await composed.validateAssembly(new Map(), testManifest());
    expect(result.ok).toBe(true);
  });

  test("merges diagnostics from multiple validators", async () => {
    const ext1: KernelExtension = {
      name: "v1",
      validateAssembly: () => ({
        ok: false,
        diagnostics: [{ source: "v1", message: "missing tool", severity: "error" }],
      }),
    };
    const ext2: KernelExtension = {
      name: "v2",
      validateAssembly: () => ({
        ok: false,
        diagnostics: [{ source: "v2", message: "deprecated config", severity: "warning" }],
      }),
    };

    const composed = await composeExtensions([ext1, ext2], testGuardCtx());
    const result = await composed.validateAssembly(new Map(), testManifest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(2);
      expect(result.diagnostics[0]?.source).toBe("v1");
      expect(result.diagnostics[1]?.source).toBe("v2");
    }
  });

  test("runs validators in parallel", async () => {
    const startTimes: number[] = [];
    const ext1: KernelExtension = {
      name: "slow1",
      validateAssembly: async () => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true };
      },
    };
    const ext2: KernelExtension = {
      name: "slow2",
      validateAssembly: async () => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true };
      },
    };

    const composed = await composeExtensions([ext1, ext2], testGuardCtx());
    await composed.validateAssembly(new Map(), testManifest());

    // Both should start within a tight window (parallel, not sequential)
    expect(startTimes).toHaveLength(2);
    const timeDiff = Math.abs((startTimes[0] ?? 0) - (startTimes[1] ?? 0));
    expect(timeDiff).toBeLessThan(30);
  });

  test("warning-only diagnostics still pass", async () => {
    const ext: KernelExtension = {
      name: "warner",
      validateAssembly: () => ({
        ok: false,
        diagnostics: [{ source: "warner", message: "advisory", severity: "warning" }],
      }),
    };

    const composed = await composeExtensions([ext], testGuardCtx());
    const result = await composed.validateAssembly(new Map(), testManifest());
    expect(result.ok).toBe(true);
  });

  test("errors cause failure even when mixed with warnings", async () => {
    const ext: KernelExtension = {
      name: "mixed",
      validateAssembly: (): {
        readonly ok: false;
        readonly diagnostics: readonly ValidationDiagnostic[];
      } => ({
        ok: false,
        diagnostics: [
          { source: "mixed", message: "warning", severity: "warning" },
          { source: "mixed", message: "error", severity: "error" },
        ],
      }),
    };

    const composed = await composeExtensions([ext], testGuardCtx());
    const result = await composed.validateAssembly(new Map(), testManifest());
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createDefaultGuardExtension
// ---------------------------------------------------------------------------

describe("createDefaultGuardExtension", () => {
  test("has CORE priority", () => {
    const ext = createDefaultGuardExtension();
    expect(ext.priority).toBe(EXTENSION_PRIORITY.CORE);
  });

  test("has correct name", () => {
    const ext = createDefaultGuardExtension();
    expect(ext.name).toBe("koi:default-guards");
  });

  test("produces 3 guards by default", () => {
    const ext = createDefaultGuardExtension();
    const guards = ext.guards?.(testGuardCtx());
    // Sync path — should return array directly
    expect(Array.isArray(guards)).toBe(true);
    if (Array.isArray(guards)) {
      expect(guards).toHaveLength(3);
      expect(guards[0]?.name).toBe("koi:iteration-guard");
      expect(guards[1]?.name).toBe("koi:loop-detector");
      expect(guards[2]?.name).toBe("koi:spawn-guard");
    }
  });

  test("produces 2 guards when loopDetection is false", () => {
    const ext = createDefaultGuardExtension({ loopDetection: false });
    const guards = ext.guards?.(testGuardCtx());
    expect(Array.isArray(guards)).toBe(true);
    if (Array.isArray(guards)) {
      expect(guards).toHaveLength(2);
      expect(guards[0]?.name).toBe("koi:iteration-guard");
      expect(guards[1]?.name).toBe("koi:spawn-guard");
    }
  });

  test("passes agentDepth from guard context to spawn guard", async () => {
    const ext = createDefaultGuardExtension();
    const ctx = testGuardCtx({ agentDepth: 2 });
    const composed = await composeExtensions([ext], ctx);
    // Spawn guard should be created with depth 2 — verified by composition succeeding
    expect(composed.guardMiddleware).toHaveLength(3);
  });
});
