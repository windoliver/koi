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
      return jsonResponse({ ok: true, value: [] });
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
    const url = calls[0] ?? "";
    // Server only honors first `name`, `since`, and `limit`. Multi-name + `to`
    // + `tag` filtering must happen client-side; sending them would mislead
    // operators into thinking the filter was enforced.
    expect(url.startsWith("http://h:1/api/metrics?")).toBe(true);
    expect(url).toContain("name=cpu");
    expect(url).toContain("since=1000");
    expect(url).toContain("limit=50");
    expect(url).not.toContain("name=rss");
    expect(url).not.toContain("from=");
    expect(url).not.toContain("to=");
    expect(url).not.toContain("tag=");
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
