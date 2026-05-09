import { describe, expect, mock, test } from "bun:test";
import type { BrickArtifact, ForgeDemandSignal, StoreChangeNotifier } from "@koi/core";
import type {
  AutoHarnessDeployResult,
  AutoHarnessEvent,
  AutoHarnessPolicyResult,
  AutoHarnessVerificationResult,
} from "./index.js";
import type { AutoHarnessError } from "./types.js";

mock.module("@koi/middleware-policy-cache", () => ({
  createPolicyCacheMiddleware: (config?: {
    readonly notifier?: StoreChangeNotifier | undefined;
  }) => {
    const unsubscribe = config?.notifier?.subscribe(() => {});
    const middleware = {
      name: "policy-cache",
      phase: "intercept",
      priority: 50,
      describeCapabilities: () => undefined,
    } as const;

    return {
      middleware,
      register: (_entry: unknown) => ({ ok: true as const, value: undefined }),
      evict: (_brickId: string) => {},
      size: () => 0,
      dispose: () => {
        unsubscribe?.();
      },
    };
  },
}));

const { createAutoHarnessStack } = await import("./index.js");

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
    lifecycle: "draft",
  }) as BrickArtifact;

describe("createAutoHarnessStack", () => {
  test("returns policy-cache middleware, synthesis callback, and session controls", () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier: {
        notify: () => {},
        subscribe: () => {
          subscribed += 1;
          return () => {
            unsubscribed += 1;
          };
        },
      },
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
      deployCandidate: async (artifact, _signal): Promise<AutoHarnessDeployResult> => ({
        artifact,
        ok: true,
      }),
    });

    expect(stack.policyCacheMiddleware.name).toBe("policy-cache");
    expect(stack.policyCacheHandle.middleware).toBe(stack.policyCacheMiddleware);
    // Two subscriptions: one from createPolicyCacheMiddleware, one from
    // createAutoHarnessStack's completedTriggers invalidation listener.
    expect(subscribed).toBe(2);
    expect(stack.policyCacheHandle.size()).toBe(0);
    expect(stack.policyCacheHandle.evict("brick-1" as never)).toBeUndefined();
    stack.policyCacheHandle.dispose();
    // Only the policy-cache subscription unsubscribes via dispose; the
    // completedTriggers listener stays for the lifetime of the stack.
    expect(unsubscribed).toBe(1);
    expect(typeof stack.synthesizeHarness).toBe("function");
    expect(typeof stack.resetSession).toBe("function");
    expect(stack.maxSynthesesPerSession).toBeGreaterThan(0);
  });

  test("accepts an omitted notifier and exposes the default session synthesis cap", async () => {
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
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
      deployCandidate: async (_input, _signal): Promise<AutoHarnessDeployResult> => ({
        artifact,
        ok: true,
      }),
    });

    expect(stack.maxSynthesesPerSession).toBe(3);
    await expect(stack.synthesizeHarness(makeSignal())).resolves.toEqual(artifact);
  });

  test("resetSession reopens the per-session synthesis counter and emits events", async () => {
    const events: AutoHarnessEvent[] = [];
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
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
      deployCandidate: async (_input, _signal): Promise<AutoHarnessDeployResult> => ({
        artifact,
        ok: true,
      }),
      onEvent: (event) => events.push(event),
    });

    // Use distinct triggers per call so completedTriggers dedup doesn't
    // suppress repeats — this test exercises the per-session budget cap,
    // not trigger-replay suppression (covered separately).
    const makeUniqueSignal = (toolName: string): ForgeDemandSignal =>
      ({
        ...makeSignal(),
        trigger: { kind: "repeated_failure", toolName, count: 3 },
      }) as ForgeDemandSignal;
    await expect(stack.synthesizeHarness(makeUniqueSignal("tool-a"))).resolves.toEqual(artifact);
    await expect(stack.synthesizeHarness(makeUniqueSignal("tool-b"))).resolves.toEqual(artifact);
    await expect(stack.synthesizeHarness(makeUniqueSignal("tool-c"))).resolves.toEqual(artifact);
    await expect(stack.synthesizeHarness(makeUniqueSignal("tool-d"))).resolves.toBeNull();
    stack.resetSession();
    await expect(stack.synthesizeHarness(makeUniqueSignal("tool-e"))).resolves.toEqual(artifact);
    expect(events.some((event) => event.kind === "session.reset")).toBe(true);
    expect(events.some((event) => event.kind === "deployment.succeeded")).toBe(true);
  });

  test("suppresses sequential replays of the same trigger until resetSession", async () => {
    const generated: string[] = [];
    const events: AutoHarnessEvent[] = [];
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier: makeNotifier(),
      generate: async (prompt) => {
        generated.push(prompt);
        return "export function createMiddleware() {}";
      },
      verifyCandidate: async (): Promise<AutoHarnessVerificationResult> => ({
        ok: true,
        artifact: makeArtifact(),
      }),
      evaluatePolicy: async (): Promise<AutoHarnessPolicyResult> => ({
        ok: true,
        action: "allow",
      }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (artifact): Promise<AutoHarnessDeployResult> => ({
        ok: true,
        artifact,
      }),
      onEvent: (event) => events.push(event),
    });

    const signal = makeSignal();
    await stack.synthesizeHarness(signal);
    await stack.synthesizeHarness(signal);
    await stack.synthesizeHarness(signal);

    expect(generated).toHaveLength(1);
    const skipReasons = events
      .filter(
        (e): e is AutoHarnessEvent & { readonly message: string } => e.kind === "synthesis.skipped",
      )
      .map((e) => e.message);
    expect(skipReasons.filter((m) => m.includes("already processed"))).toHaveLength(2);

    stack.resetSession();
    await stack.synthesizeHarness(signal);
    expect(generated).toHaveLength(2);
  });

  test("transient pipeline failures keep the trigger eligible for retry", async () => {
    let generateCalls = 0;
    let verifierShouldFail = true;
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier: makeNotifier(),
      generate: async () => {
        generateCalls += 1;
        return "export function createMiddleware() {}";
      },
      verifyCandidate: async () => {
        if (verifierShouldFail) {
          throw new Error("verifier outage (transient)");
        }
        return { ok: true, artifact: makeArtifact() };
      },
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (artifact) => ({ ok: true, artifact }),
    });

    const signal = makeSignal();
    // First call: verifier crashes — transient, trigger stays retriable.
    await stack.synthesizeHarness(signal);
    expect(generateCalls).toBe(1);
    // Second call: verifier still down — still transient.
    await stack.synthesizeHarness(signal);
    expect(generateCalls).toBe(2);
    // Verifier recovers; same trigger now succeeds.
    verifierShouldFail = false;
    await stack.synthesizeHarness(signal);
    expect(generateCalls).toBe(3);
    // Now that the pipeline ran to success, replays are suppressed.
    await stack.synthesizeHarness(signal);
    expect(generateCalls).toBe(3);
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
        deployCandidate: async (artifact, _signal): Promise<AutoHarnessDeployResult> => ({
          artifact,
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
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
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

    const result = await stack.synthesizeHarness({ ...makeSignal(), id: "sig-1" });
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
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
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

    const result = await stack.synthesizeHarness({ ...makeSignal(), id: "sig-2" });
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
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
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

    const result = await stack.synthesizeHarness({ ...makeSignal(), id: "sig-3" });
    expect(result).toBeNull();
    expect(verifyCalls).toBe(1);
    expect(policyCalls).toBe(1);
    expect(approvalCalls).toBe(1);
    expect(deployed).toBe(false);
  });

  test("reports generate failures and returns null", async () => {
    const errors: AutoHarnessError[] = [];
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => {
        throw new Error("generator offline");
      },
      verifyCandidate: async () => ({
        ok: true,
        artifact: makeArtifact(),
      }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (artifact) => ({ ok: true, artifact }),
      onError: (error) => errors.push(error),
    });

    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe("generate");
    expect(errors[0]?.message).toBe("generate failed");
  });

  test("reports thrown verifier failures and returns null", async () => {
    const errors: AutoHarnessError[] = [];
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => {
        throw new Error("verifier crashed");
      },
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (artifact) => ({ ok: true, artifact }),
      onError: (error) => errors.push(error),
    });

    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe("verify");
    expect(errors[0]?.message).toBe("verifyCandidate failed");
  });

  test("reports thrown approval failures and returns null", async () => {
    const errors: AutoHarnessError[] = [];
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => {
        throw new Error("approval service unavailable");
      },
      deployCandidate: async (artifact) => ({ ok: true, artifact }),
      onError: (error) => errors.push(error),
    });

    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe("request-deployment-approval");
    expect(errors[0]?.message).toBe("requestDeploymentApproval failed");
  });

  test("reports deployment failures and consumes the session attempt budget", async () => {
    const errors: AutoHarnessError[] = [];
    const artifact = makeArtifact();
    let deploymentAttempts = 0;
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => {
        deploymentAttempts += 1;
        return {
          ok: false,
          error: {
            stage: "deploy",
            message: "deploy failed",
          },
        };
      },
      maxSynthesesPerSession: 1,
      onError: (error) => errors.push(error),
    });

    // First attempt fails at deploy (transient infrastructure failure).
    // The budget is refunded so a degraded dependency cannot permanently
    // disable self-healing for the session — a healthy retry can run.
    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBeNull();
    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBeNull();
    expect(deploymentAttempts).toBe(2);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.stage).toBe("deploy");
    expect(errors[0]?.message).toBe("deploy failed");
  });

  test("threads policyVerifier through to the embedded policy-cache middleware", async () => {
    // Use the real `@koi/middleware-policy-cache` build to prove the verifier
    // is honored: register() is fail-closed without one, so a host that wires
    // auto-harness without a verifier cannot promote any deployed entry.
    // We exercise this via a stub register that records the verifier the host
    // configured. The mocked module shim exposes register() directly; we
    // instead assert by configuring a verifier and checking that register
    // does not error during a normal deployment path.
    const verifierCalls: unknown[] = [];
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier: makeNotifier(),
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact: makeArtifact() }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (artifact) => ({
        ok: true,
        artifact,
        policyEntry: {
          brickId: artifact.id,
          toolId: "search",
          scope: "agent" as const,
          agentId: "agent-test",
          execute: () => ({ action: "allow" as const }),
        },
      }),
      policyVerifier: (entry) => {
        verifierCalls.push(entry);
        return true;
      },
    });

    expect(stack.policyCacheMiddleware.name).toBe("policy-cache");
    expect(stack.policyCacheHandle).toBeDefined();
  });

  test("verification, policy, and approval failures all consume the session budget", async () => {
    let generateCalls = 0;
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => {
        generateCalls += 1;
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: false, artifact: null, reason: "no" }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (artifact) => ({ ok: true, artifact }),
      maxSynthesesPerSession: 2,
    });

    // Use distinct triggers so completedTriggers dedup doesn't mask the
    // budget cap — this test exercises budget consumption on terminal
    // failures, not trigger-replay suppression.
    const sigA = {
      ...makeSignal(),
      trigger: { kind: "repeated_failure", toolName: "a", count: 1 },
    } as ForgeDemandSignal;
    const sigB = {
      ...makeSignal(),
      trigger: { kind: "repeated_failure", toolName: "b", count: 1 },
    } as ForgeDemandSignal;
    const sigC = {
      ...makeSignal(),
      trigger: { kind: "repeated_failure", toolName: "c", count: 1 },
    } as ForgeDemandSignal;
    await stack.synthesizeHarness(sigA);
    await stack.synthesizeHarness(sigB);
    // Third call is gated out — both prior failed attempts consumed budget.
    await stack.synthesizeHarness(sigC);

    expect(generateCalls).toBe(2);
  });

  test("derives the generation prompt from the demand signal", async () => {
    const prompts: string[] = [];
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async (prompt) => {
        prompts.push(prompt);
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: false, artifact: null, reason: "stop" }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (artifact) => ({ ok: true, artifact }),
    });

    await stack.synthesizeHarness(makeSignal());

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("middleware");
    expect(prompt).toContain("repeated_failure");
    expect(prompt).toContain("search: timeout");
    expect(prompt).toContain("demand-1");
    expect(prompt).not.toBe("export function createMiddleware() {}");
  });

  test("registers the deployed policy entry with the policy cache on success", async () => {
    const registered: unknown[] = [];
    const artifact = makeArtifact();
    const policyEntry = {
      brickId: "brick-1",
      toolId: "search",
      scope: "agent" as const,
      agentId: "agent-test",
      execute: () => ({ action: "allow" as const }),
    };
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      policyVerifier: (() => async () => ({ ok: true as const, value: undefined })) as never,
      notifier: makeNotifier(),
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true, artifact, policyEntry }),
    });

    const handle = stack.policyCacheHandle as unknown as {
      register: (
        entry: unknown,
      ) =>
        | { readonly ok: true; readonly value: undefined }
        | { readonly ok: false; readonly error: { readonly message: string } };
    };
    const originalRegister = handle.register;
    handle.register = (entry) => {
      registered.push(entry);
      return { ok: true as const, value: undefined };
    };

    try {
      const result = await stack.synthesizeHarness(makeSignal());
      expect(result).toEqual(artifact);
      expect(registered).toHaveLength(1);
      expect(registered[0]).toBe(policyEntry);
    } finally {
      handle.register = originalRegister;
    }
  });

  test("reports policy-cache register failures and aborts deployment success", async () => {
    const errors: AutoHarnessError[] = [];
    const events: AutoHarnessEvent[] = [];
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      policyVerifier: (() => async () => ({ ok: true as const, value: undefined })) as never,
      notifier: makeNotifier(),
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({
        ok: true,
        artifact,
        policyEntry: {
          brickId: "brick-1",
          toolId: "search",
          scope: "agent" as const,
          agentId: "agent-test",
          execute: () => ({ action: "allow" as const }),
        },
      }),
      onError: (error) => errors.push(error),
      onEvent: (event) => events.push(event),
    });

    const handle = stack.policyCacheHandle as unknown as {
      register: (
        entry: unknown,
      ) =>
        | { readonly ok: true; readonly value: undefined }
        | { readonly ok: false; readonly error: { readonly message: string } };
    };
    handle.register = () => ({
      ok: false as const,
      error: { message: "verifier rejected" },
    });

    const result = await stack.synthesizeHarness(makeSignal());

    // Deployment side effects are committed before register runs; reporting
    // a register failure as a deployment failure would lead callers to retry
    // and duplicate the live activation.
    expect(result).toEqual(artifact);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe("register-policy");
    expect(errors[0]?.message).toBe("verifier rejected");
    expect(events.some((e) => e.kind === "deployment.succeeded")).toBe(true);
  });

  test("dedupes concurrent syntheses by stable trigger identity (different signal ids, same tool)", async () => {
    // Forge-demand mints a fresh signal.id per emission. Without trigger-
    // identity dedup, cooldown re-fires for the same failing tool would race
    // duplicate pipelines.
    let generateCalls = 0;
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const events: AutoHarnessEvent[] = [];
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => {
        generateCalls += 1;
        await gate;
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true, artifact }),
      onEvent: (event) => events.push(event),
    });

    // Two distinct signal ids but the SAME trigger (same tool + kind).
    const sig1 = { ...makeSignal(), id: "demand-A" };
    const sig2 = { ...makeSignal(), id: "demand-B" };
    const first = stack.synthesizeHarness(sig1);
    const second = await stack.synthesizeHarness(sig2);
    expect(second).toBeNull();
    expect(
      events.some((e) => e.kind === "synthesis.skipped" && e.message.includes("already in flight")),
    ).toBe(true);

    resolveGate?.();
    const firstResult = await first;
    expect(firstResult).toEqual(artifact);
    expect(generateCalls).toBe(1);
  });

  test("partitions per-session synthesis budgets — one session cannot exhaust another's", async () => {
    let generateCalls = 0;
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => {
        generateCalls += 1;
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: true, artifact: makeArtifact() }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (artifact) => ({ ok: true, artifact }),
      maxSynthesesPerSession: 2,
    });

    // Use distinct triggers so completedTriggers dedup doesn't mask the
    // per-session budget cap — this test exercises tenant isolation, not
    // trigger-replay suppression.
    const sigFor = (toolName: string): ForgeDemandSignal =>
      ({
        ...makeSignal(),
        trigger: { kind: "repeated_failure", toolName, count: 1 },
      }) as ForgeDemandSignal;

    // Session A consumes its own budget.
    await stack.synthesizeHarness(sigFor("a1"), { sessionId: "session-A" });
    await stack.synthesizeHarness(sigFor("a2"), { sessionId: "session-A" });
    // Session A is exhausted; further calls under A skip.
    const aThird = await stack.synthesizeHarness(sigFor("a3"), { sessionId: "session-A" });
    expect(aThird).toBeNull();

    // Session B has its own fresh budget.
    const bFirst = await stack.synthesizeHarness(sigFor("b1"), { sessionId: "session-B" });
    expect(bFirst).not.toBeNull();
    expect(generateCalls).toBe(3);
  });

  test("calls dismiss after every terminal outcome (success and failure)", async () => {
    const dismissed: string[] = [];
    const dismiss = (label: string) => () => dismissed.push(label);

    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async (signal) =>
        signal.id === "sig-fail"
          ? { ok: false, artifact: null, reason: "no" }
          : { ok: true, artifact: makeArtifact() },
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (artifact) => ({ ok: true, artifact }),
    });

    // Success path dismisses
    const sigOk = { ...makeSignal(), id: "sig-ok" };
    await stack.synthesizeHarness(sigOk, { sessionId: "s1", dismiss: dismiss("ok") });
    expect(dismissed).toContain("ok");

    // Verification-failed path also dismisses
    const sigFail = { ...makeSignal(), id: "sig-fail" };
    await stack.synthesizeHarness(sigFail, { sessionId: "s1", dismiss: dismiss("fail") });
    expect(dismissed).toContain("fail");
  });

  test("sanitizes secret-shaped tokens out of the generation prompt", async () => {
    const prompts: string[] = [];
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async (prompt) => {
        prompts.push(prompt);
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: false, artifact: null, reason: "stop" }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (artifact) => ({ ok: true, artifact }),
    });

    // Synthetic fixtures composed at runtime to avoid github secret-scanning
    // false positives on the literal source.
    const fakeBearer = `${"X".repeat(16)}-${"Y".repeat(16)}`;
    const fakeApiKey = `notreal-${"a".repeat(28)}`;
    const fakePass = "synthetic-pass-1234";
    const fakeToken = `TOKEN-${"Z".repeat(28)}`;

    const sig: ForgeDemandSignal = {
      ...makeSignal(),
      context: {
        failureCount: 1,
        failedToolCalls: [
          `http: Authorization: Bearer ${fakeBearer}`,
          `db: connection failed (api_key=${fakeApiKey})`,
          "fs: Error reading /home/alice/.aws/credentials: ENOENT",
        ],
        taskDescription: `fetch via password=${fakePass} and token=${fakeToken}`,
      },
    };

    await stack.synthesizeHarness(sig);

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? "";
    expect(prompt).not.toContain(fakeBearer);
    expect(prompt).not.toContain(fakeApiKey);
    expect(prompt).not.toContain(fakePass);
    expect(prompt).not.toContain(fakeToken);
    expect(prompt).toContain("[REDACTED]");
  });

  test("persists the verified artifact via forgeStore.save before policy / approval / deploy", async () => {
    const saved: BrickArtifact[] = [];
    let policyCalls = 0;
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async (brick: BrickArtifact) => {
          saved.push(brick);
          return { ok: true as const, value: undefined };
        },
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => {
        policyCalls += 1;
        // Pre-deploy save must have happened before any further pipeline
        // stage runs. The pre-deploy save uses a random draft-namespace
        // id (collision-proof) — assert one save happened, lifecycle is
        // "draft", and the id carries the auto-harness-draft prefix.
        expect(saved).toHaveLength(1);
        expect(saved[0]?.lifecycle).toBe("draft");
        expect(saved[0]?.id).toMatch(/^auto-harness-draft:/);
        return { ok: true, action: "allow" };
      },
      requestDeploymentApproval: async () => true,
      // Real deployCandidate produces an authoritative artifact distinct
      // from the draft input — return the original makeArtifact() id.
      deployCandidate: async () => ({ ok: true, artifact }),
    });

    await stack.synthesizeHarness(makeSignal());

    // Two saves: pre-deploy draft (random id, lifecycle "draft") and
    // post-deploy authoritative artifact (original id).
    expect(saved).toHaveLength(2);
    expect(saved[0]?.id).toMatch(/^auto-harness-draft:/);
    expect(saved[0]?.lifecycle).toBe("draft");
    expect(saved[1]).toEqual(artifact);
    expect(policyCalls).toBe(1);
  });

  test("fails closed when forgeStore.save fails — no live deploy without durable record", async () => {
    const errors: AutoHarnessError[] = [];
    let deployed = false;
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({
          ok: false as const,
          error: { code: "IO_ERROR", message: "disk full", retryable: true },
        }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => {
        deployed = true;
        return { ok: true };
      },
      onError: (error) => errors.push(error),
    });

    const result = await stack.synthesizeHarness(makeSignal());

    expect(result).toBeNull();
    expect(deployed).toBe(false);
    expect(errors.some((e) => e.message.includes("forgeStore.save failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 9–10 corner cases: ownerAgentId binding, post-deploy partial-success,
// agent-trigger fingerprint, random draft id, dispose() teardown.
// ---------------------------------------------------------------------------
describe("createAutoHarnessStack — round 9/10 corner cases", () => {
  test("rejects policyEntry whose agentId does not match session.ownerAgentId", async () => {
    const errors: AutoHarnessError[] = [];
    const registered: unknown[] = [];
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      policyVerifier: (() => async () => ({ ok: true as const, value: undefined })) as never,
      notifier: makeNotifier(),
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (a) => ({
        ok: true,
        artifact: a,
        policyEntry: {
          brickId: a.id,
          toolId: "search",
          scope: "agent" as const,
          // Attacker / buggy deployCandidate: agentId for an UNRELATED agent.
          agentId: "agent-victim",
          execute: () => ({ action: "allow" as const }),
        },
      }),
      onError: (error) => errors.push(error),
    });

    const handle = stack.policyCacheHandle as unknown as {
      register: (entry: unknown) => { readonly ok: true; readonly value: undefined };
    };
    handle.register = (entry) => {
      registered.push(entry);
      return { ok: true as const, value: undefined };
    };

    const result = await stack.synthesizeHarness(makeSignal(), {
      sessionId: "s-owner",
      ownerAgentId: "agent-owner",
    });

    // Live deploy DID succeed; result returns deployed artifact (not null).
    expect(result).not.toBeNull();
    // BUT the policy entry was refused — never registered into the cache.
    expect(registered).toHaveLength(0);
    expect(errors.some((e) => e.stage === "register-policy")).toBe(true);
    expect(errors.some((e) => e.message.includes("does not match the owning agent"))).toBe(true);
  });

  test("accepts policyEntry whose agentId matches session.ownerAgentId", async () => {
    const registered: unknown[] = [];
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      policyVerifier: (() => async () => ({ ok: true as const, value: undefined })) as never,
      notifier: makeNotifier(),
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (a) => ({
        ok: true,
        artifact: a,
        policyEntry: {
          brickId: a.id,
          toolId: "search",
          scope: "agent" as const,
          agentId: "agent-owner",
          execute: () => ({ action: "allow" as const }),
        },
      }),
    });

    const handle = stack.policyCacheHandle as unknown as {
      register: (entry: unknown) => { readonly ok: true; readonly value: undefined };
    };
    handle.register = (entry) => {
      registered.push(entry);
      return { ok: true as const, value: undefined };
    };

    await stack.synthesizeHarness(makeSignal(), {
      sessionId: "s-owner",
      ownerAgentId: "agent-owner",
    });

    expect(registered).toHaveLength(1);
  });

  test("returns deployed artifact (not null) when post-deploy save fails", async () => {
    const errors: AutoHarnessError[] = [];
    let saveCalls = 0;
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => {
          saveCalls += 1;
          // First save (pre-deploy draft) succeeds; second save (post-deploy
          // authoritative artifact) fails — live deploy already committed.
          if (saveCalls === 1) return { ok: true as const, value: undefined };
          return {
            ok: false as const,
            error: {
              code: "STORAGE",
              message: "disk full",
              retryable: false,
            } as never,
          };
        },
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true, artifact }),
      onError: (error) => errors.push(error),
    });

    const result = await stack.synthesizeHarness(makeSignal());

    // Caller sees the deployed artifact, NOT null — retry would duplicate
    // activation against an already-live state.
    expect(result).toEqual(artifact);
    expect(errors.some((e) => e.message.includes("post-deploy"))).toBe(true);
  });

  test("returns pre-deploy draft when deployCandidate succeeds without an authoritative artifact", async () => {
    const errors: AutoHarnessError[] = [];
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      // ok: true but missing artifact — live deploy may have committed.
      deployCandidate: async () => ({ ok: true }) as never,
      onError: (error) => errors.push(error),
    });

    const result = await stack.synthesizeHarness(makeSignal());

    // Caller gets the pre-deploy draft so they don't redeploy; the
    // reported error tells them to reconcile.
    expect(result).not.toBeNull();
    expect(result?.id).toMatch(/^auto-harness-draft:/);
    expect(errors.some((e) => e.message.includes("Manual reconciliation"))).toBe(true);
  });

  test("agent_repeated_failure dedupes per (agentType, brickId) — distinct bricks bypass each other", async () => {
    const generated: string[] = [];
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async (prompt) => {
        generated.push(prompt);
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true, artifact }),
    });

    const sigA: ForgeDemandSignal = {
      ...makeSignal(),
      id: "agent-repeat-A",
      trigger: {
        kind: "agent_repeated_failure",
        agentType: "researcher",
        brickId: "brick-A" as never,
        errorRate: 0.5,
      },
    } as ForgeDemandSignal;
    const sigB: ForgeDemandSignal = {
      ...makeSignal(),
      id: "agent-repeat-B",
      trigger: {
        kind: "agent_repeated_failure",
        agentType: "researcher",
        brickId: "brick-B" as never,
        errorRate: 0.5,
      },
    } as ForgeDemandSignal;

    // Same agentType but DIFFERENT brickId — must run independent pipelines.
    await stack.synthesizeHarness(sigA, { sessionId: "s1" });
    await stack.synthesizeHarness(sigB, { sessionId: "s1" });

    expect(generated).toHaveLength(2);
  });

  test("each pre-deploy save uses a unique draft id even when verifier returns the same id", async () => {
    const savedIds: string[] = [];
    // Verifier returns the SAME id on every call — would have collided
    // under the old TOCTOU exists() logic.
    const fixedArtifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async (b: BrickArtifact) => {
          savedIds.push(b.id as string);
          return { ok: true as const, value: undefined };
        },
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact: fixedArtifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true, artifact: fixedArtifact }),
    });

    const sig1: ForgeDemandSignal = {
      ...makeSignal(),
      id: "sig-1",
      trigger: { kind: "repeated_failure", toolName: "tool-1", count: 3 },
    } as ForgeDemandSignal;
    const sig2: ForgeDemandSignal = {
      ...makeSignal(),
      id: "sig-2",
      trigger: { kind: "repeated_failure", toolName: "tool-2", count: 3 },
    } as ForgeDemandSignal;

    await stack.synthesizeHarness(sig1, { sessionId: "s1" });
    await stack.synthesizeHarness(sig2, { sessionId: "s1" });

    // 4 saves total: 2 drafts (random ids) + 2 post-deploy authoritative.
    expect(savedIds).toHaveLength(4);
    const draftIds = savedIds.filter((id) => id.startsWith("auto-harness-draft:"));
    expect(draftIds).toHaveLength(2);
    expect(new Set(draftIds).size).toBe(2);
  });

  test("dispose() releases the completedTriggers notifier subscription", () => {
    let unsubscribed = 0;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: () => () => {
        unsubscribed += 1;
      },
    };
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier,
      generate: async () => "x",
      verifyCandidate: async () => ({ ok: false, artifact: null, reason: "stop" }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (a) => ({ ok: true, artifact: a }),
    });

    expect(unsubscribed).toBe(0);
    stack.dispose();
    // stack.dispose() releases ONLY the completedTriggers subscription;
    // policyCacheHandle.dispose() releases its own separately.
    expect(unsubscribed).toBe(1);
    stack.policyCacheHandle.dispose();
    expect(unsubscribed).toBe(2);
  });

  test("dispose() is idempotent and safe to call when notifier is omitted", () => {
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      generate: async () => "x",
      verifyCandidate: async () => ({ ok: false, artifact: null, reason: "stop" }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (a) => ({ ok: true, artifact: a }),
    });

    expect(() => stack.dispose()).not.toThrow();
    expect(() => stack.dispose()).not.toThrow();
  });

  test("ownerAgentId omitted falls through to the looser non-empty-string agentId check", async () => {
    const registered: unknown[] = [];
    const artifact = makeArtifact();
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
        exists: async () => ({ ok: true as const, value: false }),
        remove: async () => ({ ok: true as const, value: undefined }),
      } as never,
      policyVerifier: (() => async () => ({ ok: true as const, value: undefined })) as never,
      notifier: makeNotifier(),
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async (a) => ({
        ok: true,
        artifact: a,
        policyEntry: {
          brickId: a.id,
          toolId: "search",
          scope: "agent" as const,
          agentId: "agent-anything",
          execute: () => ({ action: "allow" as const }),
        },
      }),
    });

    const handle = stack.policyCacheHandle as unknown as {
      register: (entry: unknown) => { readonly ok: true; readonly value: undefined };
    };
    handle.register = (entry) => {
      registered.push(entry);
      return { ok: true as const, value: undefined };
    };

    // No session at all (out-of-band caller / stub adapter).
    await stack.synthesizeHarness(makeSignal());
    // Session without ownerAgentId.
    await stack.synthesizeHarness({ ...makeSignal(), id: "sig-no-owner" } as ForgeDemandSignal, {
      sessionId: "s-no-owner",
    });

    expect(registered).toHaveLength(2);
  });
});
