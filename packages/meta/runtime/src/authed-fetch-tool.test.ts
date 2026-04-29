import { describe, expect, test } from "bun:test";
import type { CredentialComponent, JsonObject } from "@koi/core";

import { createAuthedFetchTool } from "./authed-fetch-tool.js";

interface FetchSpy {
  readonly fn: typeof fetch;
  readonly calls: { url: string; init: RequestInit | undefined }[];
}

function makeFetchSpy(response: Response): FetchSpy {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response.clone();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const credsAllowOnlyOpenAI: CredentialComponent = {
  async get(key) {
    if (key === "openai_api_key") return "sk-secret-shouldnt-leak";
    return undefined;
  },
};

describe("createAuthedFetchTool", () => {
  test("rejects empty url", async () => {
    const tool = createAuthedFetchTool({ credentials: credsAllowOnlyOpenAI });
    const result = (await tool.execute({ url: "", credKey: "openai_api_key" })) as JsonObject;
    expect(result.code).toBe("VALIDATION");
  });

  test("rejects non-http url", async () => {
    const tool = createAuthedFetchTool({ credentials: credsAllowOnlyOpenAI });
    const result = (await tool.execute({
      url: "ftp://example.com",
      credKey: "openai_api_key",
    })) as JsonObject;
    expect(result.code).toBe("VALIDATION");
  });

  test("rejects empty credKey", async () => {
    const tool = createAuthedFetchTool({ credentials: credsAllowOnlyOpenAI });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "",
    })) as JsonObject;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns PERMISSION when credKey resolves to undefined", async () => {
    const spy = makeFetchSpy(new Response("nope", { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "stripe_secret",
    })) as JsonObject;
    expect(result.code).toBe("PERMISSION");
    expect(spy.calls).toHaveLength(0);
    // Identical message regardless of cause — agents can't enumerate
    expect(typeof result.error).toBe("string");
    expect((result.error as string).includes("not in scope or not configured")).toBe(true);
  });

  test("attaches Authorization: Bearer <cred> by default", async () => {
    const spy = makeFetchSpy(new Response("ok", { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
    })) as JsonObject;
    expect(result.status).toBe(200);
    expect(spy.calls).toHaveLength(1);
    const headers = spy.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-secret-shouldnt-leak");
  });

  test("honors custom scheme and headerName", async () => {
    const spy = makeFetchSpy(new Response("ok", { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
      scheme: "Token",
      headerName: "X-Api-Key",
    });
    const headers = spy.calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("Token sk-secret-shouldnt-leak");
    expect(headers.Authorization).toBeUndefined();
  });

  test("empty scheme passes the bare credential value", async () => {
    const spy = makeFetchSpy(new Response("ok", { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
      scheme: "",
    });
    const headers = spy.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("sk-secret-shouldnt-leak");
  });

  test("response body never echoes the credential value", async () => {
    const spy = makeFetchSpy(new Response("hello", { status: 200 }));
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: spy.fn,
    });
    const result = (await tool.execute({
      url: "https://example.com",
      credKey: "openai_api_key",
    })) as JsonObject;
    expect(result.body).toBe("hello");
    expect(JSON.stringify(result)).not.toContain("sk-secret-shouldnt-leak");
  });

  test("propagates URL-scope rejection from a wrapped fetch", async () => {
    const wrappedFetch = (async () => {
      throw new Error("governance-scope: URL 'https://blocked' is outside the allowed fetch scope");
    }) as unknown as typeof fetch;
    const tool = createAuthedFetchTool({
      credentials: credsAllowOnlyOpenAI,
      fetchFn: wrappedFetch,
    });
    const result = (await tool.execute({
      url: "https://blocked",
      credKey: "openai_api_key",
    })) as JsonObject;
    expect(result.code).toBe("EXTERNAL");
    expect((result.error as string).includes("outside the allowed fetch scope")).toBe(true);
  });
});
