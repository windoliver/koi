import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { delegationId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusRevocationRegistry } from "./nexus-revocation-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RpcHandler = <T>(
  method: string,
  params: Record<string, unknown>,
) => Promise<Result<T, KoiError>>;

function createMockClient(handler?: RpcHandler): NexusClient {
  const defaultHandler: RpcHandler = async <T>() =>
    ({ ok: true, value: { revoked: false } as unknown as T }) satisfies Result<T, KoiError>;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusRevocationRegistry", () => {
  // -----------------------------------------------------------------------
  // isRevoked
  // -----------------------------------------------------------------------

  describe("isRevoked", () => {
    test("returns false when Nexus says not revoked", async () => {
      const registry = createNexusRevocationRegistry({
        client: createMockClient(async <T>() => ({
          ok: true,
          value: { revoked: false } as unknown as T,
        })),
      });

      const result = await registry.isRevoked(delegationId("d-1"));
      expect(result).toBe(false);
    });

    test("returns true when Nexus says revoked", async () => {
      const registry = createNexusRevocationRegistry({
        client: createMockClient(async <T>() => ({
          ok: true,
          value: { revoked: true } as unknown as T,
        })),
      });

      const result = await registry.isRevoked(delegationId("d-1"));
      expect(result).toBe(true);
    });

    test("fail-closed on Nexus error", async () => {
      const registry = createNexusRevocationRegistry({
        client: createErrorClient("connection refused"),
      });

      const result = await registry.isRevoked(delegationId("d-1"));
      expect(result).toBe(true); // Fail-closed
    });

    test("calls correct RPC method with id", async () => {
      let capturedMethod = "";
      let capturedParams: Record<string, unknown> = {};
      const registry = createNexusRevocationRegistry({
        client: createMockClient(async <T>(method: string, params: Record<string, unknown>) => {
          capturedMethod = method;
          capturedParams = params;
          return { ok: true, value: { revoked: false } as unknown as T };
        }),
      });

      await registry.isRevoked(delegationId("d-42"));

      expect(capturedMethod).toBe("revocations.check");
      expect(capturedParams.id).toBe("d-42");
    });
  });

  // -----------------------------------------------------------------------
  // isRevokedBatch
  // -----------------------------------------------------------------------

  describe("isRevokedBatch", () => {
    test("returns map of results from Nexus", async () => {
      const registry = createNexusRevocationRegistry({
        client: createMockClient(async <T>(method: string) => {
          if (method === "revocations.checkBatch") {
            return {
              ok: true,
              value: {
                results: [
                  { id: "d-1", revoked: true },
                  { id: "d-2", revoked: false },
                ],
              } as unknown as T,
            };
          }
          return { ok: true, value: {} as unknown as T };
        }),
      });

      const ids = [delegationId("d-1"), delegationId("d-2")];
      const result = await registry.isRevokedBatch(ids);

      expect(result.get(delegationId("d-1"))).toBe(true);
      expect(result.get(delegationId("d-2"))).toBe(false);
    });

    test("fail-closed on batch Nexus error", async () => {
      const registry = createNexusRevocationRegistry({
        client: createErrorClient("batch fail"),
      });

      const ids = [delegationId("d-1"), delegationId("d-2")];
      const result = await registry.isRevokedBatch(ids);

      expect(result.get(delegationId("d-1"))).toBe(true);
      expect(result.get(delegationId("d-2"))).toBe(true);
    });

    test("sends all ids to Nexus", async () => {
      let capturedIds: readonly string[] = [];
      const registry = createNexusRevocationRegistry({
        client: createMockClient(async <T>(_method: string, params: Record<string, unknown>) => {
          capturedIds = params.ids as readonly string[];
          return {
            ok: true,
            value: {
              results: (params.ids as readonly string[]).map((id) => ({ id, revoked: false })),
            } as unknown as T,
          };
        }),
      });

      const ids = [delegationId("d-1"), delegationId("d-2"), delegationId("d-3")];
      await registry.isRevokedBatch(ids);

      expect(capturedIds).toEqual(["d-1", "d-2", "d-3"]);
    });
  });

  // -----------------------------------------------------------------------
  // revoke
  // -----------------------------------------------------------------------

  describe("revoke", () => {
    test("sends revoke RPC to Nexus", async () => {
      let capturedMethod = "";
      let capturedParams: Record<string, unknown> = {};
      const registry = createNexusRevocationRegistry({
        client: createMockClient(async <T>(method: string, params: Record<string, unknown>) => {
          capturedMethod = method;
          capturedParams = params;
          return { ok: true, value: {} as unknown as T };
        }),
      });

      await registry.revoke(delegationId("d-1"), true);

      expect(capturedMethod).toBe("revocations.revoke");
      expect(capturedParams.id).toBe("d-1");
      expect(capturedParams.cascade).toBe(true);
    });

    test("sends cascade=false when specified", async () => {
      let capturedParams: Record<string, unknown> = {};
      const registry = createNexusRevocationRegistry({
        client: createMockClient(async <T>(_method: string, params: Record<string, unknown>) => {
          capturedParams = params;
          return { ok: true, value: {} as unknown as T };
        }),
      });

      await registry.revoke(delegationId("d-2"), false);

      expect(capturedParams.cascade).toBe(false);
    });
  });
});
