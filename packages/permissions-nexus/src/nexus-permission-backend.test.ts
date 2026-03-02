import { describe, expect, test } from "bun:test";
import type { KoiError, PermissionQuery, Result } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusPermissionBackend } from "./nexus-permission-backend.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RpcHandler = <T>(
  method: string,
  params: Record<string, unknown>,
) => Promise<Result<T, KoiError>>;

function createMockClient(handler?: RpcHandler): NexusClient {
  const defaultHandler: RpcHandler = async <T>() =>
    ({ ok: true, value: { allowed: true } as unknown as T }) satisfies Result<T, KoiError>;
  return { rpc: handler ?? defaultHandler };
}

function createErrorClient(message = "server error"): NexusClient {
  return createMockClient(
    async <T>() =>
      ({
        ok: false,
        error: { code: "EXTERNAL" as const, message, retryable: true },
      }) satisfies Result<T, KoiError>,
  );
}

function query(resource: string, action = "read", principal = "agent:tester"): PermissionQuery {
  return { principal, action, resource };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusPermissionBackend", () => {
  // -----------------------------------------------------------------------
  // check — single query
  // -----------------------------------------------------------------------

  describe("check", () => {
    test("forwards query to Nexus and returns allow", async () => {
      let capturedParams: Record<string, unknown> | undefined;
      const backend = createNexusPermissionBackend({
        client: createMockClient(async <T>(_method: string, params: Record<string, unknown>) => {
          capturedParams = params;
          return { ok: true, value: { allowed: true } as unknown as T };
        }),
      });

      const result = await backend.check(query("/src/main.ts", "write", "agent:dev"));

      expect(result.effect).toBe("allow");
      expect(capturedParams).toEqual({
        principal: "agent:dev",
        action: "write",
        resource: "/src/main.ts",
      });
    });

    test("returns deny with reason when Nexus denies", async () => {
      const backend = createNexusPermissionBackend({
        client: createMockClient(async <T>() => ({
          ok: true,
          value: { allowed: false, reason: "no access" } as unknown as T,
        })),
      });

      const result = await backend.check(query("/secret/key.pem"));

      expect(result.effect).toBe("deny");
      if (result.effect === "deny") {
        expect(result.reason).toBe("no access");
      }
    });

    test("uses default deny reason when Nexus returns none", async () => {
      const backend = createNexusPermissionBackend({
        client: createMockClient(async <T>() => ({
          ok: true,
          value: { allowed: false } as unknown as T,
        })),
      });

      const result = await backend.check(query("/file.ts"));

      expect(result.effect).toBe("deny");
      if (result.effect === "deny") {
        expect(result.reason).toBe("denied by Nexus");
      }
    });

    test("fail-closed on Nexus error", async () => {
      const backend = createNexusPermissionBackend({
        client: createErrorClient("connection refused"),
      });

      const result = await backend.check(query("/file.ts"));

      expect(result.effect).toBe("deny");
      if (result.effect === "deny") {
        expect(result.reason).toContain("connection refused");
      }
    });

    test("passes context when present", async () => {
      let capturedParams: Record<string, unknown> | undefined;
      const backend = createNexusPermissionBackend({
        client: createMockClient(async <T>(_method: string, params: Record<string, unknown>) => {
          capturedParams = params;
          return { ok: true, value: { allowed: true } as unknown as T };
        }),
      });

      await backend.check({
        principal: "agent:a",
        action: "read",
        resource: "/file.ts",
        context: { sessionId: "s-1" },
      });

      expect(capturedParams?.context).toEqual({ sessionId: "s-1" });
    });

    test("omits context when not present", async () => {
      let capturedParams: Record<string, unknown> | undefined;
      const backend = createNexusPermissionBackend({
        client: createMockClient(async <T>(_method: string, params: Record<string, unknown>) => {
          capturedParams = params;
          return { ok: true, value: { allowed: true } as unknown as T };
        }),
      });

      await backend.check(query("/file.ts"));

      expect(capturedParams).not.toHaveProperty("context");
    });

    test("calls correct RPC method", async () => {
      let capturedMethod = "";
      const backend = createNexusPermissionBackend({
        client: createMockClient(async <T>(method: string) => {
          capturedMethod = method;
          return { ok: true, value: { allowed: true } as unknown as T };
        }),
      });

      await backend.check(query("/file.ts"));

      expect(capturedMethod).toBe("permissions.check");
    });
  });

  // -----------------------------------------------------------------------
  // checkBatch
  // -----------------------------------------------------------------------

  describe("checkBatch", () => {
    test("sends batch RPC and returns decisions", async () => {
      const backend = createNexusPermissionBackend({
        client: createMockClient(async <T>(method: string) => {
          if (method === "permissions.checkBatch") {
            return {
              ok: true,
              value: {
                results: [
                  { allowed: true },
                  { allowed: false, reason: "denied" },
                  { allowed: true },
                ],
              } as unknown as T,
            };
          }
          return { ok: true, value: { allowed: true } as unknown as T };
        }),
      });

      const results = await backend.checkBatch?.([query("/a.ts"), query("/b.ts"), query("/c.ts")]);
      if (results === undefined) {
        throw new Error("checkBatch not defined");
      }

      expect(results[0]?.effect).toBe("allow");
      expect(results[1]?.effect).toBe("deny");
      expect(results[2]?.effect).toBe("allow");
    });

    test("returns all deny on batch Nexus error", async () => {
      const backend = createNexusPermissionBackend({
        client: createErrorClient("batch fail"),
      });

      const results = await backend.checkBatch?.([query("/a.ts"), query("/b.ts")]);
      if (results === undefined) {
        throw new Error("checkBatch not defined");
      }

      expect(results[0]?.effect).toBe("deny");
      expect(results[1]?.effect).toBe("deny");
    });

    test("passes context in batch queries", async () => {
      let capturedQueries: readonly Record<string, unknown>[] = [];
      const backend = createNexusPermissionBackend({
        client: createMockClient(async <T>(_method: string, params: Record<string, unknown>) => {
          capturedQueries = params.queries as readonly Record<string, unknown>[];
          return {
            ok: true,
            value: { results: [{ allowed: true }] } as unknown as T,
          };
        }),
      });

      await backend.checkBatch?.([
        { principal: "a", action: "read", resource: "/file.ts", context: { key: "val" } },
      ]);

      expect(capturedQueries[0]?.context).toEqual({ key: "val" });
    });

    test("uses default deny reason for batch items", async () => {
      const backend = createNexusPermissionBackend({
        client: createMockClient(async <T>() => ({
          ok: true,
          value: { results: [{ allowed: false }] } as unknown as T,
        })),
      });

      const results = await backend.checkBatch?.([query("/file.ts")]);
      if (results === undefined) {
        throw new Error("checkBatch not defined");
      }

      expect(results[0]?.effect).toBe("deny");
      if (results[0]?.effect === "deny") {
        expect(results[0].reason).toBe("denied by Nexus");
      }
    });
  });

  // -----------------------------------------------------------------------
  // grant — ReBAC tuple write
  // -----------------------------------------------------------------------

  describe("grant", () => {
    test("calls permissions.grant RPC with correct tuple", async () => {
      let capturedMethod = "";
      let capturedParams: Record<string, unknown> | undefined;
      const backend = createNexusPermissionBackend({
        client: createMockClient(async <T>(method: string, params: Record<string, unknown>) => {
          capturedMethod = method;
          capturedParams = params;
          return { ok: true, value: undefined as unknown as T };
        }),
      });

      const result = await backend.grant({
        subject: "agent:coder",
        relation: "writer",
        object: "folder:/src",
      });

      expect(result.ok).toBe(true);
      expect(capturedMethod).toBe("permissions.grant");
      expect(capturedParams).toEqual({
        subject: "agent:coder",
        relation: "writer",
        object: "folder:/src",
      });
    });

    test("returns error on RPC failure", async () => {
      const backend = createNexusPermissionBackend({
        client: createErrorClient("grant failed"),
      });

      const result = await backend.grant({
        subject: "agent:coder",
        relation: "reader",
        object: "folder:/data",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("grant failed");
      }
    });
  });
});
