/**
 * Integration tests — full permission flow composition.
 *
 * Tests the end-to-end path: NexusPermissionBackend → NexusScopeEnforcer
 * with mock Nexus client simulating the full check pipeline.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { delegationId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusPermissionBackend } from "../nexus-permission-backend.js";
import { createNexusRevocationRegistry } from "../nexus-revocation-registry.js";
import { createNexusScopeEnforcer } from "../nexus-scope-enforcer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock Nexus client that responds to permission and revocation RPCs.
 */
function createIntegrationClient(opts?: {
  readonly allowedResources?: ReadonlySet<string>;
  readonly revokedIds?: ReadonlySet<string>;
}): NexusClient {
  const allowed = opts?.allowedResources ?? new Set<string>();
  const revoked = opts?.revokedIds ?? new Set<string>();

  return {
    rpc: async <T>(method: string, params: Record<string, unknown>) => {
      switch (method) {
        case "permissions.check": {
          const isAllowed = allowed.has(params.resource as string);
          return {
            ok: true,
            value: {
              allowed: isAllowed,
              reason: isAllowed ? undefined : "not in allowed set",
            } as unknown as T,
          } satisfies Result<T, KoiError>;
        }

        case "permissions.checkBatch": {
          const queries = params.queries as readonly { readonly resource: string }[];
          return {
            ok: true,
            value: {
              results: queries.map((q) => ({
                allowed: allowed.has(q.resource),
                reason: allowed.has(q.resource) ? undefined : "not in allowed set",
              })),
            } as unknown as T,
          } satisfies Result<T, KoiError>;
        }

        case "revocations.check": {
          return {
            ok: true,
            value: { revoked: revoked.has(params.id as string) } as unknown as T,
          } satisfies Result<T, KoiError>;
        }

        case "revocations.checkBatch": {
          const ids = params.ids as readonly string[];
          return {
            ok: true,
            value: {
              results: ids.map((id) => ({ id, revoked: revoked.has(id) })),
            } as unknown as T,
          } satisfies Result<T, KoiError>;
        }

        case "revocations.revoke": {
          return { ok: true, value: {} as unknown as T } satisfies Result<T, KoiError>;
        }

        default:
          return {
            ok: false,
            error: {
              code: "EXTERNAL" as const,
              message: `unknown method: ${method}`,
              retryable: false,
            },
          } satisfies Result<T, KoiError>;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Full flow: PermissionBackend → ScopeEnforcer
// ---------------------------------------------------------------------------

describe("integration: full permission flow", () => {
  test("Nexus allows → scope enforcer allows filesystem access", async () => {
    const client = createIntegrationClient({
      allowedResources: new Set(["/src/main.ts"]),
    });

    const backend = createNexusPermissionBackend({ client });
    const enforcer = createNexusScopeEnforcer({ backend });

    const allowed = await enforcer.checkAccess({
      subsystem: "filesystem",
      operation: "read",
      resource: "/src/main.ts",
      context: { agentId: "agent:coder" },
    });
    expect(allowed).toBe(true);
  });

  test("Nexus denies → scope enforcer denies filesystem access", async () => {
    const client = createIntegrationClient({
      allowedResources: new Set(), // nothing allowed
    });

    const backend = createNexusPermissionBackend({ client });
    const enforcer = createNexusScopeEnforcer({ backend });

    const result = await enforcer.checkAccess({
      subsystem: "filesystem",
      operation: "write",
      resource: "/protected/file.ts",
      context: { agentId: "agent:writer" },
    });

    expect(result).toBe(false);
  });

  test("batch check with mixed Nexus decisions", async () => {
    const client = createIntegrationClient({
      allowedResources: new Set(["/src/main.ts", "/docs/readme.md"]),
    });

    const backend = createNexusPermissionBackend({ client });

    const results = await backend.checkBatch?.([
      { principal: "agent:a", action: "read", resource: "/src/main.ts" }, // Nexus allow
      { principal: "agent:a", action: "read", resource: "/secret/key.pem" }, // Nexus deny
      { principal: "agent:a", action: "read", resource: "/docs/readme.md" }, // Nexus allow
    ]);
    if (results === undefined) {
      throw new Error("checkBatch not defined");
    }

    expect(results[0]?.effect).toBe("allow");
    expect(results[1]?.effect).toBe("deny");
    expect(results[2]?.effect).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Revocation registry integration
// ---------------------------------------------------------------------------

describe("integration: revocation registry", () => {
  test("Nexus reports revoked → isRevoked returns true", async () => {
    const client = createIntegrationClient({
      revokedIds: new Set(["grant-123"]),
    });

    const registry = createNexusRevocationRegistry({ client });

    const isRevoked = await registry.isRevoked(delegationId("grant-123"));
    expect(isRevoked).toBe(true);
  });

  test("Nexus reports not revoked → isRevoked returns false", async () => {
    const client = createIntegrationClient({
      revokedIds: new Set(),
    });

    const registry = createNexusRevocationRegistry({ client });

    const isRevoked = await registry.isRevoked(delegationId("grant-valid"));
    expect(isRevoked).toBe(false);
  });

  test("batch check with mixed revoked and valid", async () => {
    const client = createIntegrationClient({
      revokedIds: new Set(["grant-revoked"]),
    });

    const registry = createNexusRevocationRegistry({ client });

    const results = await registry.isRevokedBatch([
      delegationId("grant-revoked"),
      delegationId("grant-valid"),
    ]);

    expect(results.get(delegationId("grant-revoked"))).toBe(true);
    expect(results.get(delegationId("grant-valid"))).toBe(false);
  });
});
