import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core";
import type { DashboardDataSource } from "@koi/dashboard-types";
import { handleChannels } from "./channels.js";

function createMockDataSource(): DashboardDataSource {
  return {
    listAgents: () => [],
    getAgent: () => undefined,
    terminateAgent: () => ({ ok: true, value: undefined }),
    listChannels: () => [
      {
        channelId: "ch-1",
        channelType: "cli",
        agentId: "agent-1" as AgentId,
        connected: true,
        messageCount: 42,
        connectedAt: Date.now(),
      },
    ],
    listSkills: () => [],
    getSystemMetrics: () => ({
      uptimeMs: 1000,
      heapUsedMb: 100,
      heapTotalMb: 512,
      activeAgents: 0,
      totalAgents: 0,
      activeChannels: 1,
    }),
    subscribe: () => () => {},
  };
}

describe("handleChannels", () => {
  test("returns list of channels", async () => {
    const ds = createMockDataSource();
    const response = await handleChannels(new Request("http://localhost/channels"), {}, ds);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: readonly [Record<string, unknown>];
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].channelId).toBe("ch-1");
    expect(body.data[0].connected).toBe(true);
  });
});
