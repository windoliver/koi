import { describe, expect, test } from "bun:test";
import { agentId, type HandoffEnvelope, handoffId } from "@koi/core";
import { createInMemoryHandoffStore } from "./store.js";

function makeEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    id: handoffId(crypto.randomUUID()),
    from: agentId("agent-a"),
    to: agentId("agent-b"),
    status: "pending",
    createdAt: Date.now(),
    phase: { completed: "did x", next: "do y" },
    context: { results: {}, artifacts: [], decisions: [], warnings: [] },
    metadata: {},
    ...overrides,
  };
}

describe("createInMemoryHandoffStore", () => {
  test("put + get round-trip", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    expect((await store.put(env)).ok).toBe(true);
    const got = await store.get(env.id);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.id).toBe(env.id);
  });

  test("put rejects duplicate id with CONFLICT", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    const result = await store.put(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
  });

  test("get returns NOT_FOUND for missing id", async () => {
    const store = createInMemoryHandoffStore();
    const result = await store.get(handoffId("nope"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("transition CAS only succeeds when from matches", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    const ok = await store.transition(env.id, "pending", "injected");
    expect(ok.ok).toBe(true);
    const wrong = await store.transition(env.id, "pending", "accepted");
    expect(wrong.ok).toBe(false);
  });

  test("findPendingForAgent picks oldest pending/injected for receiver", async () => {
    const store = createInMemoryHandoffStore();
    const older = makeEnvelope({ createdAt: 1000 });
    const newer = makeEnvelope({ createdAt: 2000 });
    await store.put(older);
    await store.put(newer);
    const result = await store.findPendingForAgent(agentId("agent-b"));
    expect(result.ok).toBe(true);
    if (result.ok && result.value !== undefined) {
      expect(result.value.id).toBe(older.id);
    }
  });

  test("findPendingForAgent ignores accepted envelopes", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    await store.transition(env.id, "pending", "accepted");
    const result = await store.findPendingForAgent(agentId("agent-b"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });

  test("expired envelopes are surfaced as NOT_FOUND on get", async () => {
    const store = createInMemoryHandoffStore({ ttlMs: 1 });
    const env = makeEnvelope({ createdAt: Date.now() - 1000 });
    await store.put(env);
    const result = await store.get(env.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("listByAgent returns envelopes from or to the agent", async () => {
    const store = createInMemoryHandoffStore();
    const e1 = makeEnvelope({ from: agentId("agent-a"), to: agentId("agent-b") });
    const e2 = makeEnvelope({ from: agentId("agent-c"), to: agentId("agent-a") });
    const e3 = makeEnvelope({ from: agentId("agent-c"), to: agentId("agent-d") });
    await store.put(e1);
    await store.put(e2);
    await store.put(e3);
    const r = await store.listByAgent(agentId("agent-a"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });

  test("remove returns true when present, false when absent", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    const r1 = await store.remove(env.id);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toBe(true);
    const r2 = await store.remove(env.id);
    if (r2.ok) expect(r2.value).toBe(false);
  });

  test("removeByAgent clears every envelope referencing the agent", async () => {
    const store = createInMemoryHandoffStore();
    const e1 = makeEnvelope({ from: agentId("agent-a") });
    const e2 = makeEnvelope({ to: agentId("agent-a") });
    await store.put(e1);
    await store.put(e2);
    await store.removeByAgent(agentId("agent-a"));
    const r = await store.listByAgent(agentId("agent-a"));
    if (r.ok) expect(r.value.length).toBe(0);
  });
});
