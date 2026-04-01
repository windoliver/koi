import { describe, expect, it } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { NexusRestClient } from "@koi/nexus-client";
import { createNexusRetriever } from "./nexus-retriever.js";
import type { NexusQueryResponse } from "./nexus-types.js";
import { BASE_CONFIG } from "./test-helpers.js";

function createClient(
  handler: (method: string, path: string) => Result<unknown, KoiError>,
): NexusRestClient {
  return {
    request: async <T>(method: string, path: string): Promise<Result<T, KoiError>> =>
      handler(method, path) as Result<T, KoiError>,
  };
}

const SUCCESS_RESPONSE: NexusQueryResponse = {
  results: [
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

describe("createNexusRetriever", () => {
  it("returns mapped results on success", async () => {
    const client = createClient(() => ({ ok: true, value: SUCCESS_RESPONSE }));
    const retriever = createNexusRetriever(client, BASE_CONFIG);

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
    let capturedPath = "";
    const client = createClient((_method, path) => {
      capturedPath = path;
      return { ok: true, value: { results: [], total: 0, has_more: false } };
    });

    const retriever = createNexusRetriever(client, BASE_CONFIG);
    await retriever.retrieve({
      text: "hello world",
      limit: 5,
      offset: 10,
      cursor: "abc",
      minScore: 0.5,
    });

    expect(capturedPath).toContain("q=hello+world");
    expect(capturedPath).toContain("limit=5");
    expect(capturedPath).toContain("offset=10");
    expect(capturedPath).toContain("cursor=abc");
    expect(capturedPath).toContain("min_score=0.5");
  });

  it("returns error on non-OK response", async () => {
    const client = createClient(() => ({
      ok: false,
      error: { code: "PERMISSION", message: "unauthorized", retryable: false },
    }));
    const retriever = createNexusRetriever(client, BASE_CONFIG);

    const result = await retriever.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PERMISSION");
  });

  it("returns VALIDATION error when filter is provided", async () => {
    const client = createClient(() => ({
      ok: true,
      value: { results: [], total: 0, has_more: false },
    }));
    const retriever = createNexusRetriever(client, BASE_CONFIG);

    const result = await retriever.retrieve({
      text: "test",
      limit: 10,
      filter: { kind: "eq", field: "lang", value: "en" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("filter");
  });

  it("returns VALIDATION error on malformed response", async () => {
    const client = createClient(() => ({
      ok: true,
      value: { not_valid: true },
    }));
    const retriever = createNexusRetriever(client, BASE_CONFIG);

    const result = await retriever.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Malformed");
  });

  it("returns empty results when hits is empty", async () => {
    const client = createClient(() => ({
      ok: true,
      value: { results: [], total: 0, has_more: false },
    }));
    const retriever = createNexusRetriever(client, BASE_CONFIG);

    const result = await retriever.retrieve({ text: "nothing", limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(0);
    expect(result.value.hasMore).toBe(false);
  });

  it("includes cursor in response when present", async () => {
    const client = createClient(() => ({
      ok: true,
      value: { results: [], total: 50, has_more: true, cursor: "next-page" },
    }));
    const retriever = createNexusRetriever(client, BASE_CONFIG);

    const result = await retriever.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cursor).toBe("next-page");
    expect(result.value.hasMore).toBe(true);
  });

  it("applies config defaultLimit when query.limit is not set", async () => {
    let capturedPath = "";
    const client = createClient((_method, path) => {
      capturedPath = path;
      return { ok: true, value: { results: [], total: 0, has_more: false } };
    });

    const retriever = createNexusRetriever(client, {
      ...BASE_CONFIG,
      defaultLimit: 25,
    });

    await retriever.retrieve({ text: "test", limit: 25 });

    expect(capturedPath).toContain("limit=25");
  });

  it("applies config minScore as default", async () => {
    let capturedPath = "";
    const client = createClient((_method, path) => {
      capturedPath = path;
      return { ok: true, value: { results: [], total: 0, has_more: false } };
    });

    const retriever = createNexusRetriever(client, {
      ...BASE_CONFIG,
      minScore: 0.3,
    });

    await retriever.retrieve({ text: "test", limit: 10 });

    expect(capturedPath).toContain("min_score=0.3");
  });
});
