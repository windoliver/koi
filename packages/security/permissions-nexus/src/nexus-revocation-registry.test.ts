import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { delegationId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusRevocationRegistry } from "./nexus-revocation-registry.js";

type CallArgs = { readonly path: string; readonly content?: string };

function makeTransport(
  handler: (method: string, params: CallArgs) => Promise<Result<string, KoiError>>,
): NexusTransport {
  return {
    call: handler as NexusTransport["call"],
    close: () => {},
  };
}

function notFoundError(): Result<string, KoiError> {
  return {
    ok: false,
    error: { code: "NOT_FOUND", message: "not found", retryable: false },
  };
}

function timeoutError(): Result<string, KoiError> {
  return {
    ok: false,
    error: { code: "TIMEOUT", message: "timeout", retryable: true },
  };
}

function okResult(value: string): Result<string, KoiError> {
  return { ok: true, value };
}

describe("createNexusRevocationRegistry", () => {
  test("isRevoked returns false when transport returns NOT_FOUND error", async () => {
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async () => notFoundError()),
    });
    const result = await registry.isRevoked(delegationId("grant-1"));
    expect(result).toBe(false);
  });

  test("isRevoked returns true when record has revoked: true", async () => {
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async () => okResult(JSON.stringify({ revoked: true }))),
    });
    const result = await registry.isRevoked(delegationId("grant-1"));
    expect(result).toBe(true);
  });

  test("isRevoked returns false when record has revoked: false", async () => {
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async () => okResult(JSON.stringify({ revoked: false }))),
    });
    const result = await registry.isRevoked(delegationId("grant-1"));
    expect(result).toBe(false);
  });

  test("isRevoked returns true (fail-closed) on schema drift — string revoked value", async () => {
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async () => okResult(JSON.stringify({ revoked: "true" }))),
    });
    const result = await registry.isRevoked(delegationId("grant-1"));
    expect(result).toBe(true);
  });

  test("isRevoked returns true (fail-closed) when revocation record missing revoked field", async () => {
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async () => okResult(JSON.stringify({}))),
    });
    const result = await registry.isRevoked(delegationId("grant-1"));
    expect(result).toBe(true);
  });

  test("isRevoked returns true (fail-closed) on TIMEOUT error", async () => {
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async () => timeoutError()),
    });
    const result = await registry.isRevoked(delegationId("grant-1"));
    expect(result).toBe(true);
  });

  test("isRevoked returns true (fail-closed) on malformed JSON", async () => {
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async () => okResult("not-valid-json{")),
    });
    const result = await registry.isRevoked(delegationId("grant-1"));
    expect(result).toBe(true);
  });

  test("isRevokedBatch returns correct map", async () => {
    const id1 = delegationId("grant-1");
    const id2 = delegationId("grant-2");
    const id3 = delegationId("grant-3");

    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async (_method, params) => {
        if ((params as CallArgs).path.includes("grant-1")) {
          return okResult(JSON.stringify({ revoked: true }));
        }
        if ((params as CallArgs).path.includes("grant-2")) {
          return okResult(JSON.stringify({ revoked: false }));
        }
        // grant-3 returns NOT_FOUND
        return notFoundError();
      }),
    });

    const map = await registry.isRevokedBatch([id1, id2, id3]);
    expect(map.get(id1)).toBe(true);
    expect(map.get(id2)).toBe(false);
    expect(map.get(id3)).toBe(false); // NOT_FOUND = not revoked
  });

  test("revoke(cascade=true) throws before any write — all-or-nothing cascade semantics", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params: params as CallArgs });
        return { ok: true, value: "" };
      }),
    });

    await expect(registry.revoke(delegationId("grant-abc"), true)).rejects.toThrow(
      /cascade=true is not supported/,
    );

    // No write must have happened — throw before side effects preserves atomic contract
    expect(calls.filter((c) => c.method === "write")).toHaveLength(0);
  });

  test("revoke(cascade=false) writes { revoked: true } to correct path", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params: params as CallArgs });
        return { ok: true, value: "" };
      }),
    });

    await registry.revoke(delegationId("grant-xyz"), false);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect(call.method).toBe("write");
      expect(call.params.path).toBe("koi/permissions/revocations/grant-xyz.json");
      expect(JSON.parse(call.params.content ?? "{}")).toEqual({ revoked: true });
    }
  });

  test("isRevoked rejects DelegationId with path-traversal characters", async () => {
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async () => notFoundError()),
    });
    await expect(registry.isRevoked(delegationId("../etc/passwd"))).rejects.toThrow(
      /unsafe path characters/,
    );
  });

  test("revoke rejects DelegationId with slash characters", async () => {
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async () => ({ ok: true, value: "" })),
    });
    await expect(registry.revoke(delegationId("a/b"), false)).rejects.toThrow(
      /unsafe path characters/,
    );
  });

  test("custom policyPath is used", async () => {
    const calls: Array<{ method: string; params: CallArgs }> = [];
    const registry = createNexusRevocationRegistry({
      transport: makeTransport(async (method, params) => {
        calls.push({ method, params: params as CallArgs });
        return notFoundError();
      }),
      policyPath: "custom/path",
    });

    await registry.isRevoked(delegationId("grant-1"));
    const call = calls[0];
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect(call.params.path).toStartWith("custom/path/revocations/");
    }
  });
});
