import { describe, expect, test } from "bun:test";
import { agentId, type HandoffEnvelope, handoffId } from "@koi/core";
import { createNexusHandoffStore } from "./nexus-store.js";

/** Minimal in-memory FS facade over the nexus JSON-RPC contract. */
type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function createFakeNexus(): {
  readonly fetch: FakeFetch;
  readonly files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const fetch: FakeFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body !== undefined ? JSON.parse(init.body as string) : {};
    const method = body.method as string;
    const params = (body.params ?? {}) as Record<string, unknown>;
    const id = body.id ?? 1;

    function reply(result: unknown): Response {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!url.includes("/api/nfs/")) {
      return new Response("not found", { status: 404 });
    }

    switch (method) {
      case "exists":
        return reply(files.has(params.path as string));
      case "read": {
        const path = params.path as string;
        if (!files.has(path)) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id, error: { code: 404, message: "not found" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return reply(files.get(path));
      }
      case "write":
        files.set(params.path as string, params.content as string);
        return reply(undefined);
      case "delete":
        files.delete(params.path as string);
        return reply(undefined);
      case "glob": {
        const pattern = params.pattern as string;
        const prefix = pattern.replace("/*.json", "/");
        const matches = [...files.keys()].filter(
          (k) => k.startsWith(prefix) && k.endsWith(".json"),
        );
        return reply(matches);
      }
      default:
        return reply(null);
    }
  };
  return { fetch, files };
}

function makeEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    id: handoffId(crypto.randomUUID()),
    from: agentId("agent-a"),
    to: agentId("agent-b"),
    status: "pending",
    createdAt: Date.now(),
    phase: { completed: "x", next: "y" },
    context: { results: {}, artifacts: [], decisions: [], warnings: [] },
    metadata: {},
    ...overrides,
  };
}

describe("createNexusHandoffStore", () => {
  test("put + get round-trip", async () => {
    const fake = createFakeNexus();
    const store = createNexusHandoffStore({
      baseUrl: "http://nx",
      apiKey: "k",
      fetch: fake.fetch,
    });
    const env = makeEnvelope();
    expect((await store.put(env)).ok).toBe(true);
    const got = await store.get(env.id);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.id).toBe(env.id);
  });

  test("put rejects duplicate with CONFLICT", async () => {
    const fake = createFakeNexus();
    const store = createNexusHandoffStore({
      baseUrl: "http://nx",
      apiKey: "k",
      fetch: fake.fetch,
    });
    const env = makeEnvelope();
    await store.put(env);
    const result = await store.put(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
  });

  test("transition CAS read-compare-write", async () => {
    const fake = createFakeNexus();
    const store = createNexusHandoffStore({
      baseUrl: "http://nx",
      apiKey: "k",
      fetch: fake.fetch,
    });
    const env = makeEnvelope();
    await store.put(env);
    const ok = await store.transition(env.id, "pending", "injected");
    expect(ok.ok).toBe(true);
    const wrong = await store.transition(env.id, "pending", "accepted");
    expect(wrong.ok).toBe(false);
  });

  test("findPendingForAgent picks oldest", async () => {
    const fake = createFakeNexus();
    const store = createNexusHandoffStore({
      baseUrl: "http://nx",
      apiKey: "k",
      fetch: fake.fetch,
    });
    const older = makeEnvelope({ createdAt: 1000 });
    const newer = makeEnvelope({ createdAt: 2000 });
    await store.put(older);
    await store.put(newer);
    const result = await store.findPendingForAgent(agentId("agent-b"));
    expect(result.ok).toBe(true);
    if (result.ok && result.value !== undefined) expect(result.value.id).toBe(older.id);
  });

  test("removeByAgent deletes referenced envelopes", async () => {
    const fake = createFakeNexus();
    const store = createNexusHandoffStore({
      baseUrl: "http://nx",
      apiKey: "k",
      fetch: fake.fetch,
    });
    const a = makeEnvelope({ from: agentId("agent-a") });
    const b = makeEnvelope({ from: agentId("agent-z"), to: agentId("agent-other") });
    await store.put(a);
    await store.put(b);
    await store.removeByAgent(agentId("agent-a"));
    const list = await store.listByAgent(agentId("agent-a"));
    if (list.ok) expect(list.value.length).toBe(0);
    const list2 = await store.listByAgent(agentId("agent-other"));
    if (list2.ok) expect(list2.value.length).toBe(1);
  });
});
