import { describe, expect, test } from "bun:test";
import { createNexusRecordStoreDecisionGraphStore } from "./nexus-record-store.js";

describe("createNexusRecordStoreDecisionGraphStore", () => {
  test("neighbors calls Nexus graph API with auth header", async () => {
    const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(url), init });
      return Response.json({
        entities: [{ id: "n1", labels: ["session"], properties: { sessionId: "session-a" } }],
        relationships: [],
      });
    };
    const store = createNexusRecordStoreDecisionGraphStore({
      fetch: fetchImpl,
      url: "http://nexus.local",
      apiKey: "secret",
    });

    const result = await store.getNeighbors({
      sessionId: "session-a",
      nodeId: "n1",
      direction: "both",
      hops: 2,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe(
      "http://nexus.local/api/v2/graph/entity/n1/neighbors?hops=2&direction=both",
    );
    expect(calls[0]?.init?.headers).toEqual({ authorization: "Bearer secret" });
  });

  test("upsert fails closed when Nexus write endpoint is unavailable", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response("missing", { status: 404, statusText: "Not Found" });
    const store = createNexusRecordStoreDecisionGraphStore({
      fetch: fetchImpl,
      url: "http://nexus.local",
    });

    const result = await store.upsertGraph({ sessionId: "s", nodes: [], edges: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("write endpoint unavailable");
  });
});
