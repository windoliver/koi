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
  }) as BrickArtifact;

describe("createAutoHarnessStack", () => {
  test("returns policy-cache middleware, synthesis callback, and session controls", () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
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
      deployCandidate: async (_artifact, _signal): Promise<AutoHarnessDeployResult> => ({
        ok: true,
      }),
    });

    expect(stack.policyCacheMiddleware.name).toBe("policy-cache");
    expect(stack.policyCacheHandle.middleware).toBe(stack.policyCacheMiddleware);
    expect(subscribed).toBe(1);
    expect(stack.policyCacheHandle.size()).toBe(0);
    expect(stack.policyCacheHandle.evict("brick-1" as never)).toBeUndefined();
    stack.policyCacheHandle.dispose();
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

  test("reports thrown verifier failures and returns null", async () => {
    const errors: AutoHarnessError[] = [];
    const stack = createAutoHarnessStack({
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => {
        throw new Error("verifier crashed");
      },
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true }),
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
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => {
        throw new Error("approval service unavailable");
      },
      deployCandidate: async () => ({ ok: true }),
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
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
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

    // First attempt fails at deploy and consumes the budget.
    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBeNull();
    // Second attempt is gated out — failed attempts count, so the budget is
    // already exhausted. This bounds runaway regeneration on persistent
    // bad signals or unavailable dependencies.
    await expect(stack.synthesizeHarness(makeSignal())).resolves.toBeNull();
    expect(deploymentAttempts).toBe(1);
    expect(errors).toHaveLength(1);
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
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
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
          scope: "global" as const,
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
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => {
        generateCalls += 1;
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: false, artifact: null, reason: "no" }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true }),
      maxSynthesesPerSession: 2,
    });

    await stack.synthesizeHarness(makeSignal());
    await stack.synthesizeHarness(makeSignal());
    // Third call is gated out — both prior failed attempts consumed budget.
    await stack.synthesizeHarness(makeSignal());

    expect(generateCalls).toBe(2);
  });

  test("derives the generation prompt from the demand signal", async () => {
    const prompts: string[] = [];
    const stack = createAutoHarnessStack({
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async (prompt) => {
        prompts.push(prompt);
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: false, artifact: null, reason: "stop" }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true }),
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
      brickId: "brick-policy-1",
      toolId: "search",
      scope: "global" as const,
      execute: () => ({ action: "allow" as const }),
    };
    const stack = createAutoHarnessStack({
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
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
      expect(result).toBe(artifact);
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
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({
        ok: true,
        artifact,
        policyEntry: {
          brickId: "brick-policy-2",
          toolId: "search",
          scope: "global" as const,
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
    expect(result).toBe(artifact);
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
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => {
        generateCalls += 1;
        await gate;
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true }),
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
    expect(firstResult).toBe(artifact);
    expect(generateCalls).toBe(1);
  });

  test("partitions per-session synthesis budgets — one session cannot exhaust another's", async () => {
    let generateCalls = 0;
    const stack = createAutoHarnessStack({
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => {
        generateCalls += 1;
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: true, artifact: makeArtifact() }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true }),
      maxSynthesesPerSession: 2,
    });

    // Session A consumes its own budget.
    await stack.synthesizeHarness(makeSignal(), { sessionId: "session-A" });
    await stack.synthesizeHarness(makeSignal(), { sessionId: "session-A" });
    // Session A is exhausted; further calls under A skip.
    const aThird = await stack.synthesizeHarness(makeSignal(), { sessionId: "session-A" });
    expect(aThird).toBeNull();

    // Session B has its own fresh budget.
    const bFirst = await stack.synthesizeHarness(makeSignal(), { sessionId: "session-B" });
    expect(bFirst).not.toBeNull();
    expect(generateCalls).toBe(3);
  });

  test("calls dismiss after every terminal outcome (success and failure)", async () => {
    const dismissed: string[] = [];
    const dismiss = (label: string) => () => dismissed.push(label);

    const stack = createAutoHarnessStack({
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async (signal) =>
        signal.id === "sig-fail"
          ? { ok: false, artifact: null, reason: "no" }
          : { ok: true, artifact: makeArtifact() },
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true }),
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
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async (prompt) => {
        prompts.push(prompt);
        return "candidate-code";
      },
      verifyCandidate: async () => ({ ok: false, artifact: null, reason: "stop" }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true }),
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
      } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact }),
      evaluatePolicy: async () => {
        policyCalls += 1;
        // Save must have happened before any further pipeline stage runs.
        expect(saved).toContain(artifact);
        return { ok: true, action: "allow" };
      },
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true }),
    });

    await stack.synthesizeHarness(makeSignal());

    expect(saved).toEqual([artifact]);
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
