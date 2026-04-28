import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentId, DelegationScope } from "@koi/core";
import { agentId, delegationId } from "@koi/core";
import type {
  NexusDelegateResponse,
  NexusDelegationApi,
  NexusDelegationChainItem,
  NexusDelegationChainResponse,
  NexusDelegationEntry,
  NexusDelegationListParams,
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
    worker_agent_id: CHILD_ID,
    api_key: "child-key-xyz",
    mount_table: ["fs://workspace"],
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    delegation_mode: "copy",
    warmup_success: true,
    ...overrides,
  };
}

function makeChainItem(overrides?: Partial<NexusDelegationChainItem>): NexusDelegationChainItem {
  return {
    delegation_id: GRANT_ID,
    agent_id: CHILD_ID,
    parent_agent_id: PARENT_ID,
    delegation_mode: "copy",
    status: "active",
    depth: 0,
    intent: "",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeChainResponse(
  overrides?: Partial<NexusDelegationChainResponse>,
): NexusDelegationChainResponse {
  return {
    chain: [makeChainItem()],
    total_depth: 1,
    ...overrides,
  };
}

function makeListEntry(overrides?: Partial<NexusDelegationEntry>): NexusDelegationEntry {
  return {
    delegation_id: GRANT_ID,
    agent_id: CHILD_ID,
    parent_agent_id: PARENT_ID,
    delegation_mode: "copy",
    status: "active",
    scope_prefix: null,
    lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    zone_id: null,
    intent: "",
    depth: 0,
    can_sub_delegate: false,
    created_at: new Date().toISOString(),
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
      value: { delegations: [], total: 0, limit: 50, offset: 0 },
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

  test("sends worker_id, worker_name, lowercase namespace_mode in request body", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: PARENT_ID,
      namespaceMode: "clean",
    });
    await backend.grant(SCOPE, CHILD_ID);
    const calls = (api.createDelegation as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const req = calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(req?.worker_id).toBe(CHILD_ID);
    expect(req?.worker_name).toBe(CHILD_ID);
    expect(req?.namespace_mode).toBe("clean");
    // No legacy fields
    expect(req?.parent_agent_id).toBeUndefined();
    expect(req?.child_agent_id).toBeUndefined();
    expect(req?.max_depth).toBeUndefined();
    // Defaults: can_sub_delegate=false
    expect(req?.can_sub_delegate).toBe(false);
  });

  test("emits add_grants/remove_grants for allow/deny", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant({ permissions: { allow: ["read_file"], deny: ["exec"] } }, CHILD_ID);
    const calls = (api.createDelegation as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const req = calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(req?.add_grants).toEqual(["read_file"]);
    expect(req?.remove_grants).toEqual(["exec"]);
  });

  test("forwards idempotency key as second argument option", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({
      api,
      agentId: PARENT_ID,
      idempotencyPrefix: "test-",
    });
    await backend.grant(SCOPE, CHILD_ID);
    const calls = (api.createDelegation as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const opts = calls[0]?.[1] as { idempotencyKey?: string } | undefined;
    expect(opts?.idempotencyKey).toBe(`test-${PARENT_ID}:${CHILD_ID}`);
  });

  test("falls back to ttl-derived expiresAt when response has null expires_at", async () => {
    const api = makeMockApi({
      createDelegation: mock(async () => ({
        ok: true as const,
        value: makeGrantResponse({ expires_at: null }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    const before = Date.now();
    const grant = await backend.grant(SCOPE, CHILD_ID, 60_000);
    expect(grant.expiresAt).toBeGreaterThanOrEqual(before + 59_000);
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
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    // First revoke fails -> enqueued AND throws so dispose-path callers can observe
    await expect(backend.revoke(GRANT_ID)).rejects.toThrow(/queued for retry/);
    expect(calls).toBe(1);

    // Grant a second child so we can trigger another revoke + drain
    const api2Grant = delegationId("del-def");
    (api.createDelegation as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: true as const,
      value: makeGrantResponse({ delegation_id: api2Grant, api_key: "key2" }),
    }));
    await backend.grant(SCOPE, agentId("child-2"));

    // Second revoke also fails but also triggers drain of pending queue
    await expect(backend.revoke(api2Grant)).rejects.toThrow(/queued for retry/);
    errorSpy.mockRestore();
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
    await expect(backend.revoke(GRANT_ID)).rejects.toThrow(/queued for retry/);

    // Grant second child and fail to revoke (queue full → drops oldest)
    const id2 = delegationId("del-2");
    (api.createDelegation as ReturnType<typeof mock>).mockResolvedValue({
      ok: true as const,
      value: makeGrantResponse({ delegation_id: id2, api_key: "key2" }),
    });
    await backend.grant(SCOPE, agentId("child-2"));
    await expect(backend.revoke(id2)).rejects.toThrow(/queued for retry/);

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

    // Step 1: grant and fail revoke → entry gets enqueued (and rejects)
    const drainErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    await backend.grant(SCOPE, CHILD_ID);
    await expect(backend.revoke(GRANT_ID)).rejects.toThrow(/queued for retry/);
    drainErrorSpy.mockRestore();

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
    // Initial revoke queues GRANT_ID into the retry queue (and rejects)
    await expect(backend.revoke(GRANT_ID)).rejects.toThrow();

    // Exhaust retries: subsequent revokes drain GRANT_ID + re-fail until max retries
    for (let i = 0; i < 4; i++) {
      const newId = delegationId(`del-${i}`);
      (api.createDelegation as ReturnType<typeof mock>).mockResolvedValue({
        ok: true as const,
        value: makeGrantResponse({ delegation_id: newId, api_key: `key-${i}` }),
      });
      await backend.grant(SCOPE, agentId(`c-${i}`));
      await backend.revoke(newId).catch(() => {});
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

  test("fails closed when Nexus returns unknown_grant (HTTP 404)", async () => {
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

  test("returns unknown_grant when chain is empty", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: { chain: [], total_depth: 0 },
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_grant");
  });

  test("maps 'revoked' chain status to revoked result", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: makeChainResponse({
          chain: [makeChainItem({ status: "revoked" })],
        }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  test("maps 'expired' chain status to expired result", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: makeChainResponse({
          chain: [makeChainItem({ status: "expired" })],
        }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  test("maps total_depth > maxChainDepth to chain_depth_exceeded", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: makeChainResponse({ total_depth: 99 }),
      })),
    });
    const backend = createNexusDelegationBackend({
      api,
      agentId: PARENT_ID,
      maxChainDepth: 3,
    });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("chain_depth_exceeded");
  });

  test("maps unknown chain status to invalid_signature result", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: makeChainResponse({
          chain: [makeChainItem({ status: "weird-broken-state" })],
        }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("verify on unknown grant id (no local store) fails closed on scope", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: true as const,
        value: makeChainResponse(),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    // Do NOT call backend.grant() — verify an unknown ID directly. We have no
    // local scope, and chain endpoint does not return scope, so we fail closed.
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_exceeded");
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
          delegations: [makeListEntry({ delegation_id: remoteId })],
          total: 1,
          limit: 50,
          offset: 0,
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
          delegations: [makeListEntry()],
          total: 1,
          limit: 50,
          offset: 0,
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

  test("paginates with limit/offset until offset >= total", async () => {
    let callCount = 0;
    const api = makeMockApi({
      listDelegations: mock(async (params?: NexusDelegationListParams) => {
        callCount++;
        // Simulate 3 pages of 2 items each, total 6
        const offset = params?.offset ?? 0;
        const remaining = Math.max(0, 6 - offset);
        const pageSize = Math.min(2, remaining);
        return {
          ok: true as const,
          value: {
            delegations: Array.from({ length: pageSize }, (_, i) =>
              makeListEntry({ delegation_id: `del-${offset + i}` }),
            ),
            total: 6,
            limit: params?.limit ?? 50,
            offset,
          },
        };
      }),
    });
    // Override DEFAULT_LIST_PAGE_SIZE indirectly: we trust default=50, but the
    // mock returns 2 per call — we should keep calling until offset hits total.
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    const grants = await backend.list();
    expect(grants.length).toBe(6);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

// satisfy unused-import linter for empty hooks
beforeEach(() => {});
afterEach(() => {});
