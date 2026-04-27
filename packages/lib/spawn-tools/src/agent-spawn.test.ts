import { describe, expect, test } from "bun:test";
import type { AgentId, ManagedTaskBoard, SpawnFn, SpawnRequest } from "@koi/core";
import { createAgentSpawnTool } from "./tools/agent-spawn.js";

describe("agent_spawn", () => {
  test("forwards structured context to spawnFn", async () => {
    const requests: SpawnRequest[] = [];
    const spawnFn: SpawnFn = async (request) => {
      requests.push(request);
      return { ok: true, output: "child output" };
    };

    const tool = createAgentSpawnTool({
      spawnFn,
      board: {} as ManagedTaskBoard,
      agentId: "parent-agent" as AgentId,
      signal: AbortSignal.timeout(5_000),
    });

    const result = await tool.execute({
      agent_name: "researcher",
      description: "Investigate the failure",
      context: {
        taskId: "TASK-123",
        files: ["src/index.ts"],
      },
    });

    expect(result).toEqual({ ok: true, output: "child output" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.description).toContain("Investigate the failure");
    expect(requests[0]?.description).toContain("Structured context:");
    expect(requests[0]?.description).toContain('"taskId": "TASK-123"');
    expect(requests[0]?.context).toEqual({
      taskId: "TASK-123",
      files: ["src/index.ts"],
    });
  });
});
