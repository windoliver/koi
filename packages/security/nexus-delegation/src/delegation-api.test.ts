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

function makeOkResponse(): Response {
  return new Response(
    JSON.stringify({
      delegation_id: "del-abc",
      worker_agent_id: "child-1",
      api_key: "child-key-123",
      mount_table: ["fs://workspace"],
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      delegation_mode: "copy",
      warmup_success: true,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("createNexusDelegationApi", () => {
  test("createDelegation sends POST with Authorization header", async () => {
    let captured: Request | undefined;
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return makeOkResponse();
    }) as unknown as typeof fetch;
    const api = createNexusDelegationApi({ url: BASE_URL, apiKey: TEST_KEY, fetch: mockFetch });
    const result = await api.createDelegation({
      worker_id: "child-1",
      worker_name: "child-1",
      namespace_mode: "copy",
      ttl_seconds: 3600,
      can_sub_delegate: false,
      intent: "test",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.api_key).toBe("child-key-123");
      expect(result.value.worker_agent_id).toBe("child-1");
      expect(result.value.mount_table).toEqual(["fs://workspace"]);
      expect(result.value.delegation_mode).toBe("copy");
    }
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.get("Authorization")).toBe(`Bearer ${TEST_KEY}`);
  });

  test("createDelegation forwards Idempotency-Key header when provided", async () => {
    let capturedHeaders: Headers | undefined;
    const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return makeOkResponse();
    }) as unknown as typeof fetch;
    const api = createNexusDelegationApi({ url: BASE_URL, fetch: mockFetch });
    await api.createDelegation(
      {
        worker_id: "c",
        worker_name: "c",
        namespace_mode: "copy",
      },
      { idempotencyKey: "idem-99" },
    );
    expect(capturedHeaders?.get("Idempotency-Key")).toBe("idem-99");
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
      worker_id: "c",
      worker_name: "c",
      namespace_mode: "copy",
    });
    expect(result.ok).toBe(false);
  });

  test("verifyChain sends GET to chain URL", async () => {
    let capturedUrl = "";
    const api = createNexusDelegationApi({
      url: BASE_URL,
      fetch: (async (input: string | URL | Request) => {
        capturedUrl = input as string;
        return new Response(JSON.stringify({ chain: [], total_depth: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const result = await api.verifyChain(GRANT_ID);
    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain(`${GRANT_ID}/chain`);
  });

  test("listDelegations paginates with limit & offset", async () => {
    let capturedUrl = "";
    const api = createNexusDelegationApi({
      url: BASE_URL,
      fetch: (async (input: string | URL | Request) => {
        capturedUrl = input as string;
        return new Response(JSON.stringify({ delegations: [], total: 0, limit: 25, offset: 50 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    await api.listDelegations({ limit: 25, offset: 50 });
    expect(capturedUrl).toContain("limit=25");
    expect(capturedUrl).toContain("offset=50");
  });

  test("listDelegations omits query params when none provided", async () => {
    let capturedUrl = "";
    const api = createNexusDelegationApi({
      url: BASE_URL,
      fetch: (async (input: string | URL | Request) => {
        capturedUrl = input as string;
        return new Response(JSON.stringify({ delegations: [], total: 0, limit: 50, offset: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    await api.listDelegations();
    expect(capturedUrl).not.toContain("?");
  });
});
