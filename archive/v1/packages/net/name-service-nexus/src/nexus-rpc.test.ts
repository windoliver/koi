import { describe, expect, test } from "bun:test";
import type { AgentId, BrickId } from "@koi/core";
import { agentId, brickId } from "@koi/core";
import type { FetchFn, NexusNameServiceConfig } from "./config.js";
import type { NexusNameRecord } from "./nexus-rpc.js";
import {
  mapNexusBinding,
  nexusAnsDeregister,
  nexusAnsList,
  nexusAnsRegister,
  nexusAnsRenew,
  nexusAnsResolve,
} from "./nexus-rpc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetch(
  responseBody: unknown,
  status = 200,
  statusText = "OK",
): {
  readonly fetch: FetchFn;
  readonly calls: Array<{ readonly url: string; readonly body: unknown }>;
} {
  const calls: Array<{ readonly url: string; readonly body: unknown }> = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body !== undefined ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    return new Response(JSON.stringify(responseBody), {
      status,
      statusText,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: fetchFn, calls };
}

function makeConfig(fetch: FetchFn): NexusNameServiceConfig {
  return { baseUrl: "https://nexus.test", apiKey: "sk-test", fetch };
}

const SAMPLE_NEXUS_RECORD: NexusNameRecord = {
  name: "reviewer",
  binding_kind: "agent",
  agent_id: "agent-1",
  scope: "agent",
  aliases: [],
  registered_at: 1000,
  expires_at: 0,
  registered_by: "test",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("nexusAnsRegister", () => {
  test("sends correct RPC envelope for agent binding", async () => {
    const { fetch, calls } = createMockFetch({
      jsonrpc: "2.0",
      result: SAMPLE_NEXUS_RECORD,
      id: "1",
    });
    const config = makeConfig(fetch);

    const result = await nexusAnsRegister(config, {
      name: "reviewer",
      binding: { kind: "agent", agentId: "agent-1" as AgentId },
      scope: "agent",
      registered_by: "test",
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://nexus.test/api/ans/name.register");
    expect(calls[0]?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "name.register",
      params: {
        name: "reviewer",
        binding_kind: "agent",
        agent_id: "agent-1",
        scope: "agent",
      },
    });
  });

  test("sends brick binding params correctly", async () => {
    const { fetch, calls } = createMockFetch({
      jsonrpc: "2.0",
      result: SAMPLE_NEXUS_RECORD,
      id: "1",
    });
    const config = makeConfig(fetch);

    await nexusAnsRegister(config, {
      name: "my-tool",
      binding: { kind: "brick", brickId: "brick-1" as BrickId, brickKind: "tool" },
      scope: "global",
      aliases: ["mt"],
      registered_by: "test",
    });

    expect(calls[0]?.body).toMatchObject({
      params: {
        binding_kind: "brick",
        brick_id: "brick-1",
        brick_kind: "tool",
        aliases: ["mt"],
      },
    });
  });

  test("maps CONFLICT error from Nexus", async () => {
    const { fetch } = createMockFetch({
      jsonrpc: "2.0",
      error: { code: -32006, message: "Name already registered" },
      id: "1",
    });
    const config = makeConfig(fetch);

    const result = await nexusAnsRegister(config, {
      name: "reviewer",
      binding: { kind: "agent", agentId: "agent-1" as AgentId },
      scope: "agent",
      registered_by: "test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.retryable).toBe(true);
    }
  });
});

describe("nexusAnsResolve", () => {
  test("resolves a name successfully", async () => {
    const { fetch } = createMockFetch({ jsonrpc: "2.0", result: SAMPLE_NEXUS_RECORD, id: "1" });
    const config = makeConfig(fetch);

    const result = await nexusAnsResolve(config, "reviewer");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("reviewer");
    }
  });

  test("passes scope when provided", async () => {
    const { fetch, calls } = createMockFetch({
      jsonrpc: "2.0",
      result: SAMPLE_NEXUS_RECORD,
      id: "1",
    });
    const config = makeConfig(fetch);

    await nexusAnsResolve(config, "reviewer", "agent");
    expect(calls[0]?.body).toMatchObject({
      params: { name: "reviewer", scope: "agent" },
    });
  });

  test("maps NOT_FOUND error", async () => {
    const { fetch } = createMockFetch({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Name not found" },
      id: "1",
    });
    const config = makeConfig(fetch);

    const result = await nexusAnsResolve(config, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.retryable).toBe(false);
    }
  });
});

describe("nexusAnsRenew", () => {
  test("renews a name successfully", async () => {
    const { fetch } = createMockFetch({ jsonrpc: "2.0", result: SAMPLE_NEXUS_RECORD, id: "1" });
    const config = makeConfig(fetch);

    const result = await nexusAnsRenew(config, "reviewer", "agent", 60_000);
    expect(result.ok).toBe(true);
  });

  test("sends ttl_ms when provided", async () => {
    const { fetch, calls } = createMockFetch({
      jsonrpc: "2.0",
      result: SAMPLE_NEXUS_RECORD,
      id: "1",
    });
    const config = makeConfig(fetch);

    await nexusAnsRenew(config, "reviewer", "agent", 60_000);
    expect(calls[0]?.body).toMatchObject({
      params: { name: "reviewer", scope: "agent", ttl_ms: 60_000 },
    });
  });
});

describe("nexusAnsDeregister", () => {
  test("deregisters a name successfully", async () => {
    const { fetch } = createMockFetch({ jsonrpc: "2.0", result: {}, id: "1" });
    const config = makeConfig(fetch);

    const result = await nexusAnsDeregister(config, "reviewer", "agent");
    expect(result.ok).toBe(true);
  });

  test("maps PERMISSION error", async () => {
    const { fetch } = createMockFetch({
      jsonrpc: "2.0",
      error: { code: -32003, message: "Access denied" },
      id: "1",
    });
    const config = makeConfig(fetch);

    const result = await nexusAnsDeregister(config, "reviewer", "agent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.retryable).toBe(false);
    }
  });
});

describe("nexusAnsList", () => {
  test("lists records successfully", async () => {
    const { fetch } = createMockFetch({
      jsonrpc: "2.0",
      result: [SAMPLE_NEXUS_RECORD],
      id: "1",
    });
    const config = makeConfig(fetch);

    const result = await nexusAnsList(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
    }
  });

  test("passes zone_id when provided", async () => {
    const { fetch, calls } = createMockFetch({ jsonrpc: "2.0", result: [], id: "1" });
    const config = makeConfig(fetch);

    await nexusAnsList(config, "zone-1");
    expect(calls[0]?.body).toMatchObject({
      params: { zone_id: "zone-1" },
    });
  });
});

describe("HTTP error handling", () => {
  test("500 response returns retryable EXTERNAL error", async () => {
    const { fetch } = createMockFetch({}, 500, "Internal Server Error");
    const config = makeConfig(fetch);

    const result = await nexusAnsResolve(config, "reviewer");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("500");
    }
  });

  test("403 response returns non-retryable EXTERNAL error", async () => {
    const { fetch } = createMockFetch({}, 403, "Forbidden");
    const config = makeConfig(fetch);

    const result = await nexusAnsResolve(config, "reviewer");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(false);
    }
  });
});

describe("timeout handling", () => {
  test("returns TIMEOUT error when request exceeds timeout", async () => {
    const fetchFn: FetchFn = async (_input, init) => {
      // Simulate abort
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    };
    const config: NexusNameServiceConfig = {
      baseUrl: "https://nexus.test",
      apiKey: "sk-test",
      fetch: fetchFn,
      timeoutMs: 1,
    };

    const result = await nexusAnsResolve(config, "reviewer");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
    }
  });
});

describe("network error handling", () => {
  test("returns EXTERNAL error on fetch throw", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("Network unreachable");
    };
    const config = makeConfig(fetchFn);

    const result = await nexusAnsResolve(config, "reviewer");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("Network unreachable");
    }
  });
});

describe("mapNexusBinding", () => {
  test("maps agent binding", () => {
    const binding = mapNexusBinding(SAMPLE_NEXUS_RECORD);
    expect(binding).toEqual({ kind: "agent", agentId: agentId("agent-1") });
  });

  test("maps brick binding", () => {
    const binding = mapNexusBinding({
      ...SAMPLE_NEXUS_RECORD,
      binding_kind: "brick",
      brick_id: "brick-1",
      brick_kind: "tool",
    });
    expect(binding).toEqual({ kind: "brick", brickId: brickId("brick-1"), brickKind: "tool" });
  });

  test("returns undefined for agent binding without agent_id", () => {
    const binding = mapNexusBinding({
      ...SAMPLE_NEXUS_RECORD,
      agent_id: undefined,
    });
    expect(binding).toBeUndefined();
  });

  test("returns undefined for brick binding without brick_kind", () => {
    const binding = mapNexusBinding({
      ...SAMPLE_NEXUS_RECORD,
      binding_kind: "brick",
      brick_id: "brick-1",
      brick_kind: undefined,
    });
    expect(binding).toBeUndefined();
  });
});
