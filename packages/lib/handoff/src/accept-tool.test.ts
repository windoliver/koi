import { describe, expect, test } from "bun:test";
import { agentId, type HandoffEnvelope, handoffId } from "@koi/core";
import { createAcceptTool } from "./accept-tool.js";
import { createInMemoryHandoffStore } from "./store.js";

function makeEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    id: handoffId(crypto.randomUUID()),
    from: agentId("agent-a"),
    to: agentId("agent-b"),
    status: "pending",
    createdAt: Date.now(),
    phase: { completed: "x", next: "y" },
    context: { results: { ok: true }, artifacts: [], decisions: [], warnings: ["careful"] },
    metadata: {},
    ...overrides,
  };
}

describe("createAcceptTool", () => {
  test("accepts a pending envelope and transitions to accepted", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    const tool = createAcceptTool({ store, agentId: agentId("agent-b") });
    const result = (await tool.execute({ handoff_id: env.id })) as {
      from?: string;
      warnings?: readonly string[];
    };
    expect(result.from).toBe("agent-a");
    expect(result.warnings).toContain("careful");

    const second = await store.get(env.id);
    if (second.ok) expect(second.value.status).toBe("accepted");
  });

  test("returns NOT_FOUND error metadata for missing id", async () => {
    const store = createInMemoryHandoffStore();
    const tool = createAcceptTool({ store, agentId: agentId("agent-b") });
    const result = (await tool.execute({ handoff_id: "missing" })) as {
      output: null;
      metadata: { error: { code: string } };
    };
    expect(result.output).toBeNull();
    expect(result.metadata.error.code).toBe("NOT_FOUND");
  });

  test("rejects target mismatch", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    const tool = createAcceptTool({ store, agentId: agentId("agent-c") });
    const result = (await tool.execute({ handoff_id: env.id })) as {
      metadata: { error: { code: string } };
    };
    expect(result.metadata.error.code).toBe("TARGET_MISMATCH");
  });

  test("rejects already-accepted envelope", async () => {
    const store = createInMemoryHandoffStore();
    const env = makeEnvelope();
    await store.put(env);
    await store.transition(env.id, "pending", "accepted");
    const tool = createAcceptTool({ store, agentId: agentId("agent-b") });
    const result = (await tool.execute({ handoff_id: env.id })) as {
      metadata: { error: { code: string } };
    };
    expect(result.metadata.error.code).toBe("ALREADY_ACCEPTED");
  });
});
