import { describe, expect, it } from "bun:test";
import { createNexusRetriever } from "./nexus-retriever.js";
import type { NexusSearchConfig } from "./nexus-search-config.js";
import type { NexusQueryResponse } from "./nexus-types.js";

function createMockFetch(response: {
  readonly status: number;
  readonly body: unknown;
}): typeof fetch {
  return (async () => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.body,
    text: async () => JSON.stringify(response.body),
  })) as unknown as typeof fetch;
}

const BASE_CONFIG: NexusSearchConfig = {
  baseUrl: "http://localhost:2026",
  apiKey: "sk-test",
};

describe("createNexusRetriever", () => {
  it("returns mapped results on success", async () => {
    const nexusResponse: NexusQueryResponse = {
      hits: [
        {
          path: "src/main.ts",
          chunk_text: "function main() {}",
          chunk_index: 0,
          score: 0.95,
          line_start: 1,
          line_end: 3,
        },
        {
          path: "src/utils.ts",
          chunk_text: "export const x = 1;",
          chunk_index: 2,
          score: 0.7,
        },
      ],
      total: 2,
      has_more: false,
    };

    const retriever = createNexusRetriever({
      ...BASE_CONFIG,
      fetchFn: createMockFetch({ status: 200, body: nexusResponse }),
    });

    const result = await retriever.retrieve({ text: "main", limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(2);
    expect(result.value.results[0]?.id).toBe("src/main.ts:0");
    expect(result.value.results[0]?.source).toBe("nexus");
    expect(result.value.results[0]?.score).toBe(0.95);
    expect(result.value.total).toBe(2);
    expect(result.value.hasMore).toBe(false);
  });

  it("passes query params correctly", async () => {
    let capturedUrl = "";
    const fetchFn = (async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ hits: [], total: 0, has_more: false }),
      };
    }) as unknown as typeof fetch;

    const retriever = createNexusRetriever({ ...BASE_CONFIG, fetchFn });

    await retriever.retrieve({
      text: "hello world",
      limit: 5,
      offset: 10,
      cursor: "abc",
      minScore: 0.5,
    });

    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get("q")).toBe("hello world");
    expect(parsed.searchParams.get("limit")).toBe("5");
    expect(parsed.searchParams.get("offset")).toBe("10");
    expect(parsed.searchParams.get("cursor")).toBe("abc");
    expect(parsed.searchParams.get("min_score")).toBe("0.5");
  });

  it("sends authorization header", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ hits: [], total: 0, has_more: false }),
      };
    }) as unknown as typeof fetch;

    const retriever = createNexusRetriever({ ...BASE_CONFIG, fetchFn });
    await retriever.retrieve({ text: "test", limit: 10 });

    expect(capturedInit?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer sk-test" }),
    );
  });

  it("returns error on non-OK response", async () => {
    const retriever = createNexusRetriever({
      ...BASE_CONFIG,
      fetchFn: createMockFetch({ status: 401, body: "unauthorized" }),
    });

    const result = await retriever.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PERMISSION");
  });

  it("returns EXTERNAL error on network failure", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const retriever = createNexusRetriever({ ...BASE_CONFIG, fetchFn });
    const result = await retriever.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("ECONNREFUSED");
  });
});
