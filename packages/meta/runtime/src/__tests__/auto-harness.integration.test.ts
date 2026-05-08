import { describe, expect, test } from "bun:test";
import type { ForgeDemandSignal } from "@koi/core";
import { createRuntime, wrapOnDemandWithAutoHarness } from "../create-runtime.js";

const makeDemandSignal = (id: string): ForgeDemandSignal =>
  ({
    id,
    kind: "forge_demand",
    trigger: { kind: "repeated_failure", toolName: "search", count: 3 },
    confidence: 0.9,
    suggestedBrickKind: "middleware",
    context: {
      failureCount: 3,
      failedToolCalls: ["search: timeout"],
    },
    emittedAt: 1_700_000_000_000,
  }) as ForgeDemandSignal;

describe("createRuntime autoHarness wiring", () => {
  test("replaces caller-supplied policy-cache with stack-owned instance (single source of truth)", () => {
    const providedPolicyCache = { name: "policy-cache" } as never;

    const runtime = createRuntime({
      middleware: [providedPolicyCache],
      requestApproval: async () => ({ kind: "allow" }),
      autoHarness: {
        forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
        generate: async () => "candidate-code",
        verifyCandidate: async () => ({ ok: true, artifact: { id: "brick-0" } as never }),
        evaluatePolicy: async () => ({ ok: true, action: "allow" }),
        deployCandidate: async () => ({ ok: true }),
      },
    });

    // Caller's policy-cache is dropped from the live chain — the auto-harness
    // stack's own cache is the single source of truth, so registrations and
    // dispatch always agree. (Stub adapters skip live composition; the stack
    // middleware reference is still exposed via runtime.autoHarness.)
    expect(runtime.middleware).not.toContain(providedPolicyCache);
    expect(runtime.autoHarness).toBeDefined();
    expect(runtime.autoHarness?.middleware).not.toBe(providedPolicyCache);
  });

  test("exposes the autoHarness handle on stub adapters without composing intercept middleware", () => {
    // Stub adapters have no terminals; composing intercept-phase middleware
    // would throw. The runtime instead exposes the stack-owned middleware
    // reference on the handle so callers can drive synthesizeHarness and
    // policy-cache register out-of-band, even though no live dispatch path
    // consults the cache.
    const runtime = createRuntime({
      requestApproval: async () => ({ kind: "allow" }),
      autoHarness: {
        forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
        generate: async () => "candidate-code",
        verifyCandidate: async () => ({ ok: true, artifact: { id: "brick-1" } as never }),
        evaluatePolicy: async () => ({ ok: true, action: "allow" }),
        deployCandidate: async () => ({ ok: true }),
      },
    });

    expect(runtime.autoHarness).toBeDefined();
    expect(runtime.autoHarness?.middleware.name).toBe("policy-cache");
    expect(typeof runtime.autoHarness?.synthesizeHarness).toBe("function");
  });

  test("does not deploy when runtime approval denies the request", async () => {
    let deployed = false;
    const runtime = createRuntime({
      requestApproval: async () => ({ kind: "deny", reason: "no" }),
      autoHarness: {
        forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
        generate: async () => "candidate-code",
        verifyCandidate: async () => ({ ok: true, artifact: { id: "brick-2" } as never }),
        evaluatePolicy: async () => ({ ok: true, action: "allow" }),
        deployCandidate: async () => {
          deployed = true;
          return { ok: true };
        },
      },
    });

    const result = await runtime.autoHarness?.synthesizeHarness({ id: "sig-4" } as never);
    expect(result).toBeNull();
    expect(deployed).toBe(false);
  });
});

describe("wrapOnDemandWithAutoHarness", () => {
  test("forwards to caller's onDemand and drives synthesizeHarness", async () => {
    const callerCalls: string[] = [];
    const synthesizeCalls: string[] = [];

    const wrapped = wrapOnDemandWithAutoHarness(
      (signal) => {
        callerCalls.push(signal.id);
      },
      {
        synthesizeHarness: async (signal) => {
          synthesizeCalls.push(signal.id);
          return null;
        },
      },
    );

    wrapped(makeDemandSignal("auto-1"));
    // synthesizeHarness is invoked async; let microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(callerCalls).toEqual(["auto-1"]);
    expect(synthesizeCalls).toEqual(["auto-1"]);
  });

  test("invokes synthesizeHarness when caller's onDemand is undefined", async () => {
    const synthesizeCalls: string[] = [];

    const wrapped = wrapOnDemandWithAutoHarness(undefined, {
      synthesizeHarness: async (signal) => {
        synthesizeCalls.push(signal.id);
        return null;
      },
    });

    wrapped(makeDemandSignal("auto-2"));
    await Promise.resolve();
    await Promise.resolve();

    expect(synthesizeCalls).toEqual(["auto-2"]);
  });

  test("swallows synthesizeHarness rejections", async () => {
    const wrapped = wrapOnDemandWithAutoHarness(undefined, {
      synthesizeHarness: async () => {
        throw new Error("kaboom");
      },
    });

    expect(() => wrapped(makeDemandSignal("auto-3"))).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
