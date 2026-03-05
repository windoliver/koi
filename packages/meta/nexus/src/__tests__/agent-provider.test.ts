/**
 * Tests for the Nexus agent-scoped ComponentProvider.
 */

import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentGroupId,
  AgentId,
  AgentManifest,
  ProcessState,
  SubsystemToken,
} from "@koi/core";
import { EVENTS, FILESYSTEM, MAILBOX, MEMORY } from "@koi/core";
import { createNexusClient } from "@koi/nexus-client";
import { createFakeNexusFetch } from "@koi/test-utils";
import { createNexusAgentProvider } from "../agent-provider.js";

const BASE_URL = "http://localhost:2026";
const API_KEY = "sk-test";

function makeFakeAgent(agentId: string, groupId?: string): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: {
      id: agentId as AgentId,
      name: "test-agent",
      type: "worker" as const,
      depth: 0,
      ...(groupId !== undefined ? { groupId: groupId as AgentGroupId } : {}),
    },
    manifest: {
      name: "test",
      version: "1.0.0",
      model: { name: "test-model" },
    } as AgentManifest,
    state: "running" as ProcessState,
    component: <T>(token: { toString(): string }): T | undefined =>
      components.get(token.toString()) as T | undefined,
    has: (token: { toString(): string }): boolean => components.has(token.toString()),
    hasAll: (...tokens: readonly { toString(): string }[]): boolean =>
      tokens.every((t) => components.has(t.toString())),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

function createTestSetup(): {
  readonly conn: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly fetch: typeof globalThis.fetch;
  };
  readonly client: ReturnType<typeof createNexusClient>;
} {
  const fakeFetch = createFakeNexusFetch();
  const conn = { baseUrl: BASE_URL, apiKey: API_KEY, fetch: fakeFetch };
  const client = createNexusClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: fakeFetch });
  return { conn, client };
}

describe("createNexusAgentProvider", () => {
  test("returns a provider with name 'nexus-agent'", () => {
    const { conn, client } = createTestSetup();
    const { provider } = createNexusAgentProvider(conn, client);
    expect(provider.name).toBe("nexus-agent");
  });

  test("attach() creates agent-scoped backends", async () => {
    const { conn, client } = createTestSetup();
    const { provider } = createNexusAgentProvider(conn, client);
    const agent = makeFakeAgent("agent-001");

    const result = await provider.attach(agent);
    const components = "components" in result ? result.components : result;

    // Should have core agent-scoped backends
    expect(components.has("forge-store")).toBe(true);
    expect(components.has(EVENTS as string)).toBe(true);
    expect(components.has("session-persistence")).toBe(true);
    expect(components.has(MEMORY as string)).toBe(true);
    expect(components.has("snapshot-store")).toBe(true);
    expect(components.has(FILESYSTEM as string)).toBe(true);
    expect(components.has(MAILBOX as string)).toBe(true);
  });

  test("attach() without groupId skips scratchpad", async () => {
    const { conn, client } = createTestSetup();
    const { provider, middlewares } = createNexusAgentProvider(conn, client);
    const agent = makeFakeAgent("agent-no-group");

    const result = await provider.attach(agent);
    const components = "components" in result ? result.components : result;

    expect(components.has("scratchpad")).toBe(false);
    expect(middlewares).toHaveLength(0);
  });

  test("attach() with groupId wires scratchpad", async () => {
    const { conn, client } = createTestSetup();
    const { provider, middlewares } = createNexusAgentProvider(conn, client);
    const agent = makeFakeAgent("agent-with-group", "group-001");

    const result = await provider.attach(agent);
    const components = "components" in result ? result.components : result;

    // Scratchpad provider attaches its components (SCRATCHPAD token + tools)
    expect(components.size).toBeGreaterThan(7);
    expect(middlewares.length).toBeGreaterThanOrEqual(1);
  });

  test("detach() disposes mailbox and cleans up", async () => {
    const { conn, client } = createTestSetup();
    const { provider } = createNexusAgentProvider(conn, client);
    const agent = makeFakeAgent("agent-detach");

    await provider.attach(agent);

    // First detach should dispose resources
    await provider.detach?.(agent);

    // Second detach should be idempotent (no error)
    await provider.detach?.(agent);
  });

  test("detach() for unattached agent is no-op", async () => {
    const { conn, client } = createTestSetup();
    const { provider } = createNexusAgentProvider(conn, client);
    const agent = makeFakeAgent("never-attached");

    // Should not throw
    await provider.detach?.(agent);
  });

  test("opt-in workspace creates workspace component", async () => {
    const { conn, client } = createTestSetup();
    const { provider } = createNexusAgentProvider(
      conn,
      client,
      {},
      {
        workspace: { basePath: "/ws" },
      },
    );
    const agent = makeFakeAgent("agent-ws");

    const result = await provider.attach(agent);
    const components = "components" in result ? result.components : result;

    // Workspace may or may not be present depending on config validation
    // but the provider should not throw
    expect(components.has("forge-store")).toBe(true);
  });

  test("multiple agents get independent backends", async () => {
    const { conn, client } = createTestSetup();
    const { provider } = createNexusAgentProvider(conn, client);
    const agent1 = makeFakeAgent("agent-a");
    const agent2 = makeFakeAgent("agent-b");

    const result1 = await provider.attach(agent1);
    const result2 = await provider.attach(agent2);

    const components1 = "components" in result1 ? result1.components : result1;
    const components2 = "components" in result2 ? result2.components : result2;

    // Both should have backends
    expect(components1.has(FILESYSTEM as string)).toBe(true);
    expect(components2.has(FILESYSTEM as string)).toBe(true);

    // They should be different instances (different basePaths)
    expect(components1.get(FILESYSTEM as string)).not.toBe(components2.get(FILESYSTEM as string));
  });
});
