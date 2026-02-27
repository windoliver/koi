import { beforeEach, describe, expect, test } from "bun:test";
import type { HandoffEvent, JsonObject } from "@koi/core";
import { agentId } from "@koi/core";
import { createPrepareTool } from "./prepare-tool.js";
import { createHandoffStore, type HandoffStore } from "./store.js";

describe("prepare_handoff tool", () => {
  let store: HandoffStore;
  const events: HandoffEvent[] = [];

  beforeEach(() => {
    store = createHandoffStore();
    events.length = 0;
  });

  function makeTool(): ReturnType<typeof createPrepareTool> {
    return createPrepareTool({
      store,
      agentId: agentId("agent-a"),
      onEvent: (e) => {
        events.push(e);
      },
    });
  }

  test("creates envelope with valid input", async () => {
    const tool = makeTool();
    const result = await tool.execute({
      to: "agent-b",
      completed: "Analyzed the data",
      next: "Generate report from analysis",
    } as JsonObject);

    const output = result as { handoffId: string; status: string };
    expect(output.handoffId).toBeDefined();
    expect(output.status).toBe("pending");

    // Verify stored
    const stored = [...store.listByAgent(agentId("agent-a"))];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.from).toBe(agentId("agent-a"));
    expect(stored[0]?.to).toBe(agentId("agent-b"));
    expect(stored[0]?.status).toBe("pending");
    expect(stored[0]?.phase.completed).toBe("Analyzed the data");
    expect(stored[0]?.phase.next).toBe("Generate report from analysis");
  });

  test("emits handoff:prepared event", async () => {
    const tool = makeTool();
    await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
    } as JsonObject);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("handoff:prepared");
  });

  test("returns error when 'to' is missing", async () => {
    const tool = makeTool();
    const result = await tool.execute({
      completed: "Done",
      next: "Continue",
    } as JsonObject);

    expect(result).toEqual({ error: "'to' is required and must be a non-empty string" });
  });

  test("returns error when 'completed' is missing", async () => {
    const tool = makeTool();
    const result = await tool.execute({
      to: "agent-b",
      next: "Continue",
    } as JsonObject);

    expect(result).toEqual({ error: "'completed' is required and must be a non-empty string" });
  });

  test("returns error when 'next' is missing", async () => {
    const tool = makeTool();
    const result = await tool.execute({
      to: "agent-b",
      completed: "Done",
    } as JsonObject);

    expect(result).toEqual({ error: "'next' is required and must be a non-empty string" });
  });

  test("includes artifacts and warnings in envelope", async () => {
    const tool = makeTool();
    await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
      artifacts: [{ id: "a1", kind: "file", uri: "file:///workspace/out.json" }],
      warnings: ["Watch out for edge case X"],
    } as JsonObject);

    const stored = store.listByAgent(agentId("agent-a"));
    expect(stored[0]?.context.artifacts).toHaveLength(1);
    expect(stored[0]?.context.warnings).toContain("Watch out for edge case X");
  });

  test("adds artifact validation warnings", async () => {
    const tool = makeTool();
    await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
      artifacts: [{ id: "a1", kind: "data", uri: "s3://bucket/key" }],
    } as JsonObject);

    const stored = store.listByAgent(agentId("agent-a"));
    expect(stored[0]?.context.warnings.length).toBeGreaterThan(0);
    expect(stored[0]?.context.warnings[0]).toContain("unsupported URI scheme");
  });

  test("concurrent calls produce unique IDs", async () => {
    const tool = makeTool();
    const [r1, r2] = await Promise.all([
      tool.execute({ to: "b", completed: "D1", next: "N1" } as JsonObject),
      tool.execute({ to: "b", completed: "D2", next: "N2" } as JsonObject),
    ]);

    const id1 = (r1 as { handoffId: string }).handoffId;
    const id2 = (r2 as { handoffId: string }).handoffId;
    expect(id1).not.toBe(id2);
  });

  test("includes decisions in envelope", async () => {
    const tool = makeTool();
    await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
      decisions: [
        {
          agentId: "agent-a",
          action: "chose_strategy",
          reasoning: "BFS is better for this graph",
          timestamp: Date.now(),
        },
      ],
    } as JsonObject);

    const stored = store.listByAgent(agentId("agent-a"));
    expect(stored[0]?.context.decisions).toHaveLength(1);
    expect(stored[0]?.context.decisions[0]?.action).toBe("chose_strategy");
  });

  test("includes metadata in envelope", async () => {
    const tool = makeTool();
    await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
      metadata: { priority: "high" },
    } as JsonObject);

    const stored = store.listByAgent(agentId("agent-a"));
    expect(stored[0]?.metadata).toEqual({ priority: "high" });
  });
});
