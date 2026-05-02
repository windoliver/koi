import { describe, expect, test } from "bun:test";
import { type AgentRegistry, agentId, type RegistryEntry } from "@koi/core";
import { createPrepareTool } from "./prepare-tool.js";
import { createInMemoryHandoffStore } from "./store.js";

function fakeRegistry(entries: readonly RegistryEntry[]): AgentRegistry {
  return {
    register: () => entries[0] ?? (undefined as never),
    deregister: () => true,
    lookup: () => undefined,
    list: () => entries,
    transition: () => ({ ok: true, value: entries[0] ?? (undefined as never) }),
    patch: () => ({ ok: true, value: entries[0] ?? (undefined as never) }),
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}

describe("createPrepareTool", () => {
  test("validation error on missing completed", async () => {
    const store = createInMemoryHandoffStore();
    const tool = createPrepareTool({ store, agentId: agentId("agent-a") });
    const result = (await tool.execute({ to: "agent-b", next: "do y" })) as { error?: string };
    expect(result.error).toBeDefined();
  });

  test("happy path stores envelope and emits prepared event", async () => {
    const store = createInMemoryHandoffStore();
    const events: string[] = [];
    const tool = createPrepareTool({
      store,
      agentId: agentId("agent-a"),
      onEvent: (e) => events.push(e.kind),
    });
    const result = (await tool.execute({
      to: "agent-b",
      completed: "phase 1",
      next: "phase 2",
    })) as { handoffId?: string; status?: string };
    expect(result.status).toBe("pending");
    expect(typeof result.handoffId).toBe("string");
    expect(events).toContain("handoff:prepared");
  });

  test("capability-based handoff resolves via registry", async () => {
    const store = createInMemoryHandoffStore();
    const entry = {
      agentId: agentId("deployer"),
      agentType: "worker" as const,
      version: 1,
      generation: 0,
      registeredAt: 0,
      lastTransitionAt: 0,
      manifest: { name: "deployer", version: "1.0.0", model: { name: "x" } },
      status: { phase: "running" as const, conditions: [] },
      metadata: { capabilities: ["deployment"] },
    } as unknown as RegistryEntry;
    const registry = fakeRegistry([entry]);
    const tool = createPrepareTool({
      store,
      agentId: agentId("builder"),
      registry,
    });
    const result = (await tool.execute({
      capability: "deployment",
      completed: "built",
      next: "deploy it",
    })) as { handoffId?: string; resolvedTo?: string };
    expect(result.resolvedTo).toBe("deployer");
  });

  test("capability without registry returns error", async () => {
    const store = createInMemoryHandoffStore();
    const tool = createPrepareTool({ store, agentId: agentId("agent-a") });
    const result = (await tool.execute({
      capability: "deploy",
      completed: "x",
      next: "y",
    })) as { error?: string };
    expect(result.error).toContain("no registry");
  });
});
