import { describe, expect, test } from "bun:test";
import { createRuntime } from "../create-runtime.js";

describe("createRuntime autoHarness wiring", () => {
  test("preserves caller-supplied policy-cache middleware", () => {
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

    expect(runtime.middleware.filter((mw) => mw.name === "policy-cache")).toHaveLength(1);
    expect(runtime.middleware).toContain(providedPolicyCache);
    expect(runtime.autoHarness).toBeDefined();
    expect(runtime.autoHarness?.middleware.name).toBe("policy-cache");
    expect(runtime.autoHarness?.middleware).not.toBe(providedPolicyCache);
  });

  test("installs policy-cache middleware when autoHarness is enabled", () => {
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

    expect(runtime.middleware.map((mw) => mw.name)).toContain("policy-cache");
    expect(runtime.autoHarness).toBeDefined();
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
