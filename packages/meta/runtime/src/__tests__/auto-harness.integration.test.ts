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

const permissiveVerifier = (() => async () => ({ ok: true as const, value: undefined })) as never;

describe("createRuntime autoHarness wiring", () => {
  test("rejects caller-supplied policy-cache when autoHarness is enabled", () => {
    const providedPolicyCache = { name: "policy-cache" } as never;

    expect(() =>
      createRuntime({
        middleware: [providedPolicyCache],
        requestApproval: async () => ({ kind: "allow" }),
        autoHarness: {
          forgeStore: {
            save: async () => ({ ok: true as const, value: undefined }),
            exists: async () => ({ ok: true as const, value: false }),
            remove: async () => ({ ok: true as const, value: undefined }),
          } as never,
          policyVerifier: permissiveVerifier,
          generate: async () => "candidate-code",
          verifyCandidate: async () => ({ ok: true, artifact: { id: "brick-0" } as never }),
          evaluatePolicy: async () => ({ ok: true, action: "allow" }),
          deployCandidate: async () => ({ ok: true }),
        },
      }),
    ).toThrow(/cannot enable `autoHarness`.*caller-supplied/);
  });

  test("rejects autoHarness without policyVerifier (cache cannot be populated)", () => {
    expect(() =>
      createRuntime({
        requestApproval: async () => ({ kind: "allow" }),
        autoHarness: {
          forgeStore: {
            save: async () => ({ ok: true as const, value: undefined }),
            exists: async () => ({ ok: true as const, value: false }),
            remove: async () => ({ ok: true as const, value: undefined }),
          } as never,
          notifier: { notify: () => {}, subscribe: () => () => {} },
          generate: async () => "candidate-code",
          verifyCandidate: async () => ({ ok: true, artifact: { id: "brick-x" } as never }),
          evaluatePolicy: async () => ({ ok: true, action: "allow" }),
          deployCandidate: async () => ({ ok: true }),
        },
      }),
    ).toThrow(/`autoHarness\.policyVerifier` is required/);
  });

  test("rejects autoHarness without notifier (cache cannot be invalidated)", () => {
    expect(() =>
      createRuntime({
        requestApproval: async () => ({ kind: "allow" }),
        autoHarness: {
          forgeStore: {
            save: async () => ({ ok: true as const, value: undefined }),
            exists: async () => ({ ok: true as const, value: false }),
            remove: async () => ({ ok: true as const, value: undefined }),
          } as never,
          policyVerifier: permissiveVerifier,
          generate: async () => "candidate-code",
          verifyCandidate: async () => ({ ok: true, artifact: { id: "brick-x" } as never }),
          evaluatePolicy: async () => ({ ok: true, action: "allow" }),
          deployCandidate: async () => ({ ok: true }),
        },
      }),
    ).toThrow(/`autoHarness\.notifier`.*required/);
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
        forgeStore: {
          save: async () => ({ ok: true as const, value: undefined }),
          exists: async () => ({ ok: true as const, value: false }),
          remove: async () => ({ ok: true as const, value: undefined }),
        } as never,
        policyVerifier: permissiveVerifier,
        notifier: { notify: () => {}, subscribe: () => () => {} },
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
        forgeStore: {
          save: async () => ({ ok: true as const, value: undefined }),
          exists: async () => ({ ok: true as const, value: false }),
          remove: async () => ({ ok: true as const, value: undefined }),
        } as never,
        policyVerifier: permissiveVerifier,
        notifier: { notify: () => {}, subscribe: () => () => {} },
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

  test("threads ownerAgentId from session lookup into synthesizeHarness session context", async () => {
    const captured: Array<{ readonly sessionId: string; readonly ownerAgentId?: string }> = [];

    const wrapped = wrapOnDemandWithAutoHarness(
      undefined,
      {
        synthesizeHarness: async (_signal, session) => {
          if (session !== undefined) {
            captured.push({
              sessionId: session.sessionId,
              ...(session.ownerAgentId !== undefined && { ownerAgentId: session.ownerAgentId }),
            });
          }
          return null;
        },
      },
      () => [
        {
          sessionId: "session-7",
          runId: "run-7",
          agentId: "agent-owner-7",
          scoped: {
            getSignals: () => [{ id: "sig-with-owner" }],
            dismiss: () => {},
          },
        },
      ],
    );

    wrapped(makeDemandSignal("sig-with-owner"));
    await Promise.resolve();
    await Promise.resolve();

    expect(captured).toEqual([{ sessionId: "session-7", ownerAgentId: "agent-owner-7" }]);
  });

  test("fails closed (drops signal) when sessionLookup is configured but no owner matches", async () => {
    const synthesizeCalls: string[] = [];

    const wrapped = wrapOnDemandWithAutoHarness(
      undefined,
      {
        synthesizeHarness: async (signal) => {
          synthesizeCalls.push(signal.id);
          return null;
        },
      },
      // Lookup configured but no entry owns the incoming signal id.
      () => [],
    );

    wrapped(makeDemandSignal("orphan-sig"));
    await Promise.resolve();
    await Promise.resolve();

    expect(synthesizeCalls).toEqual([]);
  });
});
