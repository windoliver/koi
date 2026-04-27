import { describe, expect, mock, test } from "bun:test";
import type { Agent, AgentId, AttachResult, SubsystemToken } from "@koi/core";
import { agentId, DELEGATION, isAttachResult } from "@koi/core";
import type { NexusDelegationApi } from "./delegation-api.js";
import { createNexusDelegationProvider } from "./nexus-delegation-provider.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockApi(): NexusDelegationApi {
  return {
    createDelegation: mock(async () => ({
      ok: true as const,
      value: {
        delegation_id: "d-1",
        api_key: "key-1",
        created_at: "2026-01-01T00:00:00Z",
        expires_at: "2026-01-01T01:00:00Z",
      },
    })),
    revokeDelegation: mock(async () => ({ ok: true as const, value: undefined })),
    verifyChain: mock(async () => ({
      ok: true as const,
      value: { delegation_id: "d-1", valid: true, chain_depth: 0 },
    })),
    listDelegations: mock(async () => ({
      ok: true as const,
      value: { delegations: [], total: 0 },
    })),
  };
}

function mockAgent(id: AgentId): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: { id, name: "test", type: "copilot", depth: 0 },
    manifest: { name: "test", version: "0.1.0", model: { name: "m" } },
    state: "created",
    component: <T>(token: SubsystemToken<T>): T | undefined =>
      components.get(token as string) as T | undefined,
    has: (token) => components.has(token as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: <T>(prefix: string) => {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of components) {
        if (key.startsWith(prefix)) {
          result.set(key as SubsystemToken<T>, value as T);
        }
      }
      return result;
    },
    components: () => components,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusDelegationProvider", () => {
  test("attaches DELEGATION component using agent pid.id", async () => {
    const api = makeMockApi();
    const provider = createNexusDelegationProvider({ api });
    const agent = mockAgent(agentId("agent-42"));
    const components = extractMap(await provider.attach(agent));
    expect(components.has(DELEGATION as string)).toBe(true);
    const del = components.get(DELEGATION as string);
    expect(typeof (del as { grant?: unknown })?.grant).toBe("function");
    expect(typeof (del as { revoke?: unknown })?.revoke).toBe("function");
    expect(typeof (del as { verify?: unknown })?.verify).toBe("function");
    expect(typeof (del as { list?: unknown })?.list).toBe("function");
  });

  test("returns empty map when enabled=false", async () => {
    const api = makeMockApi();
    const provider = createNexusDelegationProvider({ api, enabled: false });
    const agent = mockAgent(agentId("agent-1"));
    const components = extractMap(await provider.attach(agent));
    expect(components.size).toBe(0);
  });

  test("provider name is 'delegation-nexus'", () => {
    const provider = createNexusDelegationProvider({ api: makeMockApi() });
    expect(provider.name).toBe("delegation-nexus");
  });

  test("forwards backend config overrides (e.g. maxChainDepth)", async () => {
    const api = makeMockApi();
    const provider = createNexusDelegationProvider({
      api,
      backend: { maxChainDepth: 5, defaultTtlSeconds: 600 },
    });
    const agent = mockAgent(agentId("agent-7"));
    const components = extractMap(await provider.attach(agent));
    const del = components.get(DELEGATION as string) as
      | { readonly grant: (scope: unknown, delegateeId: AgentId) => Promise<unknown> }
      | undefined;
    expect(del).toBeDefined();
    // Trigger grant() and verify that the backend used the parent_agent_id from agent.pid.id.
    await del?.grant({ permissions: { allow: ["*"] } }, agentId("child-1"));
    const createCall = (api.createDelegation as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    expect(createCall).toBeDefined();
    const req = createCall?.[0] as
      | {
          readonly parent_agent_id: string;
          readonly max_depth: number;
          readonly ttl_seconds: number;
        }
      | undefined;
    expect(req?.parent_agent_id).toBe("agent-7");
    expect(req?.max_depth).toBe(5);
    expect(req?.ttl_seconds).toBe(600);
  });
});
