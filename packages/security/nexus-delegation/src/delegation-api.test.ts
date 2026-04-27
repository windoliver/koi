import { describe, expect, test } from "bun:test";
import { delegationId } from "@koi/core";
import { createNexusDelegationApi } from "./delegation-api.js";

const BASE_URL = "http://nexus.test";
const TEST_KEY = "test-api-key";
const GRANT_ID = delegationId("del-abc");

function makeErrorFetch(status: number): typeof fetch {
  return (async (_input: string | URL | Request) =>
    new Response(JSON.stringify({ error: "oops" }), { status })) as unknown as typeof fetch;
}

describe("createNexusDelegationApi", () => {
  test("createDelegation sends POST with Authorization header", async () => {
    let captured: Request | undefined;
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return new Response(
        JSON.stringify({
          delegation_id: "del-abc",
          api_key: "child-key-123",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const api = createNexusDelegationApi({ url: BASE_URL, apiKey: TEST_KEY, fetch: mockFetch });
    const result = await api.createDelegation({
      parent_agent_id: "parent-1",
      child_agent_id: "child-1",
      scope: { allowed_operations: ["read_file"], remove_grants: [] },
      namespace_mode: "COPY",
      max_depth: 3,
      ttl_seconds: 3600,
      can_sub_delegate: true,
      idempotency_key: "idem-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.api_key).toBe("child-key-123");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.get("Authorization")).toBe(`Bearer ${TEST_KEY}`);
  });

  test("revokeDelegation sends DELETE to correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: string | URL | Request) => {
      capturedUrl = input as string;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const api = createNexusDelegationApi({ url: BASE_URL, fetch: mockFetch });
    const result = await api.revokeDelegation(GRANT_ID);
    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain(`/api/v2/agents/delegate/${GRANT_ID}`);
  });

  test("revokeDelegation treats 404 as success", async () => {
    const api = createNexusDelegationApi({ url: BASE_URL, fetch: makeErrorFetch(404) });
    const result = await api.revokeDelegation(GRANT_ID);
    expect(result.ok).toBe(true);
  });

  test("createDelegation returns error result on 500", async () => {
    const api = createNexusDelegationApi({ url: BASE_URL, fetch: makeErrorFetch(500) });
    const result = await api.createDelegation({
      parent_agent_id: "p",
      child_agent_id: "c",
      scope: { allowed_operations: [], remove_grants: [] },
      namespace_mode: "COPY",
      max_depth: 3,
      ttl_seconds: 3600,
      can_sub_delegate: false,
      idempotency_key: "k",
    });
    expect(result.ok).toBe(false);
  });

  test("verifyChain sends GET to chain URL", async () => {
    let capturedUrl = "";
    const api = createNexusDelegationApi({
      url: BASE_URL,
      fetch: (async (input: string | URL | Request) => {
        capturedUrl = input as string;
        return new Response(
          JSON.stringify({ delegation_id: GRANT_ID, valid: true, chain_depth: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const result = await api.verifyChain(GRANT_ID);
    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain(`${GRANT_ID}/chain`);
  });

  test("listDelegations paginates with cursor", async () => {
    let capturedUrl = "";
    const api = createNexusDelegationApi({
      url: BASE_URL,
      fetch: (async (input: string | URL | Request) => {
        capturedUrl = input as string;
        return new Response(JSON.stringify({ delegations: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    await api.listDelegations("cursor-xyz");
    expect(capturedUrl).toContain("cursor=cursor-xyz");
  });
});
