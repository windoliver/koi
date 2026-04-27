import { describe, expect, test } from "bun:test";
import type { DelegationGrant, KoiError, Result } from "@koi/core";
import { agentId, delegationId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusDelegationHooks } from "./nexus-delegation-hooks.js";

type CallArgs = Record<string, unknown>;

function makeTransport(
  handler: (method: string, params: CallArgs) => Promise<Result<unknown, KoiError>>,
): NexusTransport {
  return {
    call: handler as NexusTransport["call"],
    close: () => {},
  };
}

function okResult(): Result<unknown, KoiError> {
  return { ok: true, value: "" };
}

function failResult(message = "write failed"): Result<unknown, KoiError> {
  return { ok: false, error: { code: "INTERNAL", message, retryable: false } };
}

function makeGrant(overrides?: Partial<DelegationGrant>): DelegationGrant {
  return {
    id: delegationId("grant-1"),
    issuerId: agentId("issuer"),
    delegateeId: agentId("delegatee"),
    scope: {
      permissions: { allow: ["read_file", "list_files"], deny: [] },
      resources: ["/workspace/src/**"],
    },
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    proof: { kind: "hmac-sha256", digest: "abc123" },
    ...overrides,
  };
}

describe("createNexusDelegationHooks", () => {
  test("onGrant writes tuple file to Nexus", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const hooks = createNexusDelegationHooks({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params });
        return okResult();
      }),
    });

    await hooks.onGrant(makeGrant());

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect(call.method).toBe("write");
      expect(call.params.path).toBe("koi/permissions/tuples/grant-1.json");
      const content = JSON.parse(call.params.content as string) as unknown[];
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThan(0);
    }
  });

  test("onGrant generates correct tuples with resources", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const hooks = createNexusDelegationHooks({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params });
        return okResult();
      }),
    });

    const grant = makeGrant({
      scope: {
        permissions: { allow: ["read_file"], deny: [] },
        resources: ["/workspace/src/**"],
      },
    });
    await hooks.onGrant(grant);

    const call = calls[0];
    expect(call).toBeDefined();
    if (call !== undefined) {
      const content = JSON.parse(call.params.content as string) as Array<{
        subject: string;
        relation: string;
        object: string;
      }>;
      expect(content[0]).toEqual({
        subject: "agent:delegatee",
        relation: "read_file",
        object: "/workspace/src/**",
      });
    }
  });

  test("onGrant generates tuples without resources using delegation object", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const hooks = createNexusDelegationHooks({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params });
        return okResult();
      }),
    });

    const grant = makeGrant({
      scope: {
        permissions: { allow: ["read_file"], deny: [] },
      },
    });
    await hooks.onGrant(grant);

    const call = calls[0];
    expect(call).toBeDefined();
    if (call !== undefined) {
      const content = JSON.parse(call.params.content as string) as Array<{
        subject: string;
        relation: string;
        object: string;
      }>;
      expect(content[0]).toEqual({
        subject: "agent:delegatee",
        relation: "read_file",
        object: "delegation:grant-1",
      });
    }
  });

  test("onGrant throws (fail-closed) on Nexus write failure", async () => {
    const hooks = createNexusDelegationHooks({
      transport: makeTransport(async () => failResult("disk full")),
    });

    await expect(hooks.onGrant(makeGrant())).rejects.toThrow("Nexus tuple write failed");
  });

  test("onGrant does nothing when grant has no permissions", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const hooks = createNexusDelegationHooks({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params });
        return okResult();
      }),
    });

    const grant = makeGrant({
      scope: {
        permissions: { allow: [], deny: [] },
        resources: ["/workspace/src/**"],
      },
    });
    await hooks.onGrant(grant);

    expect(calls).toHaveLength(0);
  });

  test("onRevoke deletes tuple file (uses delete method)", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const hooks = createNexusDelegationHooks({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params });
        return okResult();
      }),
    });

    await hooks.onRevoke(delegationId("grant-99"), false);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect(call.method).toBe("delete");
      expect(call.params.path).toBe("koi/permissions/tuples/grant-99.json");
    }
  });

  test("onRevoke does NOT throw on Nexus failure (best-effort)", async () => {
    const hooks = createNexusDelegationHooks({
      transport: makeTransport(async () => failResult("network error")),
    });

    // Should not throw
    await expect(hooks.onRevoke(delegationId("grant-1"), true)).resolves.toBeUndefined();
  });

  test("custom policyPath is respected for onGrant", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const hooks = createNexusDelegationHooks({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params });
        return okResult();
      }),
      policyPath: "myapp/perms",
    });

    await hooks.onGrant(makeGrant());

    const call = calls[0];
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect((call.params.path as string).startsWith("myapp/perms/tuples/")).toBe(true);
    }
  });

  test("custom policyPath is respected for onRevoke", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const hooks = createNexusDelegationHooks({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params });
        return okResult();
      }),
      policyPath: "myapp/perms",
    });

    await hooks.onRevoke(delegationId("grant-1"), false);

    const call = calls[0];
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect((call.params.path as string).startsWith("myapp/perms/tuples/")).toBe(true);
    }
  });
});
