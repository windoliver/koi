/**
 * Tests for createSandboxMiddleware — 15 cases covering all behavior.
 */

import { describe, expect, it, mock } from "bun:test";
import type { TrustTier } from "@koi/core/ecs";
import type {
  CapabilityFragment,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "@koi/core/middleware";
import type { SandboxProfile } from "@koi/core/sandbox-profile";
import { KoiRuntimeError } from "@koi/errors";
import { createMockTurnContext, createSpyToolHandler } from "@koi/test-utils";
import type { SandboxMiddlewareConfig } from "./config.js";
import { createSandboxMiddleware } from "./sandbox-middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(tier: TrustTier, timeoutMs: number): SandboxProfile {
  return {
    tier,
    filesystem: {},
    network: { allow: false },
    resources: { timeoutMs },
  };
}

const SANDBOX_PROFILE = makeProfile("sandbox", 50);
const VERIFIED_PROFILE = makeProfile("verified", 200);
const PROMOTED_PROFILE = makeProfile("promoted", 1000);

function profileFor(tier: TrustTier): SandboxProfile {
  switch (tier) {
    case "sandbox":
      return SANDBOX_PROFILE;
    case "verified":
      return VERIFIED_PROFILE;
    case "promoted":
      return PROMOTED_PROFILE;
  }
}

function makeRequest(toolId: string): ToolRequest {
  return { toolId, input: { arg: "value" } };
}

function makeConfig(
  tierMap: Record<string, TrustTier | undefined>,
  overrides?: Partial<SandboxMiddlewareConfig>,
): SandboxMiddlewareConfig {
  return {
    profileFor,
    tierFor: (toolId: string) => tierMap[toolId],
    ...overrides,
  };
}

const ctx = createMockTurnContext();

/** Creates a handler that delays for the given milliseconds. */
function createDelayHandler(delayMs: number, response?: Partial<ToolResponse>): ToolHandler {
  return async (_request: ToolRequest): Promise<ToolResponse> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { output: { result: "delayed" }, ...response };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSandboxMiddleware", () => {
  describe("tier resolution", () => {
    it("passes through promoted tools without wrapping", async () => {
      const mw = createSandboxMiddleware(makeConfig({ "my-tool": "promoted" }));
      const spy = createSpyToolHandler({ output: { ok: true } });
      const request = makeRequest("my-tool");

      const response = await mw.wrapToolCall?.(ctx, request, spy.handler);

      expect(response?.output).toEqual({ ok: true });
      expect(spy.calls).toHaveLength(1);
    });

    it("wraps sandbox-tier tools with timeout enforcement", async () => {
      const mw = createSandboxMiddleware(
        makeConfig({ "code-exec": "sandbox" }, { timeoutGraceMs: 100 }),
      );
      const spy = createSpyToolHandler({ output: { ran: true } });
      const request = makeRequest("code-exec");

      const response = await mw.wrapToolCall?.(ctx, request, spy.handler);

      expect(response?.output).toEqual({ ran: true });
      expect(spy.calls).toHaveLength(1);
    });

    it("wraps verified-tier tools with permissive profile", async () => {
      const mw = createSandboxMiddleware(
        makeConfig({ "trusted-tool": "verified" }, { timeoutGraceMs: 100 }),
      );
      const spy = createSpyToolHandler({ output: { verified: true } });
      const request = makeRequest("trusted-tool");

      const response = await mw.wrapToolCall?.(ctx, request, spy.handler);

      expect(response?.output).toEqual({ verified: true });
      expect(spy.calls).toHaveLength(1);
    });

    it("treats unknown tools as sandbox when failClosed=true", async () => {
      const onMetrics = mock(
        (_toolId: string, _tier: TrustTier, _d: number, _b: number, _t: boolean) => {},
      );
      const mw = createSandboxMiddleware(
        makeConfig(
          {}, // empty — all tools unknown
          { failClosedOnLookupError: true, timeoutGraceMs: 100, onSandboxMetrics: onMetrics },
        ),
      );
      const spy = createSpyToolHandler({ output: { fallback: true } });
      const request = makeRequest("unknown-tool");

      const response = await mw.wrapToolCall?.(ctx, request, spy.handler);

      expect(response?.output).toEqual({ fallback: true });
      // Metrics should fire with "sandbox" tier (fail-closed fallback)
      expect(onMetrics).toHaveBeenCalledTimes(1);
      const call = onMetrics.mock.calls.at(0);
      expect(call?.at(1)).toBe("sandbox");
    });

    it("passes through unknown tools when failClosed=false", async () => {
      const onMetrics = mock(
        (_toolId: string, _tier: TrustTier, _d: number, _b: number, _t: boolean) => {},
      );
      const mw = createSandboxMiddleware(
        makeConfig(
          {}, // empty — all tools unknown
          { failClosedOnLookupError: false, onSandboxMetrics: onMetrics },
        ),
      );
      const spy = createSpyToolHandler({ output: { passThrough: true } });
      const request = makeRequest("unknown-tool");

      const response = await mw.wrapToolCall?.(ctx, request, spy.handler);

      expect(response?.output).toEqual({ passThrough: true });
      // No metrics — tool was passed through without wrapping
      expect(onMetrics).toHaveBeenCalledTimes(0);
    });
  });

  describe("timeout enforcement", () => {
    it("throws TIMEOUT when tool exceeds total timeout", async () => {
      const mw = createSandboxMiddleware(
        makeConfig(
          { "slow-tool": "sandbox" },
          { timeoutGraceMs: 10 }, // total = 50 + 10 = 60ms
        ),
      );
      // Handler takes 500ms — well beyond 60ms timeout
      const handler = createDelayHandler(500);
      const request = makeRequest("slow-tool");

      try {
        await mw.wrapToolCall?.(ctx, request, handler);
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(KoiRuntimeError);
        const kErr = error as KoiRuntimeError;
        expect(kErr.code).toBe("TIMEOUT");
        expect(kErr.message).toContain("slow-tool");
        expect(kErr.message).toContain("60ms");
        expect(kErr.context).toMatchObject({ toolId: "slow-tool", tier: "sandbox" });
      }
    });

    it("re-throws non-timeout errors unchanged", async () => {
      const mw = createSandboxMiddleware(
        makeConfig({ "fail-tool": "sandbox" }, { timeoutGraceMs: 100 }),
      );
      const customError = new Error("something broke");
      const handler: ToolHandler = async () => {
        throw customError;
      };
      const request = makeRequest("fail-tool");

      try {
        await mw.wrapToolCall?.(ctx, request, handler);
        expect(true).toBe(false);
      } catch (error: unknown) {
        expect(error).toBe(customError);
      }
    });

    it("uses grace period: middleware fires after profile timeout + grace", async () => {
      // Profile timeout = 50ms, grace = 30ms → total = 80ms
      // Handler takes 40ms — within 80ms, so should succeed
      const mw = createSandboxMiddleware(
        makeConfig({ "borderline-tool": "sandbox" }, { timeoutGraceMs: 30 }),
      );
      const handler = createDelayHandler(40);
      const request = makeRequest("borderline-tool");

      // Should succeed because 40ms < 80ms (50 + 30)
      const response = await mw.wrapToolCall?.(ctx, request, handler);
      expect(response?.output).toEqual({ result: "delayed" });
    });
  });

  describe("output truncation", () => {
    it("does not truncate output within limit", async () => {
      const mw = createSandboxMiddleware(
        makeConfig({ "small-tool": "sandbox" }, { outputLimitBytes: 1024, timeoutGraceMs: 100 }),
      );
      const spy = createSpyToolHandler({ output: { data: "small" } });
      const request = makeRequest("small-tool");

      const response = await mw.wrapToolCall?.(ctx, request, spy.handler);

      expect(response?.output).toEqual({ data: "small" });
      expect(response?.metadata?.truncated).toBeUndefined();
    });

    it("truncates output exceeding limit with metadata", async () => {
      // Set a very small limit to trigger truncation
      const mw = createSandboxMiddleware(
        makeConfig({ "big-tool": "sandbox" }, { outputLimitBytes: 10, timeoutGraceMs: 100 }),
      );
      const largeOutput = { data: "this is a string that is definitely longer than 10 bytes" };
      const spy = createSpyToolHandler({ output: largeOutput });
      const request = makeRequest("big-tool");

      const response = await mw.wrapToolCall?.(ctx, request, spy.handler);

      // Output should be a truncated string
      expect(typeof response?.output).toBe("string");
      expect((response?.output as string).endsWith("...[truncated]")).toBe(true);
      expect(response?.metadata?.truncated).toBe(true);
      expect(typeof response?.metadata?.originalBytes).toBe("number");
    });
  });

  describe("configuration", () => {
    it("applies perToolOverrides to resource limits", async () => {
      // Profile timeout = 50ms, but override gives 200ms. Grace = 10ms.
      // Handler takes 100ms — would timeout with profile (50+10=60) but not with override (200+10=210)
      const overrides = new Map([["slow-but-ok", { timeoutMs: 200 }]]);
      const mw = createSandboxMiddleware(
        makeConfig(
          { "slow-but-ok": "sandbox" },
          { perToolOverrides: overrides, timeoutGraceMs: 10 },
        ),
      );
      const handler = createDelayHandler(100);
      const request = makeRequest("slow-but-ok");

      const response = await mw.wrapToolCall?.(ctx, request, handler);
      expect(response?.output).toEqual({ result: "delayed" });
    });

    it("respects skipTiers config", async () => {
      const onMetrics = mock(
        (_toolId: string, _tier: TrustTier, _d: number, _b: number, _t: boolean) => {},
      );
      // Skip verified tier (not just promoted)
      const mw = createSandboxMiddleware(
        makeConfig(
          { "ver-tool": "verified" },
          { skipTiers: ["promoted", "verified"], onSandboxMetrics: onMetrics },
        ),
      );
      const spy = createSpyToolHandler({ output: { skipped: true } });
      const request = makeRequest("ver-tool");

      const response = await mw.wrapToolCall?.(ctx, request, spy.handler);

      expect(response?.output).toEqual({ skipped: true });
      // No metrics — skipped tier
      expect(onMetrics).toHaveBeenCalledTimes(0);
    });

    it("has name 'sandbox' and priority 200", () => {
      const mw = createSandboxMiddleware(makeConfig({}, { failClosedOnLookupError: false }));
      expect(mw.name).toBe("sandbox");
      expect(mw.priority).toBe(200);
    });
  });

  describe("signal threading", () => {
    it("threads signal to next handler via ToolRequest.signal", async () => {
      const mw = createSandboxMiddleware(
        makeConfig({ "sig-tool": "sandbox" }, { timeoutGraceMs: 5_000 }),
      );
      // let justified: captured from inside the handler
      let capturedSignal: AbortSignal | undefined;
      const handler: ToolHandler = async (request: ToolRequest): Promise<ToolResponse> => {
        capturedSignal = request.signal;
        return { output: { ok: true } };
      };
      const request = makeRequest("sig-tool");

      await mw.wrapToolCall?.(ctx, request, handler);

      // The handler should have received a signal (the sandbox controller's signal)
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
    });

    it("composes upstream signal with sandbox timeout", async () => {
      const mw = createSandboxMiddleware(
        makeConfig({ "compose-tool": "sandbox" }, { timeoutGraceMs: 5_000 }),
      );
      const upstreamController = new AbortController();
      // let justified: captured from inside the handler
      let capturedSignal: AbortSignal | undefined;
      const handler: ToolHandler = async (request: ToolRequest): Promise<ToolResponse> => {
        capturedSignal = request.signal;
        return { output: { ok: true } };
      };
      // Request with upstream signal
      const request: ToolRequest = {
        toolId: "compose-tool",
        input: { arg: "value" },
        signal: upstreamController.signal,
      };

      await mw.wrapToolCall?.(ctx, request, handler);

      // The composed signal should be present (AbortSignal.any)
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      // The composed signal is distinct from the upstream one (it wraps both)
      expect(capturedSignal).not.toBe(upstreamController.signal);
    });
  });

  describe("observability", () => {
    it("calls onSandboxError on timeout", async () => {
      const onError = mock((_toolId: string, _tier: TrustTier, _code: string, _msg: string) => {});
      const mw = createSandboxMiddleware(
        makeConfig({ "timeout-tool": "sandbox" }, { timeoutGraceMs: 10, onSandboxError: onError }),
      );
      const handler = createDelayHandler(500);
      const request = makeRequest("timeout-tool");

      try {
        await mw.wrapToolCall?.(ctx, request, handler);
      } catch {
        // expected
      }

      expect(onError).toHaveBeenCalledTimes(1);
      const call = onError.mock.calls.at(0);
      expect(call?.at(0)).toBe("timeout-tool");
      expect(call?.at(1)).toBe("sandbox");
      expect(call?.at(2)).toBe("TIMEOUT");
    });

    it("calls onSandboxMetrics for every sandboxed call", async () => {
      const onMetrics = mock(
        (_toolId: string, _tier: TrustTier, _d: number, _b: number, _t: boolean) => {},
      );
      const mw = createSandboxMiddleware(
        makeConfig(
          { "metric-tool": "sandbox" },
          { timeoutGraceMs: 100, onSandboxMetrics: onMetrics },
        ),
      );
      const spy = createSpyToolHandler({ output: { ok: true } });
      const request = makeRequest("metric-tool");

      await mw.wrapToolCall?.(ctx, request, spy.handler);

      expect(onMetrics).toHaveBeenCalledTimes(1);
      const call = onMetrics.mock.calls.at(0);
      expect(call?.at(0)).toBe("metric-tool");
      expect(call?.at(1)).toBe("sandbox");
      expect(typeof call?.at(2)).toBe("number");
      expect(typeof call?.at(3)).toBe("number");
      expect(call?.at(4)).toBe(false);
    });
  });

  describe("describeCapabilities", () => {
    it("is defined on the middleware", () => {
      const mw = createSandboxMiddleware(makeConfig({}, { failClosedOnLookupError: false }));
      expect(mw.describeCapabilities).toBeDefined();
    });

    it("returns label 'sandbox' and description containing 'sandboxing'", () => {
      const mw = createSandboxMiddleware(makeConfig({}, { failClosedOnLookupError: false }));
      const result = mw.describeCapabilities?.(ctx) as CapabilityFragment;
      expect(result.label).toBe("sandbox");
      expect(result.description).toContain("sandboxing");
    });
  });
});
