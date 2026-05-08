import { describe, expect, test } from "bun:test";
import type { StoreChangeNotifier } from "@koi/core";
import { createAutoHarnessStack } from "./create-auto-harness-stack.js";
import { DEFAULT_MAX_SYNTHESES_PER_SESSION } from "./types.js";

const makeNotifier = (): StoreChangeNotifier => ({
  notify: () => {},
  subscribe: () => () => {},
});

describe("createAutoHarnessStack", () => {
  test("returns policy-cache middleware, synthesis callback, and session controls", () => {
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier: makeNotifier(),
      generate: async () => "export function createMiddleware() {}",
      verifyCandidate: async () => ({ ok: true as const, artifact: null }),
      evaluatePolicy: async () => ({ ok: true as const, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true as const }),
    });

    expect(stack.policyCacheMiddleware.name).toBe("policy-cache");
    expect(typeof stack.synthesizeHarness).toBe("function");
    expect(typeof stack.resetSession).toBe("function");
    expect(stack.maxSynthesesPerSession).toBeGreaterThan(0);
  });

  test("defaults the session synthesis cap and allows resetSession to reopen the counter", async () => {
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier: makeNotifier(),
      generate: async () => "export function createMiddleware() {}",
      verifyCandidate: async () => ({ ok: true as const, artifact: null }),
      evaluatePolicy: async () => ({ ok: true as const, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true as const }),
    });

    expect(stack.maxSynthesesPerSession).toBe(DEFAULT_MAX_SYNTHESES_PER_SESSION);
    await expect(stack.synthesizeHarness()).resolves.toBeNull();
    await expect(stack.synthesizeHarness()).resolves.toBeNull();
    await expect(stack.synthesizeHarness()).resolves.toBeNull();
    await expect(stack.synthesizeHarness()).resolves.toBeNull();
    stack.resetSession();
    await expect(stack.synthesizeHarness()).resolves.toBeNull();
  });

  test("rejects non-positive maxSynthesesPerSession", () => {
    expect(() =>
      createAutoHarnessStack({
        forgeStore: {
          save: async () => ({ ok: true as const, value: undefined }),
        } as never,
        notifier: makeNotifier(),
        generate: async () => "export function createMiddleware() {}",
        verifyCandidate: async () => ({ ok: true as const, artifact: null }),
        evaluatePolicy: async () => ({ ok: true as const, action: "allow" }),
        requestDeploymentApproval: async () => true,
        deployCandidate: async () => ({ ok: true as const }),
        maxSynthesesPerSession: 0,
      }),
    ).toThrow(/maxSynthesesPerSession/);
  });
});
