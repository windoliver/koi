import { describe, expect, test } from "bun:test";
import type { DashboardDataSource, DashboardSystemMetrics } from "@koi/dashboard-types";
import { handleMetrics } from "./metrics.js";

function createMockDataSource(): DashboardDataSource {
  const metrics: DashboardSystemMetrics = {
    uptimeMs: 60_000,
    heapUsedMb: 150,
    heapTotalMb: 512,
    activeAgents: 3,
    totalAgents: 5,
    activeChannels: 2,
  };

  return {
    listAgents: () => [],
    getAgent: () => undefined,
    terminateAgent: () => ({ ok: true, value: undefined }),
    listChannels: () => [],
    listSkills: () => [],
    getSystemMetrics: () => metrics,
    subscribe: () => () => {},
  };
}

describe("handleMetrics", () => {
  test("returns system metrics", async () => {
    const ds = createMockDataSource();
    const response = await handleMetrics(new Request("http://localhost/metrics"), {}, ds);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.activeAgents).toBe(3);
    expect(body.data.heapUsedMb).toBe(150);
    expect(body.data.uptimeMs).toBe(60_000);
  });
});
