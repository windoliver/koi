/**
 * Tests for the soft-deny execute-time path (#1650 Task 10).
 *
 * Covers:
 * - Soft-deny returns synthetic ToolResponse (does not throw)
 * - Output string trust-boundary: contains toolId, NOT decision.reason
 * - Metadata fields on synthetic response
 * - DenialTracker records for hard-converted paths (unkeyable, over-cap, native)
 * - SoftDenyLog records for soft path (via test hook __getSoftDenyLogForTesting)
 * - dispatchPermissionDecision fires exactly once per deny path
 * - Hard-converted decisions have disposition: "hard" and reason suffix
 * - Native hard-deny still throws KoiRuntimeError
 * - Per-turn cap enforcement
 * - Cached deny replay keeps soft disposition (IS_CACHED does not block soft path)
 */

import { describe, expect, mock, test } from "bun:test";
import type { ToolRequest, ToolResponse, TurnContext } from "@koi/core/middleware";
import type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "@koi/core/permission-backend";
import { KoiRuntimeError } from "@koi/errors";
import { createPermissionsMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurnContext(overrides?: {
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly turnIndex?: number;
  readonly dispatchPermissionDecision?: (
    q: PermissionQuery,
    d: PermissionDecision,
  ) => void | Promise<void>;
  readonly reportDecision?: (...args: readonly unknown[]) => void;
}): TurnContext {
  const base = {
    session: {
      agentId: overrides?.agentId ?? "agent:test",
      sessionId: (overrides?.sessionId ?? "s-soft-deny") as never,
      runId: "r-1" as never,
      userId: "user-1",
      metadata: {},
    },
    turnIndex: overrides?.turnIndex ?? 0,
    turnId: "t-1" as never,
    messages: [] as const,
    metadata: {},
  };
  const extras: Record<string, unknown> = {};
  if (overrides?.dispatchPermissionDecision !== undefined) {
    extras.dispatchPermissionDecision = overrides.dispatchPermissionDecision;
  }
  if (overrides?.reportDecision !== undefined) {
    extras.reportDecision = overrides.reportDecision;
  }
  return { ...base, ...extras } as TurnContext;
}

function makeToolRequest(toolId: string): ToolRequest {
  return { toolId, input: {} };
}

const noopToolHandler = async (_req: ToolRequest): Promise<ToolResponse> => ({
  output: "done",
});

/** Build a backend that returns a soft-deny decision for any tool. */
function softDenyBackend(
  reason: string = "soft policy: tool not allowed in this scope",
): PermissionBackend {
  return {
    check: (): PermissionDecision => ({
      effect: "deny",
      reason,
      disposition: "soft",
    }),
  };
}

/** Build a backend that returns a hard-deny decision (no disposition field). */
function hardDenyBackend(reason: string = "hard policy block"): PermissionBackend {
  return {
    check: (): PermissionDecision => ({
      effect: "deny",
      reason,
      // disposition absent → defaults to "hard"
    }),
  };
}

/** Build a backend that returns explicit disposition: "hard". */
function explicitHardDenyBackend(reason: string = "explicit hard deny"): PermissionBackend {
  return {
    check: (): PermissionDecision => ({
      effect: "deny",
      reason,
      disposition: "hard",
    }),
  };
}

// ---------------------------------------------------------------------------
// 1. Soft-deny returns synthetic ToolResponse (does NOT throw)
// ---------------------------------------------------------------------------

describe("soft-deny execute-time path (#1650)", () => {
  test("soft-deny resolves (does NOT throw)", async () => {
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    const ctx = makeTurnContext();
    const handler = mock(noopToolHandler);

    // Must NOT reject
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("my_tool"), handler);
    expect(result).toBeDefined();
    // next must NOT be called
    expect(handler).not.toHaveBeenCalled();
  });

  test("soft-deny output contains toolId", async () => {
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    const ctx = makeTurnContext();
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("my_tool"), noopToolHandler);
    expect(result?.output).toContain("my_tool");
  });

  test("soft-deny output does NOT contain decision.reason (leak prevention)", async () => {
    const secretReason = "internal-policy-id:XYZ-SECRET-REASON";
    const mw = createPermissionsMiddleware({ backend: softDenyBackend(secretReason) });
    const ctx = makeTurnContext();
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("my_tool"), noopToolHandler);
    expect(result?.output).not.toContain(secretReason);
  });

  test("soft-deny metadata has isError: true", async () => {
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    const ctx = makeTurnContext();
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("my_tool"), noopToolHandler);
    expect((result?.metadata as Record<string, unknown>)?.isError).toBe(true);
  });

  test("soft-deny metadata has permissionDenied: true", async () => {
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    const ctx = makeTurnContext();
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("my_tool"), noopToolHandler);
    expect((result?.metadata as Record<string, unknown>)?.permissionDenied).toBe(true);
  });

  test("soft-deny metadata has toolId matching request", async () => {
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    const ctx = makeTurnContext();
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("specific_tool"), noopToolHandler);
    expect((result?.metadata as Record<string, unknown>)?.toolId).toBe("specific_tool");
  });

  // ---------------------------------------------------------------------------
  // 2. dispatchPermissionDecision fires exactly once on soft path
  // ---------------------------------------------------------------------------

  test("soft-deny dispatches exactly one permissionDecision event", async () => {
    const dispatchCalls: Array<readonly [PermissionQuery, PermissionDecision]> = [];
    const ctx = makeTurnContext({
      dispatchPermissionDecision: (q, d) => {
        dispatchCalls.push([q, d] as const);
      },
    });
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    await mw.wrapToolCall?.(ctx, makeToolRequest("my_tool"), noopToolHandler);
    expect(dispatchCalls).toHaveLength(1);
  });

  test("soft-deny dispatches original decision (disposition: 'soft', not hardened)", async () => {
    const dispatchCalls: PermissionDecision[] = [];
    const ctx = makeTurnContext({
      dispatchPermissionDecision: (_q, d) => {
        dispatchCalls.push(d);
      },
    });
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    await mw.wrapToolCall?.(ctx, makeToolRequest("my_tool"), noopToolHandler);
    const first = dispatchCalls[0];
    expect(first?.effect).toBe("deny");
    if (first?.effect === "deny") expect(first.disposition).toBe("soft");
  });

  // ---------------------------------------------------------------------------
  // 3. SoftDenyLog inspection via test hook
  // ---------------------------------------------------------------------------

  test("soft-deny records entry in SoftDenyLog (via __getSoftDenyLogForTesting)", async () => {
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    const sessionId = "s-soft-log-inspect";
    const ctx = makeTurnContext({ sessionId });
    await mw.wrapToolCall?.(ctx, makeToolRequest("logged_tool"), noopToolHandler);

    // Use internal test hook to inspect the log
    const hook = (mw as unknown as Record<string, unknown>).__getSoftDenyLogForTesting;
    if (typeof hook !== "function") {
      // Document: test hook not yet available; soft path correctness verified via output shape
      return;
    }
    const log = (hook as (sessionId: string) => { getAll: () => readonly unknown[] })(sessionId);
    const entries = log.getAll();
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Record<string, unknown>;
    expect(entry.toolId).toBe("logged_tool");
  });

  // ---------------------------------------------------------------------------
  // 4. Native hard-deny still throws
  // ---------------------------------------------------------------------------

  test("native hard-deny (disposition omitted) throws KoiRuntimeError", async () => {
    const mw = createPermissionsMiddleware({ backend: hardDenyBackend("blocked") });
    const ctx = makeTurnContext();
    await expect(mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler)).rejects.toThrow(
      "blocked",
    );
  });

  test("native hard-deny throws KoiRuntimeError with PERMISSION code", async () => {
    const mw = createPermissionsMiddleware({ backend: hardDenyBackend("hard block") });
    const ctx = makeTurnContext();
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
      throw new Error("should not reach");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      expect((e as KoiRuntimeError).code).toBe("PERMISSION");
    }
  });

  test("native hard-deny dispatches exactly once with original decision", async () => {
    const dispatchCalls: PermissionDecision[] = [];
    const ctx = makeTurnContext({
      dispatchPermissionDecision: (_q, d) => {
        dispatchCalls.push(d);
      },
    });
    const mw = createPermissionsMiddleware({ backend: hardDenyBackend("blocked") });
    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler),
    ).rejects.toThrow();
    expect(dispatchCalls).toHaveLength(1);
    // disposition on native hard is undefined (no disposition field set by backend)
    expect(dispatchCalls[0]?.effect).toBe("deny");
  });

  test("explicit disposition:'hard' still throws", async () => {
    const mw = createPermissionsMiddleware({ backend: explicitHardDenyBackend() });
    const ctx = makeTurnContext();
    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
  });

  // ---------------------------------------------------------------------------
  // 5. DenialTracker for hard paths (native, unkeyable, over-cap)
  // ---------------------------------------------------------------------------

  test("native hard-deny records DenialTracker entry with origin: 'native'", async () => {
    const mw = createPermissionsMiddleware({ backend: hardDenyBackend("blocked") });
    const sessionId = "s-tracker-native";
    const ctx = makeTurnContext({ sessionId });
    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler),
    ).rejects.toThrow();

    const hook = (mw as unknown as Record<string, unknown>).__getDenialTrackerForTesting;
    if (typeof hook !== "function") return; // document concern, skip assertion
    const tracker = (hook as (s: string) => { getAll: () => readonly unknown[] })(sessionId);
    const records = tracker.getAll();
    const entry = records[records.length - 1] as Record<string, unknown>;
    expect(entry.origin).toBe("native");
    expect(entry.softness).toBe("hard");
  });

  // ---------------------------------------------------------------------------
  // 6. Per-turn cap enforcement
  // ---------------------------------------------------------------------------

  test("Nth soft-deny still returns synthetic response (under cap)", async () => {
    // cap defaults to 3 — calls 1, 2, 3 should be soft
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      cache: true, // enable caching so same key is reused
    });
    const sessionId = "s-cap-under";
    const ctx = makeTurnContext({ sessionId });

    for (let i = 0; i < 3; i++) {
      const result = await mw.wrapToolCall?.(ctx, makeToolRequest("capped_tool"), noopToolHandler);
      expect(result).toBeDefined();
      // Should NOT throw for first 3
      expect((result?.metadata as Record<string, unknown>)?.permissionDenied).toBe(true);
    }
  });

  test("(cap+1)th soft-deny hard-throws with 'soft-deny retry cap' suffix", async () => {
    // With cap=1: first call soft, second call over-cap → hard-throw
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend("policy: no write"),
      cache: true,
      softDenyPerTurnCap: 1,
    });
    const sessionId = "s-cap-over";
    const ctx = makeTurnContext({ sessionId });

    // First call: under cap
    const first = await mw.wrapToolCall?.(ctx, makeToolRequest("write_tool"), noopToolHandler);
    expect((first?.metadata as Record<string, unknown>)?.permissionDenied).toBe(true);

    // Second call: over cap → throws
    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("write_tool"), noopToolHandler),
    ).rejects.toThrow("soft-deny retry cap");
  });

  test("over-cap throw contains cap number in error message", async () => {
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      cache: true,
      softDenyPerTurnCap: 2,
    });
    const sessionId = "s-cap-msg";
    const ctx = makeTurnContext({ sessionId });

    // Two under-cap calls
    await mw.wrapToolCall?.(ctx, makeToolRequest("t"), noopToolHandler);
    await mw.wrapToolCall?.(ctx, makeToolRequest("t"), noopToolHandler);

    // Third is over cap
    try {
      await mw.wrapToolCall?.(ctx, makeToolRequest("t"), noopToolHandler);
      throw new Error("should not reach");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      expect((e as KoiRuntimeError).message).toContain("2");
    }
  });

  test("over-cap hard-throw dispatches decision with disposition: 'hard'", async () => {
    const dispatchCalls: PermissionDecision[] = [];
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      cache: true,
      softDenyPerTurnCap: 1,
    });
    const sessionId = "s-cap-dispatch";
    const ctx = makeTurnContext({
      sessionId,
      dispatchPermissionDecision: (_q, d) => {
        dispatchCalls.push(d);
      },
    });

    // Under cap (soft dispatch)
    await mw.wrapToolCall?.(ctx, makeToolRequest("t"), noopToolHandler);
    // Over cap (hardened dispatch)
    await expect(mw.wrapToolCall?.(ctx, makeToolRequest("t"), noopToolHandler)).rejects.toThrow();

    // Second dispatch (over cap) should have disposition: "hard"
    const lastDispatch = dispatchCalls[dispatchCalls.length - 1];
    expect(lastDispatch?.effect).toBe("deny");
    if (lastDispatch?.effect === "deny") expect(lastDispatch.disposition).toBe("hard");
  });

  test("over-cap hard-converted deny records DenialTracker with origin: 'soft-conversion'", async () => {
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      cache: true,
      softDenyPerTurnCap: 1,
    });
    const sessionId = "s-cap-tracker";
    const ctx = makeTurnContext({ sessionId });

    // Under cap
    await mw.wrapToolCall?.(ctx, makeToolRequest("t"), noopToolHandler);
    // Over cap
    await expect(mw.wrapToolCall?.(ctx, makeToolRequest("t"), noopToolHandler)).rejects.toThrow();

    const hook = (mw as unknown as Record<string, unknown>).__getDenialTrackerForTesting;
    if (typeof hook !== "function") return;
    const tracker = (hook as (s: string) => { getAll: () => readonly unknown[] })(sessionId);
    const records = tracker.getAll();
    const lastRecord = records[records.length - 1] as Record<string, unknown>;
    expect(lastRecord.origin).toBe("soft-conversion");
    expect(lastRecord.softness).toBe("hard");
  });

  // ---------------------------------------------------------------------------
  // 7. Unkeyable context: soft candidate with no serializable context → hard-convert
  // ---------------------------------------------------------------------------

  test("unkeyable context on soft candidate hard-throws with 'unkeyable context' in message", async () => {
    // An unserializable context (circular ref or BigInt value in metadata)
    // will cause decisionCacheKey to return undefined → unkeyable path.
    // We simulate this by injecting context that causes serialization to fail.
    const circularObj: Record<string, unknown> = {};
    circularObj.self = circularObj; // circular reference

    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    // Inject via metadata on the tool request — the middleware passes metadata to queryForTool
    const ctx = makeTurnContext();
    // Use a tool request with unkeyable input (circular object goes into input, not context)
    // Actually we need the context to be unkeyable. The context comes from query.context
    // which is built from ctx metadata and resolvedPath. We test with BigInt in metadata.
    const ctxWithBigInt: TurnContext = {
      ...ctx,
      metadata: { value: BigInt(42) } as unknown as Record<string, unknown>,
    };

    await expect(
      mw.wrapToolCall?.(ctxWithBigInt, makeToolRequest("sensitive_tool"), noopToolHandler),
    ).rejects.toThrow("unkeyable context");
  });

  test("unkeyable hard-convert records DenialTracker with origin: 'soft-conversion'", async () => {
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    const sessionId = "s-unkeyable-tracker";
    const ctx: TurnContext = {
      ...makeTurnContext({ sessionId }),
      metadata: { value: BigInt(42) } as unknown as Record<string, unknown>,
    };

    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("sensitive_tool"), noopToolHandler),
    ).rejects.toThrow();

    const hook = (mw as unknown as Record<string, unknown>).__getDenialTrackerForTesting;
    if (typeof hook !== "function") return;
    const tracker = (hook as (s: string) => { getAll: () => readonly unknown[] })(sessionId);
    const records = tracker.getAll();
    const lastRecord = records[records.length - 1] as Record<string, unknown>;
    expect(lastRecord.origin).toBe("soft-conversion");
    expect(lastRecord.softness).toBe("hard");
  });

  // ---------------------------------------------------------------------------
  // 8. Cached deny replay preserves soft path (IS_CACHED does not block isSoftCandidate)
  // ---------------------------------------------------------------------------

  test("cached soft-deny replay (same query twice) still takes soft path on second call", async () => {
    // With cache enabled, the second call hits the deny cache (tagged IS_CACHED).
    // IS_CACHED changes denialSource() to return "escalation" but isSoftCandidate
    // uses isEscalated() (true escalation only, not IS_CACHED), so soft path remains.
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      cache: true,
    });
    const sessionId = "s-cached-soft";
    const ctx = makeTurnContext({ sessionId });

    const first = await mw.wrapToolCall?.(ctx, makeToolRequest("my_tool"), noopToolHandler);
    const second = await mw.wrapToolCall?.(ctx, makeToolRequest("my_tool"), noopToolHandler);

    // Both should be soft (return synthetic response, not throw)
    expect((first?.metadata as Record<string, unknown>)?.permissionDenied).toBe(true);
    expect((second?.metadata as Record<string, unknown>)?.permissionDenied).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 9. source: "approval" path is NOT a soft candidate
  // ---------------------------------------------------------------------------

  // Note: The "approval" source comes from decisions tagged IS_FAIL_CLOSED or
  // IS_ESCALATED, OR when approval handler returns deny. The source check
  // `source !== "approval"` is covered by the escalation path test.
  // We verify that isSoftCandidate requires source !== "approval" by checking that
  // a fail-closed deny (which sets source "backend-error") does not take the soft path
  // even if disposition is "soft" (fail-closed sets IS_FAIL_CLOSED → isFailClosed → hard path).

  test("fail-closed deny ignores soft disposition and throws", async () => {
    // Backend returns malformed response (null) → fail-closed deny, regardless of caller disposition
    const mw = createPermissionsMiddleware({
      backend: { check: () => null as unknown as PermissionDecision },
    });
    const ctx = makeTurnContext();
    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
  });

  // ---------------------------------------------------------------------------
  // 10. reportDecision: soft-deny calls reportDecision exactly once
  // ---------------------------------------------------------------------------

  test("soft-deny calls reportDecision once with action:'deny'", async () => {
    const reportCalls: unknown[] = [];
    const ctx = makeTurnContext({
      reportDecision: (...args) => {
        reportCalls.push(args[0]);
      },
    });
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    await mw.wrapToolCall?.(ctx, makeToolRequest("my_tool"), noopToolHandler);
    expect(reportCalls).toHaveLength(1);
    const report = reportCalls[0] as Record<string, unknown>;
    expect(report.action).toBe("deny");
  });

  test("native hard-deny calls reportDecision once with action:'deny'", async () => {
    const reportCalls: unknown[] = [];
    const ctx = makeTurnContext({
      reportDecision: (...args) => {
        reportCalls.push(args[0]);
      },
    });
    const mw = createPermissionsMiddleware({ backend: hardDenyBackend() });
    await expect(
      mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler),
    ).rejects.toThrow();
    expect(reportCalls).toHaveLength(1);
    const report = reportCalls[0] as Record<string, unknown>;
    expect(report.action).toBe("deny");
  });
});

describe("filterTools soft-deny visibility at model-call time (#1650 Task 11)", () => {
  test("soft-deny tools remain in request.tools (not stripped)", async () => {
    // Backend returns soft-deny for "bash", allow for "read".
    const perToolBackend: PermissionBackend = {
      check: (q: PermissionQuery): PermissionDecision => {
        if (q.resource === "bash") {
          return { effect: "deny", reason: "soft policy on bash", disposition: "soft" };
        }
        return { effect: "allow" };
      },
      checkBatch: async (qs): Promise<readonly PermissionDecision[]> =>
        qs.map((q) =>
          q.resource === "bash"
            ? ({ effect: "deny", reason: "soft policy on bash", disposition: "soft" } as const)
            : ({ effect: "allow" } as const),
        ),
    };
    const mw = createPermissionsMiddleware({ backend: perToolBackend });
    const ctx = makeTurnContext();

    let observedTools: ReadonlyArray<{ readonly name: string }> | undefined;
    const request = {
      messages: [],
      tools: [{ name: "bash" }, { name: "read" }],
    } as never;
    await mw.wrapModelCall?.(ctx, request, async (req) => {
      observedTools = (req.tools ?? []) as unknown as ReadonlyArray<{ readonly name: string }>;
      return { content: "", model: "test" } as never;
    });

    const names = (observedTools ?? []).map((t) => t.name);
    expect(names).toContain("bash"); // soft-deny → VISIBLE
    expect(names).toContain("read");
  });

  test("hard-deny tools are STRIPPED from request.tools (unchanged behavior)", async () => {
    const perToolBackend: PermissionBackend = {
      check: (q: PermissionQuery): PermissionDecision =>
        q.resource === "bash"
          ? { effect: "deny", reason: "hard policy on bash" } // no disposition → hard default
          : { effect: "allow" },
      checkBatch: async (qs): Promise<readonly PermissionDecision[]> =>
        qs.map((q) =>
          q.resource === "bash"
            ? ({ effect: "deny", reason: "hard policy on bash" } as const)
            : ({ effect: "allow" } as const),
        ),
    };
    const mw = createPermissionsMiddleware({ backend: perToolBackend });
    const ctx = makeTurnContext();

    let observedTools: ReadonlyArray<{ readonly name: string }> | undefined;
    const request = {
      messages: [],
      tools: [{ name: "bash" }, { name: "read" }],
    } as never;
    await mw.wrapModelCall?.(ctx, request, async (req) => {
      observedTools = (req.tools ?? []) as unknown as ReadonlyArray<{ readonly name: string }>;
      return { content: "", model: "test" } as never;
    });

    const names = (observedTools ?? []).map((t) => t.name);
    expect(names).not.toContain("bash"); // hard-deny → STRIPPED
    expect(names).toContain("read");
  });

  test("planning-time soft-deny records entry in SoftDenyLog (not DenialTracker)", async () => {
    const perToolBackend: PermissionBackend = {
      check: (q: PermissionQuery): PermissionDecision =>
        q.resource === "bash"
          ? { effect: "deny", reason: "soft policy on bash", disposition: "soft" }
          : { effect: "allow" },
      checkBatch: async (qs): Promise<readonly PermissionDecision[]> =>
        qs.map((q) =>
          q.resource === "bash"
            ? ({ effect: "deny", reason: "soft policy on bash", disposition: "soft" } as const)
            : ({ effect: "allow" } as const),
        ),
    };
    const mw = createPermissionsMiddleware({ backend: perToolBackend });
    const ctx = makeTurnContext();
    const request = { messages: [], tools: [{ name: "bash" }] } as never;

    await mw.wrapModelCall?.(ctx, request, async () => ({ content: "", model: "test" }) as never);

    const softDenyLog = (
      mw as unknown as {
        __getSoftDenyLogForTesting(sessionId: string): { getAll(): readonly unknown[] };
      }
    ).__getSoftDenyLogForTesting(ctx.session.sessionId as string);
    const tracker = (
      mw as unknown as {
        __getDenialTrackerForTesting(sessionId: string): { getAll(): readonly unknown[] };
      }
    ).__getDenialTrackerForTesting(ctx.session.sessionId as string);

    expect(softDenyLog.getAll().length).toBe(1);
    expect(tracker.getAll().length).toBe(0); // NOT in DenialTracker
  });

  test("planning-time hard-deny records entry in DenialTracker with softness: 'hard', origin: 'native'", async () => {
    const perToolBackend: PermissionBackend = {
      check: (q: PermissionQuery): PermissionDecision =>
        q.resource === "bash"
          ? { effect: "deny", reason: "hard policy on bash" }
          : { effect: "allow" },
      checkBatch: async (qs): Promise<readonly PermissionDecision[]> =>
        qs.map((q) =>
          q.resource === "bash"
            ? ({ effect: "deny", reason: "hard policy on bash" } as const)
            : ({ effect: "allow" } as const),
        ),
    };
    const mw = createPermissionsMiddleware({ backend: perToolBackend });
    const ctx = makeTurnContext();
    const request = { messages: [], tools: [{ name: "bash" }] } as never;

    await mw.wrapModelCall?.(ctx, request, async () => ({ content: "", model: "test" }) as never);

    const tracker = (
      mw as unknown as {
        __getDenialTrackerForTesting(sessionId: string): {
          getAll(): Array<{ softness?: string; origin?: string }>;
        };
      }
    ).__getDenialTrackerForTesting(ctx.session.sessionId as string);
    const entries = tracker.getAll();
    expect(entries.length).toBe(1);
    expect(entries[0]?.softness).toBe("hard");
    expect(entries[0]?.origin).toBe("native");
  });
});

// ---------------------------------------------------------------------------
// 11. Mechanism A escalation prefilter excludes soft-conversion records (#1650 Task 12)
// ---------------------------------------------------------------------------

describe("Mechanism A escalation prefilter excludes soft-conversion records (#1650 Task 12)", () => {
  test("hard-converted soft-denies (origin: 'soft-conversion') do NOT feed session-wide escalation", async () => {
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      softDenyPerTurnCap: 1, // second call triggers over-cap
      denialEscalation: {
        threshold: 2,
        windowMs: 60_000,
      },
    });
    const ctx = makeTurnContext();

    // First call: soft-deny (under cap).
    const r1 = await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
    expect((r1?.metadata as Record<string, unknown>)?.permissionDenied).toBe(true);

    // Second call: over cap → hard-convert, records DenialTracker with origin: "soft-conversion".
    await expect(mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler)).rejects.toThrow(
      /soft-deny retry cap/,
    );

    // If soft-conversion records leaked into Mechanism A, threshold=2 would be hit.
    // Verify by inspecting tracker — exactly 1 record (the over-cap hard-convert).
    const tracker = (
      mw as unknown as {
        __getDenialTrackerForTesting(sid: string): {
          getAll(): readonly { toolId?: string; origin?: string; softness?: string }[];
        };
      }
    ).__getDenialTrackerForTesting(ctx.session.sessionId as string);

    const entries = tracker.getAll();
    expect(entries.length).toBe(1);
    expect(entries[0]?.origin).toBe("soft-conversion");
    expect(entries[0]?.softness).toBe("hard");
  });

  test("escalation predicate integration: over-cap record present but NOT counted by the prefilter", async () => {
    const backend: PermissionBackend = {
      check: async (): Promise<PermissionDecision> => ({ effect: "allow" }),
      checkBatch: async (qs): Promise<readonly PermissionDecision[]> =>
        qs.map(() => ({ effect: "allow" }) as const),
    };
    const mw = createPermissionsMiddleware({
      backend,
      denialEscalation: { threshold: 2, windowMs: 60_000 },
    });
    const ctx = makeTurnContext();
    const tracker = (
      mw as unknown as {
        __getDenialTrackerForTesting(sid: string): {
          record(entry: Record<string, unknown>): void;
          getAll(): readonly unknown[];
        };
      }
    ).__getDenialTrackerForTesting(ctx.session.sessionId as string);

    // Seed with 3 origin: "soft-conversion" records — exceeds threshold=2.
    for (let i = 0; i < 3; i++) {
      tracker.record({
        toolId: "bash",
        reason: "converted",
        timestamp: Date.now(),
        principal: ctx.session.agentId,
        turnIndex: ctx.turnIndex,
        source: "policy",
        queryKey: undefined,
        softness: "hard",
        origin: "soft-conversion",
      });
    }

    // A fresh call should hit the backend (ALLOW), not be auto-escalated.
    const handler = mock(async (_: ToolRequest): Promise<ToolResponse> => ({ output: "ok" }));
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), handler);
    expect(result?.output).toBe("ok"); // backend.check was consulted
    expect(handler).toHaveBeenCalled(); // allowed to reach next(request)
  });

  test("native hard-deny records (origin: 'native') STILL feed Mechanism A (regression)", async () => {
    const backend: PermissionBackend = {
      check: async (): Promise<PermissionDecision> => ({ effect: "allow" }),
      checkBatch: async (qs): Promise<readonly PermissionDecision[]> =>
        qs.map(() => ({ effect: "allow" }) as const),
    };
    const mw = createPermissionsMiddleware({
      backend,
      denialEscalation: { threshold: 2, windowMs: 60_000 },
    });
    const ctx = makeTurnContext();
    const tracker = (
      mw as unknown as {
        __getDenialTrackerForTesting(sid: string): {
          record(entry: Record<string, unknown>): void;
        };
      }
    ).__getDenialTrackerForTesting(ctx.session.sessionId as string);

    // Seed with 3 origin: "native" records — exceeds threshold=2.
    for (let i = 0; i < 3; i++) {
      tracker.record({
        toolId: "bash",
        reason: "native hard",
        timestamp: Date.now(),
        principal: ctx.session.agentId,
        turnIndex: ctx.turnIndex,
        source: "policy",
        queryKey: undefined,
        softness: "hard",
        origin: "native",
      });
    }

    // This time Mechanism A should fire — next call short-circuits to deny
    // BEFORE reaching the backend (which would have returned allow).
    await expect(mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler)).rejects.toThrow(
      /Auto-denied/,
    );
  });
});

// ---------------------------------------------------------------------------
// 11. onBeforeTurn clears per-turn soft-deny counter (#1650 Task 13)
// ---------------------------------------------------------------------------

describe("onBeforeTurn clears per-turn soft-deny counter (#1650 Task 13)", () => {
  test("counter reaches cap in turn 0; same cacheKey in turn 1 soft-returns after onBeforeTurn", async () => {
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      softDenyPerTurnCap: 2,
    });
    const ctx0 = makeTurnContext({ turnIndex: 0, sessionId: "s-turn-clear" });

    // Turn 0: 3 calls → 2 soft, 3rd over cap hard-throws.
    await mw.wrapToolCall?.(ctx0, makeToolRequest("bash"), noopToolHandler);
    await mw.wrapToolCall?.(ctx0, makeToolRequest("bash"), noopToolHandler);
    await expect(mw.wrapToolCall?.(ctx0, makeToolRequest("bash"), noopToolHandler)).rejects.toThrow(
      /soft-deny retry cap/,
    );

    // New turn: fire onBeforeTurn with a turnIndex=1 context. Counter clears.
    const ctx1 = makeTurnContext({ turnIndex: 1, sessionId: "s-turn-clear" });
    await mw.onBeforeTurn?.(ctx1);

    // Turn 1: same cacheKey soft-returns again (counter reset).
    const result = await mw.wrapToolCall?.(ctx1, makeToolRequest("bash"), noopToolHandler);
    expect((result?.metadata as Record<string, unknown>)?.permissionDenied).toBe(true);
  });

  test("onBeforeTurn is idempotent: calling twice doesn't break anything", async () => {
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      softDenyPerTurnCap: 1,
    });
    const ctx = makeTurnContext({ sessionId: "s-idempotent" });
    await mw.onBeforeTurn?.(ctx);
    await mw.onBeforeTurn?.(ctx);
    // Should still work normally.
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
    expect((result?.metadata as Record<string, unknown>)?.permissionDenied).toBe(true);
  });

  test("clearing counter does NOT clear SoftDenyLog entries (observability retained)", async () => {
    const mw = createPermissionsMiddleware({ backend: softDenyBackend() });
    const ctx = makeTurnContext({ sessionId: "s-observability" });
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
    const before = (
      mw as unknown as {
        __getSoftDenyLogForTesting(sid: string): { getAll(): readonly unknown[] };
      }
    )
      .__getSoftDenyLogForTesting(ctx.session.sessionId as string)
      .getAll().length;
    expect(before).toBe(1);

    await mw.onBeforeTurn?.(makeTurnContext({ turnIndex: 1, sessionId: "s-observability" }));

    const after = (
      mw as unknown as {
        __getSoftDenyLogForTesting(sid: string): { getAll(): readonly unknown[] };
      }
    )
      .__getSoftDenyLogForTesting(ctx.session.sessionId as string)
      .getAll().length;
    expect(after).toBe(1); // onBeforeTurn clears ONLY the turn counter, not the log
  });
});

describe("filterTools strips tools already at/over soft-deny cap (#1650 loop round-2 fix)", () => {
  test("once a soft-deny key hits cap, filterTools removes the tool from request.tools", async () => {
    const perToolBackend: PermissionBackend = {
      check: async (q: PermissionQuery): Promise<PermissionDecision> =>
        q.resource === "bash"
          ? { effect: "deny", reason: "soft-block", disposition: "soft" }
          : { effect: "allow" },
      checkBatch: async (qs): Promise<readonly PermissionDecision[]> =>
        qs.map((q) =>
          q.resource === "bash"
            ? ({ effect: "deny", reason: "soft-block", disposition: "soft" } as const)
            : ({ effect: "allow" } as const),
        ),
    };
    const mw = createPermissionsMiddleware({
      backend: perToolBackend,
      softDenyPerTurnCap: 2,
    });
    const ctx = makeTurnContext({ sessionId: "s-filter-strip" });

    // Burn through the cap at execute-time.
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    // Now the next call would hard-throw (count=3 > cap=2). Model should no
    // longer see this tool.
    let observedTools: ReadonlyArray<{ readonly name: string }> | undefined;
    await mw.wrapModelCall?.(
      ctx,
      { messages: [] as never, tools: [{ name: "bash" }, { name: "read" }] as never },
      async (req) => {
        observedTools = req.tools as ReadonlyArray<{ readonly name: string }>;
        return { content: "", model: "test" } as never;
      },
    );

    const names = (observedTools ?? []).map((t) => t.name);
    expect(names).not.toContain("bash"); // stripped — cap exhausted
    expect(names).toContain("read"); // unaffected
  });

  test("under-cap soft-deny tools stay visible to the model", async () => {
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      softDenyPerTurnCap: 5,
    });
    const ctx = makeTurnContext({ sessionId: "s-filter-visible" });

    // Only 1 deny — nowhere near cap=5.
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    let observedTools: ReadonlyArray<{ readonly name: string }> | undefined;
    await mw.wrapModelCall?.(
      ctx,
      { messages: [] as never, tools: [{ name: "bash" }] as never },
      async (req) => {
        observedTools = req.tools as ReadonlyArray<{ readonly name: string }>;
        return { content: "", model: "test" } as never;
      },
    );

    expect((observedTools ?? []).map((t) => t.name)).toContain("bash");
  });
});

describe("filterTools round-3 edge cases (#1650)", () => {
  test("repeated planning passes after cap exhaustion record DenialTracker ONLY ONCE per (turn, cacheKey)", async () => {
    const perToolBackend: PermissionBackend = {
      check: async (q: PermissionQuery): Promise<PermissionDecision> =>
        q.resource === "bash"
          ? { effect: "deny", reason: "soft-block", disposition: "soft" }
          : { effect: "allow" },
      checkBatch: async (qs): Promise<readonly PermissionDecision[]> =>
        qs.map((q) =>
          q.resource === "bash"
            ? ({ effect: "deny", reason: "soft-block", disposition: "soft" } as const)
            : ({ effect: "allow" } as const),
        ),
    };
    const mw = createPermissionsMiddleware({
      backend: perToolBackend,
      softDenyPerTurnCap: 1,
    });
    const ctx = makeTurnContext({ sessionId: "s-dedup" });

    // Push counter to cap.
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    // Run filterTools MANY times in the same turn — only the FIRST should
    // record a soft-conversion entry in DenialTracker.
    const runFilter = async () =>
      mw.wrapModelCall?.(
        ctx,
        { messages: [] as never, tools: [{ name: "bash" }] as never },
        async () => ({ content: "", model: "test" }) as never,
      );
    await runFilter();
    await runFilter();
    await runFilter();
    await runFilter();

    const tracker = (
      mw as unknown as {
        __getDenialTrackerForTesting(sid: string): {
          getAll(): ReadonlyArray<{ toolId: string; origin?: string }>;
        };
      }
    ).__getDenialTrackerForTesting("s-dedup");
    const softConversions = tracker
      .getAll()
      .filter((r) => r.origin === "soft-conversion" && r.toolId === "bash");
    expect(softConversions.length).toBe(1); // exactly one, not N
  });

  test("filter-time cap exhaustion dispatches HARDENED decision to observers (audit parity)", async () => {
    const perToolBackend: PermissionBackend = {
      check: async (q: PermissionQuery): Promise<PermissionDecision> =>
        q.resource === "bash"
          ? { effect: "deny", reason: "soft-block", disposition: "soft" }
          : { effect: "allow" },
      checkBatch: async (qs): Promise<readonly PermissionDecision[]> =>
        qs.map((q) =>
          q.resource === "bash"
            ? ({ effect: "deny", reason: "soft-block", disposition: "soft" } as const)
            : ({ effect: "allow" } as const),
        ),
    };
    const dispatchCalls: PermissionDecision[] = [];
    const mw = createPermissionsMiddleware({
      backend: perToolBackend,
      softDenyPerTurnCap: 1,
    });
    const ctx = makeTurnContext({
      sessionId: "s-filter-audit-parity",
      dispatchPermissionDecision: (_q, d) => {
        dispatchCalls.push(d);
      },
    });

    // Push counter to cap.
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
    dispatchCalls.length = 0; // reset, only care about filter-time dispatches

    // Filter-time call AFTER cap is exhausted: the dispatched decision should
    // be the hardened one (disposition: "hard" + suffix) — matching the
    // DenialTracker record's shape.
    await mw.wrapModelCall?.(
      ctx,
      { messages: [] as never, tools: [{ name: "bash" }] as never },
      async () => ({ content: "", model: "test" }) as never,
    );
    const dispatchedForBash = dispatchCalls.find(
      (d) => d.effect === "deny" && d.reason.includes("soft-block"),
    );
    expect(dispatchedForBash).toBeDefined();
    if (dispatchedForBash?.effect === "deny") {
      expect(dispatchedForBash.disposition).toBe("hard");
      expect(dispatchedForBash.reason).toContain("soft-deny retry cap");
    }
  });

  test("unkeyable soft-deny: tool stripped + DenialTracker records origin: 'soft-conversion' + hardened dispatch", async () => {
    const backend: PermissionBackend = {
      check: async (_q: PermissionQuery): Promise<PermissionDecision> => ({
        effect: "deny",
        reason: "unkeyable",
        disposition: "soft",
      }),
      checkBatch: async (qs): Promise<readonly PermissionDecision[]> =>
        qs.map(() => ({ effect: "deny", reason: "unkeyable", disposition: "soft" }) as const),
    };
    const dispatchCalls: PermissionDecision[] = [];
    const mw = createPermissionsMiddleware({ backend });

    // Circular metadata → decisionCacheKey(query) returns undefined.
    const cyclic: Record<string, unknown> = { self: null };
    cyclic.self = cyclic;
    const baseCtx = makeTurnContext({
      sessionId: "s-unkeyable",
      dispatchPermissionDecision: (_q, d) => {
        dispatchCalls.push(d);
      },
    });
    const ctx = { ...baseCtx, metadata: cyclic } as typeof baseCtx;

    let observedTools: ReadonlyArray<{ readonly name: string }> | undefined;
    await mw.wrapModelCall?.(
      ctx,
      { messages: [] as never, tools: [{ name: "fs_write" }] as never },
      async (req) => {
        observedTools = req.tools as ReadonlyArray<{ readonly name: string }>;
        return { content: "", model: "test" } as never;
      },
    );

    expect((observedTools ?? []).map((t) => t.name)).not.toContain("fs_write");

    const tracker = (
      mw as unknown as {
        __getDenialTrackerForTesting(sid: string): {
          getAll(): ReadonlyArray<{
            toolId: string;
            origin?: string;
            softness?: string;
          }>;
        };
      }
    ).__getDenialTrackerForTesting("s-unkeyable");
    const records = tracker
      .getAll()
      .filter((r) => r.toolId === "fs_write" && r.origin === "soft-conversion");
    expect(records.length).toBe(1);
    expect(records[0]?.softness).toBe("hard");

    const dispatched = dispatchCalls.find(
      (d) => d.effect === "deny" && d.reason.includes("unkeyable"),
    );
    expect(dispatched).toBeDefined();
    if (dispatched?.effect === "deny") {
      expect(dispatched.disposition).toBe("hard");
      expect(dispatched.reason).toContain("unkeyable context — failing closed");
    }
  });
});

describe("session-state eviction (#1650 Task-16 regression)", () => {
  test("clearSessionApprovals evicts soft-deny log and turn counter for that session", async () => {
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      softDenyPerTurnCap: 2,
    });
    const ctx = makeTurnContext({ sessionId: "s-clear-approvals" });

    // Fill the soft-deny log and counter.
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    const hooks = mw as unknown as {
      clearSessionApprovals(sid: string): void;
      __getSoftDenyLogForTesting(sid: string): { getAll(): readonly unknown[] };
    };
    expect(hooks.__getSoftDenyLogForTesting("s-clear-approvals").getAll().length).toBe(2);

    hooks.clearSessionApprovals("s-clear-approvals");

    // Fresh log after clear — session id reuse starts at zero.
    expect(hooks.__getSoftDenyLogForTesting("s-clear-approvals").getAll().length).toBe(0);

    // Counter also reset: two more soft denies should be under cap (cap=2) again,
    // whereas without the reset they would trip the cap on the next call.
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
    // The third call would trip the (cleared) counter at cap+1 = 3, confirming reset.
    await expect(mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler)).rejects.toThrow(
      /soft-deny retry cap/,
    );
  });

  test("onSessionEnd evicts soft-deny log and turn counter so a reused session id starts fresh", async () => {
    const mw = createPermissionsMiddleware({
      backend: softDenyBackend(),
      softDenyPerTurnCap: 1,
    });
    const ctx = makeTurnContext({ sessionId: "s-reused" });

    // Turn 0: one soft-deny pushes counter to 1 (at cap).
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    // Without reset, the next call (in a new turn but reused session id) would
    // trip the cap immediately. onSessionEnd must clear the counter so a reused
    // session id starts fresh.
    await mw.onSessionEnd?.({ sessionId: "s-reused" } as never);

    const hooks = mw as unknown as {
      __getSoftDenyLogForTesting(sid: string): { getAll(): readonly unknown[] };
    };
    expect(hooks.__getSoftDenyLogForTesting("s-reused").getAll().length).toBe(0);

    // Reused session id: fresh counter — single soft-deny under cap (does not throw).
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
    expect((result?.metadata as Record<string, unknown>)?.permissionDenied).toBe(true);
  });
});
