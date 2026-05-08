import { describe, expect, test } from "bun:test";
import type { BrickArtifact, ForgeDemandSignal, StoreChangeNotifier } from "@koi/core";
import { createAutoHarnessStack } from "./create-auto-harness-stack.js";
import type {
  AutoHarnessDeployResult,
  AutoHarnessEvent,
  AutoHarnessPolicyResult,
  AutoHarnessVerificationResult,
} from "./types.js";

const makeNotifier = (): StoreChangeNotifier => ({
  notify: () => {},
  subscribe: () => () => {},
});

const makeSignal = (): ForgeDemandSignal =>
  ({
    id: "demand-1",
    kind: "forge_demand",
    trigger: { kind: "repeated_failure", toolName: "search", count: 3 },
    confidence: 0.9,
    suggestedBrickKind: "middleware",
    context: {
      failureCount: 3,
      failedToolCalls: ["search: timeout", "search: timeout", "search: malformed input"],
    },
    emittedAt: 1_700_000_000_000,
  }) as ForgeDemandSignal;

const makeArtifact = (): BrickArtifact =>
  ({
    kind: "middleware",
    id: "brick-1",
    name: "auto-harness-search",
  }) as BrickArtifact;

describe("createAutoHarnessStack", () => {
  test("returns policy-cache middleware, synthesis callback, and session controls", () => {
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier: makeNotifier(),
      generate: async () => "export function createMiddleware() {}",
      verifyCandidate: async (_signal, _code): Promise<AutoHarnessVerificationResult> => ({
        ok: true,
        artifact: makeArtifact(),
      }),
      evaluatePolicy: async (_artifact, _signal): Promise<AutoHarnessPolicyResult> => ({
        ok: true,
        action: "allow",
      }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (_artifact, _signal): Promise<AutoHarnessDeployResult> => ({
        ok: true,
      }),
    });

    expect(stack.policyCacheMiddleware.name).toBe("policy-cache");
    expect(stack.policyCacheHandle.middleware).toBe(stack.policyCacheMiddleware);
    expect(typeof stack.policyCacheHandle.register).toBe("function");
    expect(typeof stack.policyCacheHandle.evict).toBe("function");
    expect(typeof stack.policyCacheHandle.size).toBe("function");
    expect(typeof stack.policyCacheHandle.dispose).toBe("function");
    expect(stack.policyCacheMiddleware.describeCapabilities({} as never)).toBeUndefined();
    expect(stack.policyCacheHandle.register({} as never)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(stack.policyCacheHandle.size()).toBe(0);
    stack.policyCacheHandle.evict("brick-1");
    stack.policyCacheHandle.dispose();
    expect(typeof stack.synthesizeHarness).toBe("function");
    expect(typeof stack.resetSession).toBe("function");
    expect(stack.maxSynthesesPerSession).toBeGreaterThan(0);
  });

  test("accepts an omitted notifier and exposes the default session synthesis cap", async () => {
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "export function createMiddleware() {}",
      verifyCandidate: async (_signal, _code): Promise<AutoHarnessVerificationResult> => ({
        ok: true,
        artifact: makeArtifact(),
      }),
      evaluatePolicy: async (_artifact, _signal): Promise<AutoHarnessPolicyResult> => ({
        ok: true,
        action: "allow",
      }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (_artifact, _signal): Promise<AutoHarnessDeployResult> => ({
        ok: true,
      }),
    });

    expect(stack.maxSynthesesPerSession).toBe(3);
    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBeNull();
  });

  test("resetSession reopens the per-session synthesis counter and emits events", async () => {
    const events: AutoHarnessEvent[] = [];
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier: makeNotifier(),
      generate: async () => "export function createMiddleware() {}",
      verifyCandidate: async (_signal, _code): Promise<AutoHarnessVerificationResult> => ({
        ok: true,
        artifact: makeArtifact(),
      }),
      evaluatePolicy: async (_artifact, _signal): Promise<AutoHarnessPolicyResult> => ({
        ok: true,
        action: "allow",
      }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (_artifact, _signal): Promise<AutoHarnessDeployResult> => ({
        ok: true,
      }),
      onEvent: (event) => events.push(event),
    });

    const signal = makeSignal();
    await expect(stack.synthesizeHarness(signal)).resolves.toBeNull();
    await expect(stack.synthesizeHarness(signal)).resolves.toBeNull();
    await expect(stack.synthesizeHarness(signal)).resolves.toBeNull();
    await expect(stack.synthesizeHarness(signal)).resolves.toBeNull();
    stack.resetSession();
    await expect(stack.synthesizeHarness(signal)).resolves.toBeNull();
    expect(events.some((event) => event.type === "session-reset")).toBe(true);
  });

  test("rejects non-positive maxSynthesesPerSession", () => {
    expect(() =>
      createAutoHarnessStack({
        forgeStore: {
          save: async () => ({ ok: true as const, value: undefined }),
        } as never,
        notifier: makeNotifier(),
        generate: async () => "export function createMiddleware() {}",
        verifyCandidate: async (_signal, _code): Promise<AutoHarnessVerificationResult> => ({
          ok: true,
          artifact: makeArtifact(),
        }),
        evaluatePolicy: async (_artifact, _signal): Promise<AutoHarnessPolicyResult> => ({
          ok: true,
          action: "allow",
        }),
        requestDeploymentApproval: async () => true,
        deployCandidate: async (_artifact, _signal): Promise<AutoHarnessDeployResult> => ({
          ok: true,
        }),
        maxSynthesesPerSession: 0,
      }),
    ).toThrow(/maxSynthesesPerSession/);
  });
});
