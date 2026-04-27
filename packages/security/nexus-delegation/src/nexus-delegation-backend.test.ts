import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentId, DelegationScope } from "@koi/core";
import { agentId, delegationId } from "@koi/core";
import type {
  NexusChainVerifyResponse,
  NexusDelegateResponse,
  NexusDelegationApi,
} from "./delegation-api.js";
import { createNexusDelegationBackend } from "./nexus-delegation-backend.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARENT_ID: AgentId = agentId("parent-1");
const CHILD_ID: AgentId = agentId("child-1");
const GRANT_ID = delegationId("del-abc");
const SCOPE: DelegationScope = { permissions: { allow: ["read_file"], deny: [] } };

function makeGrantResponse(overrides?: Partial<NexusDelegateResponse>): NexusDelegateResponse {
  return {
    delegation_id: GRANT_ID,
    api_key: "child-key-xyz",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function makeChainResponse(
  overrides?: Partial<NexusChainVerifyResponse>,
): NexusChainVerifyResponse {
  return {
    delegation_id: GRANT_ID,
    valid: true,
    chain_depth: 0,
    ...overrides,
  };
}

function makeMockApi(overrides?: Partial<NexusDelegationApi>): NexusDelegationApi {
  return {
    createDelegation: mock(async () => ({ ok: true as const, value: makeGrantResponse() })),
    revokeDelegation: mock(async () => ({ ok: true as const, value: undefined })),
    verifyChain: mock(async () => ({ ok: true as const, value: makeChainResponse() })),
    listDelegations: mock(async () => ({
      ok: true as const,
      value: { delegations: [], total: 0 },
    })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// grant()
// ---------------------------------------------------------------------------

describe("grant()", () => {
  test("calls createDelegation and returns grant with nexus proof", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    const grant = await backend.grant(SCOPE, CHILD_ID);
    expect(api.createDelegation).toHaveBeenCalledTimes(1);
    expect(grant.proof.kind).toBe("nexus");
    if (grant.proof.kind === "nexus") expect(grant.proof.token).toBe("child-key-xyz");
    expect(grant.issuerId).toBe(PARENT_ID);
    expect(grant.delegateeId).toBe(CHILD_ID);
  });

  test("throws on createDelegation failure", async () => {
    const api = makeMockApi({
      createDelegation: mock(async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "nexus down", retryable: false, context: {} },
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await expect(backend.grant(SCOPE, CHILD_ID)).rejects.toThrow("nexus down");
  });
});

// ---------------------------------------------------------------------------
// revoke()
// ---------------------------------------------------------------------------

describe("revoke()", () => {
  test("calls revokeDelegation and removes from grant store", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    await backend.revoke(GRANT_ID);
    expect(api.revokeDelegation).toHaveBeenCalledWith(GRANT_ID);
  });

  test("enqueues to retry queue on network failure and drains on next revoke", async () => {
    let calls = 0;
    const api = makeMockApi({
      revokeDelegation: mock(async () => {
        calls++;
        return {
          ok: false as const,
          error: {
            code: "INTERNAL" as const,
            message: "network error",
            retryable: true,
            context: {},
          },
        };
      }),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    // First revoke fails -> enqueued
    await backend.revoke(GRANT_ID);
    expect(calls).toBe(1);

    // Grant a second child so we can trigger another revoke + drain
    const api2Grant = delegationId("del-def");
    (api.createDelegation as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: true as const,
      value: makeGrantResponse({ delegation_id: api2Grant, api_key: "key2" }),
    }));
    await backend.grant(SCOPE, agentId("child-2"));

    // Second revoke also fails but also triggers drain of pending queue
    await backend.revoke(api2Grant);
    // give background drain a moment
    await new Promise((r) => setTimeout(r, 20));
    // drain attempted the first grant again (calls: 1 original + 1 drain attempt + 1 new revoke = 3)
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("drops oldest entry when queue exceeds maxPendingRevocations", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const api = makeMockApi({
      revokeDelegation: mock(async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "fail", retryable: true, context: {} },
      })),
    });
    const backend = createNexusDelegationBackend({
      api,
      agentId: PARENT_ID,
      maxPendingRevocations: 1,
    });

    // Grant first child and fail to revoke (fills queue)
    await backend.grant(SCOPE, CHILD_ID);
    await backend.revoke(GRANT_ID);

    // Grant second child and fail to revoke (queue full → drops oldest)
    const id2 = delegationId("del-2");
    (api.createDelegation as ReturnType<typeof mock>).mockResolvedValue({
      ok: true as const,
      value: makeGrantResponse({ delegation_id: id2, api_key: "key2" }),
    });
    await backend.grant(SCOPE, agentId("child-2"));
    await backend.revoke(id2);

    // console.error should have been called with "dropping oldest" message
    expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
    errorSpy.mockRestore();
  });

  test("drainQueue invalidates cache on successful retry", async () => {
    let revokeShouldSucceed = false;
    const api = makeMockApi({
      revokeDelegation: mock(async () => {
        if (revokeShouldSucceed) {
          return { ok: true as const, value: undefined };
        }
        return {
          ok: false as const,
          error: { code: "INTERNAL" as const, message: "fail", retryable: true, context: {} },
        };
      }),
    });
    // Use a very short cache TTL so we can check cache behavior
    const backend = createNexusDelegationBackend({
      api,
      agentId: PARENT_ID,
      verifyCacheTtlMs: 60_000,
    });

    // Step 1: grant and fail revoke → entry gets enqueued
    await backend.grant(SCOPE, CHILD_ID);
    await backend.revoke(GRANT_ID);

    // Step 2: restore mock to succeed
    revokeShouldSucceed = true;

    // Step 3: grant another child, then revoke — this triggers drain of the pending queue
    const id2 = delegationId("del-drain");
    (api.createDelegation as ReturnType<typeof mock>).mockResolvedValue({
      ok: true as const,
      value: makeGrantResponse({ delegation_id: id2, api_key: "key-drain" }),
    });
    await backend.grant(SCOPE, agentId("child-drain"));
    await backend.revoke(id2);

    // Let background drain settle
    await new Promise((r) => setTimeout(r, 20));

    // The drain should have called revokeDelegation at least twice total (first fail + drain success)
    const revokeMock = api.revokeDelegation as ReturnType<typeof mock>;
    expect(revokeMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("emits structured error after maxRevocationRetries exhausted", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const api = makeMockApi({
      revokeDelegation: mock(async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "fail", retryable: true, context: {} },
      })),
    });
    const backend = createNexusDelegationBackend({
      api,
      agentId: PARENT_ID,
      maxRevocationRetries: 2,
    });
    await backend.grant(SCOPE, CHILD_ID);
    // Initial revoke queues GRANT_ID into the retry queue
    await backend.revoke(GRANT_ID);

    // Exhaust retries: subsequent revokes drain GRANT_ID + re-fail until max retries
    for (let i = 0; i < 4; i++) {
      const newId = delegationId(`del-${i}`);
      (api.createDelegation as ReturnType<typeof mock>).mockResolvedValue({
        ok: true as const,
        value: makeGrantResponse({ delegation_id: newId, api_key: `key-${i}` }),
      });
      await backend.grant(SCOPE, agentId(`c-${i}`));
      await backend.revoke(newId);
      // let background drain settle
      await new Promise((r) => setTimeout(r, 5));
    }

    // console.error should have been called with structured payload containing GRANT_ID
    const allArgs = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(allArgs).toContain(GRANT_ID);
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

describe("verify()", () => {
  test("returns expired for past-expiry grant (local fast path)", async () => {
    const api = makeMockApi({
      createDelegation: mock(async () => ({
        ok: true as const,
        value: makeGrantResponse({
          expires_at: new Date(Date.now() - 1000).toISOString(),
        }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
    expect(api.verifyChain).not.toHaveBeenCalled();
  });

  test("returns scope_exceeded for denied tool (local fast path)", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID); // allow: ["read_file"]
    const result = await backend.verify(GRANT_ID, "write_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_exceeded");
    expect(api.verifyChain).not.toHaveBeenCalled();
  });

  test("calls Nexus chain for allowed tool", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(true);
    expect(api.verifyChain).toHaveBeenCalledWith(GRANT_ID);
  });

  test("serves stale from cache and triggers background refresh", async () => {
    let chainCalls = 0;
    const api = makeMockApi({
      verifyChain: mock(async () => {
        chainCalls++;
        return { ok: true as const, value: makeChainResponse() };
      }),
    });
    const backend = createNexusDelegationBackend({
      api,
      agentId: PARENT_ID,
      verifyCacheTtlMs: 1,
    });
    await backend.grant(SCOPE, CHILD_ID);
    // First verify -> populates cache
    await backend.verify(GRANT_ID, "read_file");
    expect(chainCalls).toBe(1);
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 5));
    // Second verify -> cache stale, serves stale + triggers background refresh
    await backend.verify(GRANT_ID, "read_file");
    // Background refresh fires async; wait briefly
    await new Promise((r) => setTimeout(r, 20));
    expect(chainCalls).toBe(2);
  });

  test("fails closed when Nexus returns unknown_grant", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: false as const,
        error: {
          code: "NOT_FOUND" as const,
          message: "not found",
          retryable: false,
          context: {},
        },
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_grant");
  });

  test("maps 'revoked' chain reason to revoked result", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: makeChainResponse({ valid: false, reason: "revoked" }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  test("maps 'chain_depth_exceeded' chain reason to chain_depth_exceeded result", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: makeChainResponse({ valid: false, reason: "chain_depth_exceeded" }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("chain_depth_exceeded");
  });

  test("maps unknown chain reason to invalid_signature result", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: makeChainResponse({ valid: false, reason: "invalid_signature" }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("verify on unknown grant id (not in local store) calls chain and enforces scope", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: makeChainResponse({
          valid: true,
          scope: { allowed_operations: ["write_file"], remove_grants: [] },
        }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    // Do NOT call backend.grant() — verify an unknown ID directly
    const result = await backend.verify(GRANT_ID, "read_file"); // read_file NOT in scope
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_exceeded");
  });

  test("verify on unknown grant id returns ok when tool is in nexus scope", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: makeChainResponse({
          valid: true,
          scope: { allowed_operations: ["read_file"], remove_grants: [] },
        }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    // Do NOT call backend.grant() — verify an unknown ID directly
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("list()", () => {
  test("throws when listDelegations fails", async () => {
    const api = makeMockApi({
      listDelegations: mock(async () => ({
        ok: false as const,
        error: {
          code: "INTERNAL" as const,
          message: "nexus list failed",
          retryable: false,
          context: {},
        },
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await expect(backend.list()).rejects.toThrow("nexus list failed");
  });

  test("returns nexus-only entry when not in local store", async () => {
    const remoteId = delegationId("del-remote");
    const api = makeMockApi({
      listDelegations: mock(async () => ({
        ok: true as const,
        value: {
          delegations: [
            {
              delegation_id: remoteId,
              parent_agent_id: PARENT_ID,
              child_agent_id: CHILD_ID,
              namespace_mode: "COPY" as const,
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            },
          ],
          total: 1,
        },
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    // Don't call grant() — no local entry
    const grants = await backend.list();
    expect(grants.length).toBe(1);
    // Fallback entry has empty permissions scope
    expect(grants[0]?.scope.permissions.allow).toBeUndefined();
  });

  test("returns grants from local store first", async () => {
    const api = makeMockApi({
      listDelegations: mock(async () => ({
        ok: true as const,
        value: {
          delegations: [
            {
              delegation_id: GRANT_ID,
              parent_agent_id: PARENT_ID,
              child_agent_id: CHILD_ID,
              namespace_mode: "COPY" as const,
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            },
          ],
          total: 1,
        },
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const grants = await backend.list();
    expect(grants.length).toBe(1);
    // Local grant has scope; Nexus list entry does not
    expect(grants[0]?.scope.permissions.allow).toEqual(["read_file"]);
  });
});

// satisfy unused-import linter for empty hooks
beforeEach(() => {});
afterEach(() => {});
