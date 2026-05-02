import { describe, expect, test } from "bun:test";
import { type AgentResolver, agentId, type TaskableAgent } from "@koi/core";
import { createTaskTool } from "./task-tool.js";
import type { SpawnFn, TaskSpawnRequest } from "./types.js";

const dummyAgent: TaskableAgent = {
  name: "researcher",
  description: "Research",
  manifest: { name: "researcher", version: "1.0.0", model: { name: "m" } },
};

const agents = new Map<string, TaskableAgent>([["researcher", dummyAgent]]);

describe("createTaskTool", () => {
  test("rejects empty description", async () => {
    const tool = await createTaskTool({
      agents,
      spawn: async () => ({ ok: true, output: "ignored" }),
    });
    const result = (await tool.execute({})) as string;
    expect(result).toContain("'description' is required");
  });

  test("requires agent_type when no default", async () => {
    const tool = await createTaskTool({
      agents,
      spawn: async () => ({ ok: true, output: "x" }),
    });
    const result = (await tool.execute({ description: "do x" })) as string;
    expect(result).toContain("'agent_type' is required");
  });

  test("uses defaultAgent when agent_type omitted", async () => {
    const seen: TaskSpawnRequest[] = [];
    const spawn: SpawnFn = async (req) => {
      seen.push(req);
      return { ok: true, output: "spawned" };
    };
    const tool = await createTaskTool({ agents, spawn, defaultAgent: "researcher" });
    const out = (await tool.execute({ description: "do x" })) as string;
    expect(out).toBe("spawned");
    expect(seen[0]?.agentName).toBe("researcher");
  });

  test("returns error for unknown agent_type", async () => {
    const tool = await createTaskTool({
      agents,
      spawn: async () => ({ ok: true, output: "" }),
    });
    const out = (await tool.execute({ description: "x", agent_type: "missing" })) as string;
    expect(out).toContain("unknown agent type");
  });

  test("formats failed spawn output", async () => {
    const tool = await createTaskTool({
      agents,
      spawn: async () => ({ ok: false, error: "boom" }),
      defaultAgent: "researcher",
    });
    const out = (await tool.execute({ description: "x" })) as string;
    expect(out).toBe("Task failed: boom");
  });

  test("messages live idle copilot when available", async () => {
    let messaged = false;
    const resolver: AgentResolver = {
      resolve: () => ({ ok: true, value: dummyAgent }),
      list: () => [{ key: "researcher", name: "Researcher", description: "x" }],
      findLive: () => ({ agentId: agentId("live-1"), state: "idle" }),
    };
    const tool = await createTaskTool({
      agentResolver: resolver,
      spawn: async () => ({ ok: true, output: "should not happen" }),
      message: async () => {
        messaged = true;
        return { ok: true, output: "messaged" };
      },
      defaultAgent: "researcher",
    });
    const out = (await tool.execute({ description: "x" })) as string;
    expect(messaged).toBe(true);
    expect(out).toBe("messaged");
  });

  test("falls through to spawn when copilot is busy", async () => {
    let spawned = false;
    const resolver: AgentResolver = {
      resolve: () => ({ ok: true, value: dummyAgent }),
      list: () => [{ key: "researcher", name: "Researcher", description: "x" }],
      findLive: () => ({ agentId: agentId("busy-1"), state: "busy" }),
    };
    const tool = await createTaskTool({
      agentResolver: resolver,
      spawn: async () => {
        spawned = true;
        return { ok: true, output: "spawned" };
      },
      message: async () => ({ ok: true, output: "should not happen" }),
      defaultAgent: "researcher",
    });
    const out = (await tool.execute({ description: "x" })) as string;
    expect(spawned).toBe(true);
    expect(out).toBe("spawned");
  });

  test("descriptor reflects available agents", async () => {
    const tool = await createTaskTool({
      agents,
      spawn: async () => ({ ok: true, output: "" }),
    });
    const props = (
      tool.descriptor.inputSchema as { properties: Record<string, { enum?: string[] }> }
    ).properties;
    expect(props.agent_type?.enum).toContain("researcher");
  });
});
