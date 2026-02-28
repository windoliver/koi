/**
 * Tests for the Nexus JSON-RPC client.
 */

import { describe, expect, test } from "bun:test";
import type { FetchFn, NexusRegistryConfig } from "./config.js";
import {
  nexusDeleteAgent,
  nexusGetAgent,
  nexusListAgents,
  nexusRegisterAgent,
  nexusRpc,
  nexusTransition,
} from "./nexus-client.js";

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

function createConfig(
  fetchFn: FetchFn,
  overrides?: Partial<NexusRegistryConfig>,
): NexusRegistryConfig {
  return {
    baseUrl: "https://nexus.test",
    apiKey: "sk-test",
    timeoutMs: 5000,
    fetch: fetchFn,
    ...overrides,
  };
}

function mockJsonRpcSuccess(result: unknown): FetchFn {
  return async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", result, id: "test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function mockJsonRpcError(code: number, message: string): FetchFn {
  return async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code, message },
        id: "test",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
}

function mockHttpError(status: number, statusText: string): FetchFn {
  return async () => new Response(null, { status, statusText });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("nexusRpc", () => {
  test("sends correct JSON-RPC 2.0 envelope", async () => {
    // let: captured in mock
    let capturedBody: unknown;

    const fetchFn: FetchFn = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: "ok", id: "test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const config = createConfig(fetchFn);
    await nexusRpc(config, "test_method", { key: "value" });

    expect(capturedBody).toBeDefined();
    const body = capturedBody as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("test_method");
    expect(body.params).toEqual({ key: "value" });
    expect(typeof body.id).toBe("string");
  });

  test("sends correct URL and headers", async () => {
    // let: captured in mock
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    const fetchFn: FetchFn = async (input, init) => {
      capturedUrl = input as string;
      const headers = init?.headers as Record<string, string>;
      capturedHeaders = headers;
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: {}, id: "1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const config = createConfig(fetchFn);
    await nexusRpc(config, "get_agent", {});

    expect(capturedUrl).toBe("https://nexus.test/api/nfs/get_agent");
    expect(capturedHeaders?.Authorization).toBe("Bearer sk-test");
    expect(capturedHeaders?.["Content-Type"]).toBe("application/json");
  });

  test("returns success result", async () => {
    const config = createConfig(mockJsonRpcSuccess({ agent_id: "a1" }));
    const result = await nexusRpc<{ readonly agent_id: string }>(config, "get_agent", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agent_id).toBe("a1");
    }
  });

  test("maps JSON-RPC error code -32006 to CONFLICT", async () => {
    const config = createConfig(mockJsonRpcError(-32006, "generation mismatch"));
    const result = await nexusRpc(config, "agent_transition", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("maps JSON-RPC error code -32000 to NOT_FOUND", async () => {
    const config = createConfig(mockJsonRpcError(-32000, "agent not found"));
    const result = await nexusRpc(config, "get_agent", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("maps JSON-RPC error code -32003 to PERMISSION", async () => {
    const config = createConfig(mockJsonRpcError(-32003, "unauthorized"));
    const result = await nexusRpc(config, "register_agent", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("maps JSON-RPC error code -32005 to VALIDATION", async () => {
    const config = createConfig(mockJsonRpcError(-32005, "invalid params"));
    const result = await nexusRpc(config, "register_agent", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("maps unknown JSON-RPC error code to EXTERNAL", async () => {
    const config = createConfig(mockJsonRpcError(-32099, "unknown error"));
    const result = await nexusRpc(config, "some_method", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
    }
  });

  test("maps HTTP 500 to retryable EXTERNAL error", async () => {
    const config = createConfig(mockHttpError(500, "Internal Server Error"));
    const result = await nexusRpc(config, "get_agent", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("maps HTTP 403 to non-retryable EXTERNAL error", async () => {
    const config = createConfig(mockHttpError(403, "Forbidden"));
    const result = await nexusRpc(config, "get_agent", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("returns TIMEOUT on abort", async () => {
    const fetchFn: FetchFn = async (_input, init) => {
      // Wait longer than timeout
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
      return new Response();
    };

    const config = createConfig(fetchFn, { timeoutMs: 50 });
    const result = await nexusRpc(config, "slow_method", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("returns EXTERNAL on network error", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };

    const config = createConfig(fetchFn);
    const result = await nexusRpc(config, "get_agent", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("ECONNREFUSED");
    }
  });
});

// ---------------------------------------------------------------------------
// Higher-level RPC methods
// ---------------------------------------------------------------------------

describe("nexusRegisterAgent", () => {
  test("calls register_agent with correct params", async () => {
    // let: captured in mock
    let capturedBody: Record<string, unknown> | undefined;

    const fetchFn: FetchFn = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", result: { agent_id: "a1", state: "UNKNOWN" }, id: "1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const config = createConfig(fetchFn);
    const result = await nexusRegisterAgent(config, {
      agent_id: "a1",
      name: "test-agent",
      zone_id: "z1",
    });

    expect(result.ok).toBe(true);
    expect(capturedBody?.method).toBe("register_agent");
    const params = capturedBody?.params as Record<string, unknown>;
    expect(params.agent_id).toBe("a1");
  });
});

describe("nexusDeleteAgent", () => {
  test("calls delete_agent", async () => {
    // let: captured in mock
    let capturedBody: Record<string, unknown> | undefined;

    const fetchFn: FetchFn = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: true, id: "1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const config = createConfig(fetchFn);
    await nexusDeleteAgent(config, "a1");

    expect(capturedBody?.method).toBe("delete_agent");
  });
});

describe("nexusTransition", () => {
  test("calls agent_transition with CAS params", async () => {
    // let: captured in mock
    let capturedBody: Record<string, unknown> | undefined;

    const fetchFn: FetchFn = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: { agent_id: "a1", state: "CONNECTED", generation: 1 },
          id: "1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const config = createConfig(fetchFn);
    const result = await nexusTransition(config, "a1", "CONNECTED", 0);

    expect(result.ok).toBe(true);
    expect(capturedBody?.method).toBe("agent_transition");
    const params = capturedBody?.params as Record<string, unknown>;
    expect(params.target_state).toBe("CONNECTED");
    expect(params.expected_generation).toBe(0);
  });
});

describe("nexusListAgents", () => {
  test("calls list_agents without zone", async () => {
    // let: captured in mock
    let capturedBody: Record<string, unknown> | undefined;

    const fetchFn: FetchFn = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: [], id: "1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const config = createConfig(fetchFn);
    await nexusListAgents(config);

    expect(capturedBody?.method).toBe("list_agents");
  });

  test("calls agent_list_by_zone with zone", async () => {
    // let: captured in mock
    let capturedBody: Record<string, unknown> | undefined;

    const fetchFn: FetchFn = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: [], id: "1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const config = createConfig(fetchFn);
    await nexusListAgents(config, "zone-1");

    expect(capturedBody?.method).toBe("agent_list_by_zone");
    const params = capturedBody?.params as Record<string, unknown>;
    expect(params.zone_id).toBe("zone-1");
  });
});

describe("nexusGetAgent", () => {
  test("calls get_agent and returns agent", async () => {
    const agent = { agent_id: "a1", state: "CONNECTED", generation: 1, metadata: {} };
    const config = createConfig(mockJsonRpcSuccess(agent));
    const result = await nexusGetAgent(config, "a1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agent_id).toBe("a1");
    }
  });
});
