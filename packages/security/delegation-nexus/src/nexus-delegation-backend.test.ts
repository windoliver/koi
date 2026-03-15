/**
 * Tests for NexusDelegationBackend — DelegationComponent backed by Nexus API.
 *
 * Covers:
 * - #9-A: Contract tests (grant/revoke/verify/list behavior)
 * - #12-A: Nexus unavailability scenarios
 * - #13-A: Verify cache behavior (hit, miss, stale, refresh)
 * - #14-A: Server-side chain verification (single call)
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentId, DelegationId } from "@koi/core";
import { delegationId } from "@koi/core";
import type {
  NexusChainVerifyResponse,
  NexusDelegateResponse,
  NexusDelegationApi,
  NexusDelegationListResponse,
} from "@koi/nexus-client";
import { createNexusDelegationBackend } from "./nexus-delegation-backend.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const AGENT_ID = "agent-parent" as AgentId;
const CHILD_ID = "agent-child" as AgentId;

function createMockApi(overrides?: Partial<NexusDelegationApi>): NexusDelegationApi {
  return {
    createDelegation: mock(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          delegation_id: "deleg-123",
          api_key: "key-abc",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        } satisfies NexusDelegateResponse,
      }),
    ),
    revokeDelegation: mock(() =>
      Promise.resolve({ ok: true as const, value: undefined }),
    ),
    verifyChain: mock(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          delegation_id: "deleg-123",
          valid: true,
          chain_depth: 0,
        } satisfies NexusChainVerifyResponse,
      }),
    ),
    listDelegations: mock(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          delegations: [],
          total: 0,
        } satisfies NexusDelegationListResponse,
      }),
    ),
    recordOutcome: mock(() =>
      Promise.resolve({ ok: true as const, value: undefined }),
    ),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Grant tests (#9-A contract)
// ---------------------------------------------------------------------------

describe("NexusDelegationBackend.grant", () => {
  test("returns a DelegationGrant with nexus proof kind", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: AGENT_ID });

    const grant = await backend.grant({ permissions: { allow: ["read_file"] } }, CHILD_ID);

    expect(grant.id).toBe(delegationId("deleg-123"));
    expect(grant.issuerId).toBe(AGENT_ID);
    expect(grant.delegateeId).toBe(CHILD_ID);
    expect(grant.proof.kind).toBe("nexus");
    if (grant.proof.kind === "nexus") {
      expect(grant.proof.token).toBe("key-abc");
    }
  });

  test("passes idempotency key to Nexus API", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      idempotencyPrefix: "wf-run:",
    });

    await backend.grant({ permissions: {} }, CHILD_ID);

    const calls = (api.createDelegation as ReturnType<typeof mock>).mock.calls;
    const request = calls[0]?.[0] as { readonly idempotency_key: string } | undefined;
    expect(request).toBeDefined();
    expect(request?.idempotency_key).toBe(`wf-run:${AGENT_ID}:${CHILD_ID}`);
  });

  test("converts ttlMs to ttl_seconds", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: AGENT_ID });

    await backend.grant({ permissions: {} }, CHILD_ID, 120_000); // 2 minutes

    const calls = (api.createDelegation as ReturnType<typeof mock>).mock.calls;
    const request = calls[0]?.[0] as { readonly ttl_seconds: number } | undefined;
    expect(request).toBeDefined();
    expect(request?.ttl_seconds).toBe(120);
  });

  test("throws on Nexus API error", async () => {
    const api = createMockApi({
      createDelegation: mock(() =>
        Promise.resolve({
          ok: false as const,
          error: { code: "PERMISSION" as const, message: "Forbidden", retryable: false },
        }),
      ),
    });
    const backend = createNexusDelegationBackend({ api, agentId: AGENT_ID });

    await expect(
      backend.grant({ permissions: {} }, CHILD_ID),
    ).rejects.toThrow("Nexus delegation grant failed: Forbidden");
  });
});

// ---------------------------------------------------------------------------
// Revoke tests (#9-A contract)
// ---------------------------------------------------------------------------

describe("NexusDelegationBackend.revoke", () => {
  test("calls Nexus API with delegation ID", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: AGENT_ID });

    await backend.revoke(delegationId("deleg-123"));

    expect(api.revokeDelegation).toHaveBeenCalledWith(delegationId("deleg-123"));
  });

  test("is idempotent — NOT_FOUND is silent", async () => {
    const api = createMockApi({
      revokeDelegation: mock(() =>
        Promise.resolve({
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
        }),
      ),
    });
    const backend = createNexusDelegationBackend({ api, agentId: AGENT_ID });

    // Should not throw
    await backend.revoke(delegationId("deleg-123"));
  });

  test("throws on non-NOT_FOUND errors", async () => {
    const api = createMockApi({
      revokeDelegation: mock(() =>
        Promise.resolve({
          ok: false as const,
          error: { code: "EXTERNAL" as const, message: "Server error", retryable: true },
        }),
      ),
    });
    const backend = createNexusDelegationBackend({ api, agentId: AGENT_ID });

    await expect(
      backend.revoke(delegationId("deleg-123")),
    ).rejects.toThrow("Nexus delegation revoke failed: Server error");
  });

  test("invalidates verify cache on revoke", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 60_000,
    });

    // Populate cache
    await backend.verify(delegationId("deleg-123"), "read_file");
    // Revoke
    await backend.revoke(delegationId("deleg-123"));
    // Next verify should hit Nexus again (cache invalidated)
    await backend.verify(delegationId("deleg-123"), "read_file");

    expect(api.verifyChain).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Verify tests (#9-A contract, #13-A cache, #14-A server-side chain)
// ---------------------------------------------------------------------------

describe("NexusDelegationBackend.verify", () => {
  test("returns ok:true for valid chain", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 0, // No caching
    });

    const result = await backend.verify(delegationId("deleg-123"), "read_file");

    expect(result.ok).toBe(true);
  });

  test("returns ok:false with reason for invalid chain", async () => {
    const api = createMockApi({
      verifyChain: mock(() =>
        Promise.resolve({
          ok: true as const,
          value: {
            delegation_id: "deleg-123",
            valid: false,
            reason: "expired",
            chain_depth: 0,
          } satisfies NexusChainVerifyResponse,
        }),
      ),
    });
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 0,
    });

    const result = await backend.verify(delegationId("deleg-123"), "read_file");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }
  });

  test("maps NOT_FOUND to unknown_grant", async () => {
    const api = createMockApi({
      verifyChain: mock(() =>
        Promise.resolve({
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
        }),
      ),
    });
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 0,
    });

    const result = await backend.verify(delegationId("deleg-123"), "read_file");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown_grant");
    }
  });

  test("caches successful verify results (#13-A)", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 60_000,
    });

    await backend.verify(delegationId("deleg-123"), "read_file");
    await backend.verify(delegationId("deleg-123"), "read_file");

    // Second call should be served from cache
    expect(api.verifyChain).toHaveBeenCalledTimes(1);
  });

  test("serves stale cache entry while refreshing (#13-A)", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 10, // 10ms TTL
    });

    // First call — populates cache
    const result1 = await backend.verify(delegationId("deleg-123"), "read_file");
    expect(result1.ok).toBe(true);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Second call — stale, triggers background refresh
    const result2 = await backend.verify(delegationId("deleg-123"), "read_file");
    expect(result2.ok).toBe(true); // Served from stale cache
  });

  test("makes single call per verify — server-side chain (#14-A)", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 0,
    });

    await backend.verify(delegationId("deleg-123"), "read_file");

    // Only one verifyChain call — no N+1 client-side chain walking
    expect(api.verifyChain).toHaveBeenCalledTimes(1);
  });

  test("denies tool not in scope even when chain is valid (scope enforcement)", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 0,
    });

    // Grant with restricted scope — only read_file allowed
    const grant = await backend.grant(
      { permissions: { allow: ["read_file"] } },
      CHILD_ID,
    );

    // Verify with a denied tool — scope check should fail
    const result = await backend.verify(grant.id, "execute_command");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("scope_exceeded");
    }
  });

  test("allows tool in scope when chain is valid (scope enforcement)", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 0,
    });

    // Grant with read_file allowed
    const grant = await backend.grant(
      { permissions: { allow: ["read_file"] } },
      CHILD_ID,
    );

    const result = await backend.verify(grant.id, "read_file");
    expect(result.ok).toBe(true);
  });

  test("deny list overrides allow in scope enforcement", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 0,
    });

    // Grant with wildcard allow but deny on execute_command
    const grant = await backend.grant(
      { permissions: { allow: ["*"], deny: ["execute_command"] } },
      CHILD_ID,
    );

    const result = await backend.verify(grant.id, "execute_command");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("scope_exceeded");
    }
  });

  test("returns real grant scope in verify result (not stub)", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 0,
    });

    const scope = { permissions: { allow: ["read_file", "write_file"] } };
    const grant = await backend.grant(scope, CHILD_ID);

    const result = await backend.verify(grant.id, "read_file");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant.scope).toEqual(scope);
      expect(result.grant.delegateeId).toBe(CHILD_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency key tests (#4 fix)
// ---------------------------------------------------------------------------

describe("NexusDelegationBackend idempotency", () => {
  test("without prefix, each grant() gets a unique idempotency key", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      // No idempotencyPrefix — general API mode
    });

    await backend.grant({ permissions: {} }, CHILD_ID);
    await backend.grant({ permissions: {} }, CHILD_ID);

    const calls = (api.createDelegation as ReturnType<typeof mock>).mock.calls;
    const key1 = (calls[0]?.[0] as { readonly idempotency_key: string } | undefined)
      ?.idempotency_key;
    const key2 = (calls[1]?.[0] as { readonly idempotency_key: string } | undefined)
      ?.idempotency_key;

    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    expect(key1).not.toBe(key2); // Different keys — no collapsing
  });

  test("with prefix, same delegatee gets deterministic key (Temporal retry-safe)", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      idempotencyPrefix: "wf-run:",
    });

    await backend.grant({ permissions: {} }, CHILD_ID);
    await backend.grant({ permissions: {} }, CHILD_ID);

    const calls = (api.createDelegation as ReturnType<typeof mock>).mock.calls;
    const key1 = (calls[0]?.[0] as { readonly idempotency_key: string } | undefined)
      ?.idempotency_key;
    const key2 = (calls[1]?.[0] as { readonly idempotency_key: string } | undefined)
      ?.idempotency_key;

    expect(key1).toBe(key2); // Same key — retries collapse
    expect(key1).toBe(`wf-run:${AGENT_ID}:${CHILD_ID}`);
  });
});

// ---------------------------------------------------------------------------
// List tests (#9-A contract)
// ---------------------------------------------------------------------------

describe("NexusDelegationBackend.list", () => {
  test("returns empty array when no delegations", async () => {
    const api = createMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: AGENT_ID });

    const grants = await backend.list();

    expect(grants).toEqual([]);
  });

  test("paginates through multiple pages", async () => {
    let callCount = 0;
    const api = createMockApi({
      listDelegations: mock((cursor?: string) => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true as const,
            value: {
              delegations: [
                {
                  delegation_id: "d1",
                  parent_agent_id: AGENT_ID,
                  child_agent_id: "child1",
                  namespace_mode: "COPY" as const,
                  created_at: "2026-01-01T00:00:00Z",
                  expires_at: "2026-01-01T01:00:00Z",
                },
              ],
              total: 2,
              cursor: "page2",
            } satisfies NexusDelegationListResponse,
          });
        }
        return Promise.resolve({
          ok: true as const,
          value: {
            delegations: [
              {
                delegation_id: "d2",
                parent_agent_id: AGENT_ID,
                child_agent_id: "child2",
                namespace_mode: "CLEAN" as const,
                created_at: "2026-01-01T00:00:00Z",
                expires_at: "2026-01-01T01:00:00Z",
              },
            ],
            total: 2,
          } satisfies NexusDelegationListResponse,
        });
      }),
    });
    const backend = createNexusDelegationBackend({ api, agentId: AGENT_ID });

    const grants = await backend.list();

    expect(grants).toHaveLength(2);
    expect(grants[0]?.id).toBe(delegationId("d1"));
    expect(grants[1]?.id).toBe(delegationId("d2"));
  });

  test("throws on API error", async () => {
    const api = createMockApi({
      listDelegations: mock(() =>
        Promise.resolve({
          ok: false as const,
          error: { code: "EXTERNAL" as const, message: "Server error", retryable: true },
        }),
      ),
    });
    const backend = createNexusDelegationBackend({ api, agentId: AGENT_ID });

    await expect(backend.list()).rejects.toThrow("Nexus delegation list failed");
  });
});

// ---------------------------------------------------------------------------
// Nexus unavailability (#12-A)
// ---------------------------------------------------------------------------

describe("Nexus unavailability", () => {
  test("verify serves cached result when Nexus is down", async () => {
    let shouldFail = false;
    const api = createMockApi({
      verifyChain: mock(() => {
        if (shouldFail) {
          return Promise.resolve({
            ok: false as const,
            error: { code: "EXTERNAL" as const, message: "Connection refused", retryable: true },
          });
        }
        return Promise.resolve({
          ok: true as const,
          value: {
            delegation_id: "deleg-123",
            valid: true,
            chain_depth: 0,
          } satisfies NexusChainVerifyResponse,
        });
      }),
    });
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 60_000,
    });

    // Populate cache while Nexus is up
    const result1 = await backend.verify(delegationId("deleg-123"), "read_file");
    expect(result1.ok).toBe(true);

    // Nexus goes down — cached result still served
    shouldFail = true;
    const result2 = await backend.verify(delegationId("deleg-123"), "read_file");
    expect(result2.ok).toBe(true);
  });

  test("verify returns error when Nexus is down and no cache", async () => {
    const api = createMockApi({
      verifyChain: mock(() =>
        Promise.resolve({
          ok: false as const,
          error: { code: "EXTERNAL" as const, message: "Connection refused", retryable: true },
        }),
      ),
    });
    const backend = createNexusDelegationBackend({
      api,
      agentId: AGENT_ID,
      verifyCacheTtlMs: 0, // No caching
    });

    const result = await backend.verify(delegationId("deleg-123"), "read_file");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  test("grant throws when Nexus is down", async () => {
    const api = createMockApi({
      createDelegation: mock(() =>
        Promise.resolve({
          ok: false as const,
          error: { code: "EXTERNAL" as const, message: "Connection refused", retryable: true },
        }),
      ),
    });
    const backend = createNexusDelegationBackend({ api, agentId: AGENT_ID });

    await expect(
      backend.grant({ permissions: {} }, CHILD_ID),
    ).rejects.toThrow("Connection refused");
  });
});
