import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core";
import { createDashboardClient } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createDashboardClient", () => {
  test("listAgents calls /api/agents and returns the value", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      return jsonResponse({ ok: true, value: { items: [] } });
    };
    const client = createDashboardClient({ baseUrl: "http://h:1", fetch: fetchImpl });
    const result = await client.listAgents();
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["http://h:1/api/agents"]);
  });

  test("strips trailing slash from baseUrl", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      return jsonResponse({ ok: true, value: undefined });
    };
    const client = createDashboardClient({ baseUrl: "http://h:1/", fetch: fetchImpl });
    await client.getAgent("agent-1" as AgentId);
    expect(calls[0]).toBe("http://h:1/api/agents/agent-1");
  });

  test("getMetrics encodes only the filters the dashboard-api parser honors", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      return jsonResponse({ ok: true, value: [] });
    };
    const client = createDashboardClient({ baseUrl: "http://h:1", fetch: fetchImpl });
    await client.getMetrics({
      names: ["cpu", "rss"],
      fromMs: 1000,
      toMs: 2000,
      tags: { agent: "a1" },
      limit: 50,
    });
    // Multi-name queries fan out one request per name. Each request encodes only
    // the filters the server actually parses (single `name`, `since`, `limit`);
    // `to`/`tag` filtering is enforced client-side before returning to caller.
    expect(calls.length).toBe(2);
    for (const u of calls) {
      expect(u.startsWith("http://h:1/api/metrics?")).toBe(true);
      expect(u).toContain("since=1000");
      expect(u).toContain("limit=50");
      expect(u).not.toContain("from=");
      expect(u).not.toContain("to=");
      expect(u).not.toContain("tag=");
    }
    const all = calls.join("|");
    expect(all).toContain("name=cpu");
    expect(all).toContain("name=rss");
  });

  test("getMetrics enforces a global limit across the fan-out, newest-first", async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      const u = new URL(url);
      const name = u.searchParams.get("name");
      const points =
        name === "cpu"
          ? [
              { name: "cpu", value: 1, timestampMs: 100 },
              { name: "cpu", value: 2, timestampMs: 200 },
            ]
          : [
              { name: "mem", value: 10, timestampMs: 150 },
              { name: "mem", value: 20, timestampMs: 250 },
            ];
      return jsonResponse({ ok: true, value: points });
    };
    const client = createDashboardClient({ baseUrl: "http://h:1", fetch: fetchImpl });
    const result = await client.getMetrics({
      names: ["cpu", "mem"],
      fromMs: 0,
      toMs: 1000,
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      // Newest-first across the merged set: 250 (mem), 200 (cpu).
      expect(result.value[0]?.timestampMs).toBe(250);
      expect(result.value[1]?.timestampMs).toBe(200);
    }
  });

  test("getMetrics filters server response by toMs and tag predicates client-side", async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse({
        ok: true,
        value: [
          { name: "cpu", value: 1, timestampMs: 50, tags: { env: "prod" } },
          { name: "cpu", value: 2, timestampMs: 150, tags: { env: "prod" } },
          { name: "cpu", value: 3, timestampMs: 250, tags: { env: "prod" } },
          { name: "cpu", value: 4, timestampMs: 150, tags: { env: "dev" } },
        ],
      });
    const client = createDashboardClient({ baseUrl: "http://h:1", fetch: fetchImpl });
    const result = await client.getMetrics({
      names: ["cpu"],
      fromMs: 100,
      toMs: 200,
      tags: { env: "prod" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.value).toBe(2);
    }
  });

  test("listAgents rejects ok:true with a malformed payload (per-endpoint validation)", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: true, value: [{ wrongShape: 1 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const client = createDashboardClient({ baseUrl: "http://h:1", fetch: fetchImpl });
    const result = await client.listAgents();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("getTrace url-encodes the turn id", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      return jsonResponse({ ok: true, value: undefined });
    };
    const client = createDashboardClient({ baseUrl: "http://h:1", fetch: fetchImpl });
    await client.getTrace("turn/with slash");
    expect(calls[0]).toBe("http://h:1/api/traces/turn%2Fwith%20slash");
  });

  test("subscribe targets /api/events and encodes topics in the query string", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const client = createDashboardClient({ baseUrl: "http://h:1/", fetch: fetchImpl });
    const dispose = client.subscribe(["metric", "trace"], { onEvent: () => undefined });
    expect(calls[0]).toBe("http://h:1/api/events?topics=metric%2Ctrace");
    dispose();
  });
});
