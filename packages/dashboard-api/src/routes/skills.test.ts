import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core";
import type { DashboardDataSource } from "@koi/dashboard-types";
import { handleSkills } from "./skills.js";

function createMockDataSource(): DashboardDataSource {
  return {
    listAgents: () => [],
    getAgent: () => undefined,
    terminateAgent: () => ({ ok: true, value: undefined }),
    listChannels: () => [],
    listSkills: () => [
      {
        name: "code-review",
        description: "Reviews code for quality",
        tags: ["dev"],
        agentId: "agent-1" as AgentId,
      },
    ],
    getSystemMetrics: () => ({
      uptimeMs: 1000,
      heapUsedMb: 100,
      heapTotalMb: 512,
      activeAgents: 0,
      totalAgents: 0,
      activeChannels: 0,
    }),
    subscribe: () => () => {},
  };
}

describe("handleSkills", () => {
  test("returns list of skills", async () => {
    const ds = createMockDataSource();
    const response = await handleSkills(new Request("http://localhost/skills"), {}, ds);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: readonly [Record<string, unknown>];
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("code-review");
  });
});
