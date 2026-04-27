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
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("list()", () => {
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
