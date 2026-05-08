import { describe, expect, test } from "bun:test";
import type { BrickArtifact, ForgeDemandSignal, StoreChangeNotifier } from "@koi/core";
import type {} from "./index.js";
import {
  type AutoHarnessDeployResult,
  type AutoHarnessError,
  type AutoHarnessEvent,
  type AutoHarnessPolicyResult,
  type AutoHarnessVerificationResult,
  createAutoHarnessStack,
} from "./index.js";

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
    expect(stack.policyCacheHandle.register()).toEqual({ ok: true, value: undefined });
    expect(stack.policyCacheHandle.size()).toBe(0);
    expect(stack.policyCacheHandle.evict("brick-1" as never)).toBeUndefined();
    expect(stack.policyCacheHandle.dispose()).toBeUndefined();
    expect(stack.policyCacheMiddleware.describeCapabilities({} as never)).toBeUndefined();
    expect(typeof stack.synthesizeHarness).toBe("function");
    expect(typeof stack.resetSession).toBe("function");
    expect(stack.maxSynthesesPerSession).toBeGreaterThan(0);
  });

  test("accepts an omitted notifier and exposes the default session synthesis cap", async () => {
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "export function createMiddleware() {}",
      verifyCandidate: async (_signal, _code): Promise<AutoHarnessVerificationResult> => ({
        ok: true,
        artifact,
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
    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBe(artifact);
  });

  test("resetSession reopens the per-session synthesis counter and emits events", async () => {
    const events: AutoHarnessEvent[] = [];
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier: makeNotifier(),
      generate: async () => "export function createMiddleware() {}",
      verifyCandidate: async (_signal, _code): Promise<AutoHarnessVerificationResult> => ({
        ok: true,
        artifact,
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
    await expect(stack.synthesizeHarness(signal)).resolves.toBe(artifact);
    await expect(stack.synthesizeHarness(signal)).resolves.toBe(artifact);
    await expect(stack.synthesizeHarness(signal)).resolves.toBe(artifact);
    await expect(stack.synthesizeHarness(signal)).resolves.toBeNull();
    stack.resetSession();
    await expect(stack.synthesizeHarness(signal)).resolves.toBe(artifact);
    expect(events.some((event) => event.kind === "session.reset")).toBe(true);
    expect(events.some((event) => event.kind === "deployment.succeeded")).toBe(true);
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

  test("halts before deployment when verification fails", async () => {
    let deployed = false;
    let verifyCalls = 0;
    let policyCalls = 0;
    let approvalCalls = 0;
    const stack = createAutoHarnessStack({
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => {
        verifyCalls += 1;
        return {
          ok: false,
          artifact: null,
          reason: "bad verifier result",
        };
      },
      evaluatePolicy: async () => {
        policyCalls += 1;
        return { ok: true, action: "allow" };
      },
      requestDeploymentApproval: async () => {
        approvalCalls += 1;
        return true;
      },
      deployCandidate: async () => {
        deployed = true;
        return { ok: true };
      },
    });

    const result = await stack.synthesizeHarness({ id: "sig-1" } as never);
    expect(result).toBeNull();
    expect(verifyCalls).toBe(1);
    expect(policyCalls).toBe(0);
    expect(approvalCalls).toBe(0);
    expect(deployed).toBe(false);
  });

  test("halts before deployment when policy blocks", async () => {
    let deployed = false;
    let verifyCalls = 0;
    let policyCalls = 0;
    let approvalCalls = 0;
    const artifact = { id: "brick-1", kind: "middleware" } as never;
    const stack = createAutoHarnessStack({
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => {
        verifyCalls += 1;
        return { ok: true, artifact };
      },
      evaluatePolicy: async () => {
        policyCalls += 1;
        return {
          ok: false,
          action: "block",
          reason: "policy violation",
        };
      },
      requestDeploymentApproval: async () => {
        approvalCalls += 1;
        return true;
      },
      deployCandidate: async () => {
        deployed = true;
        return { ok: true };
      },
    });

    const result = await stack.synthesizeHarness({ id: "sig-2" } as never);
    expect(result).toBeNull();
    expect(verifyCalls).toBe(1);
    expect(policyCalls).toBe(1);
    expect(approvalCalls).toBe(0);
    expect(deployed).toBe(false);
  });

  test("requires explicit approval before deployment", async () => {
    let deployed = false;
    let verifyCalls = 0;
    let policyCalls = 0;
    let approvalCalls = 0;
    const artifact = { id: "brick-2", kind: "middleware" } as never;
    const stack = createAutoHarnessStack({
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => {
        verifyCalls += 1;
        return { ok: true, artifact };
      },
      evaluatePolicy: async () => {
        policyCalls += 1;
        return { ok: true, action: "allow" };
      },
      requestDeploymentApproval: async () => {
        approvalCalls += 1;
        return false;
      },
      deployCandidate: async () => {
        deployed = true;
        return { ok: true };
      },
    });

    const result = await stack.synthesizeHarness({ id: "sig-3" } as never);
    expect(result).toBeNull();
    expect(verifyCalls).toBe(1);
    expect(policyCalls).toBe(1);
    expect(approvalCalls).toBe(1);
    expect(deployed).toBe(false);
  });

  test("reports generate failures and returns null", async () => {
    const errors: AutoHarnessError[] = [];
    const stack = createAutoHarnessStack({
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => {
        throw new Error("generator offline");
      },
      verifyCandidate: async () => ({
        ok: true,
        artifact: makeArtifact(),
      }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true }),
      onError: (error) => errors.push(error),
    });

    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe("generate");
    expect(errors[0]?.message).toBe("generate failed");
  });

  test("reports deployment failures without consuming the session cap", async () => {
    const errors: AutoHarnessError[] = [];
    const artifact = makeArtifact();
    let deploymentAttempts = 0;
    const stack = createAutoHarnessStack({
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => {
        deploymentAttempts += 1;
        if (deploymentAttempts === 1) {
          return {
            ok: false,
            error: {
              stage: "deploy",
              message: "deploy failed",
            },
          };
        }
        return { ok: true };
      },
      maxSynthesesPerSession: 1,
      onError: (error) => errors.push(error),
    });

    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBeNull();
    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBe(artifact);
    expect(deploymentAttempts).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe("deploy");
    expect(errors[0]?.message).toBe("deploy failed");
  });
});
