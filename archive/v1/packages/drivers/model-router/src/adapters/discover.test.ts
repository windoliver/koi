import { afterEach, describe, expect, mock, test } from "bun:test";
import { discoverLocalProviders } from "./discover.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchByUrl(
  urlHandlers: Record<
    string,
    () => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown> }>
  >,
): void {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Respect abort signal
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const handler = urlHandlers[url];
    if (handler) return handler();

    throw new TypeError("fetch failed: Connection refused");
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// discoverLocalProviders
// ---------------------------------------------------------------------------

describe("discoverLocalProviders", () => {
  test("discovers Ollama when /api/tags responds ok", async () => {
    mockFetchByUrl({
      "http://localhost:11434/api/tags": () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ models: [{ name: "llama3.2:3b" }] }),
        }),
    });

    const providers = await discoverLocalProviders({ providers: ["ollama"] });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.kind).toBe("ollama");
    expect(providers[0]?.baseUrl).toBe("http://localhost:11434");
  });

  test("discovers vLLM when /health responds ok", async () => {
    mockFetchByUrl({
      "http://localhost:8000/health": () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error("no json")),
        }),
    });

    const providers = await discoverLocalProviders({ providers: ["vllm"] });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.kind).toBe("vllm");
    expect(providers[0]?.baseUrl).toBe("http://localhost:8000");
  });

  test("discovers LM Studio when /v1/models responds ok", async () => {
    mockFetchByUrl({
      "http://localhost:1234/v1/models": () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ id: "lmstudio-community/Llama-3.2-3B" }] }),
        }),
    });

    const providers = await discoverLocalProviders({ providers: ["lm-studio"] });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.kind).toBe("lm-studio");
    expect(providers[0]?.baseUrl).toBe("http://localhost:1234");
  });

  test("returns empty array when no providers found", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("fetch failed: Connection refused")),
    ) as unknown as typeof fetch;

    const providers = await discoverLocalProviders();

    expect(providers).toHaveLength(0);
  });

  test("respects custom timeout", async () => {
    // Use a very short timeout to ensure it triggers
    globalThis.fetch = mock(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;

    const providers = await discoverLocalProviders({ timeoutMs: 50 });

    expect(providers).toHaveLength(0);
  }, 10_000);

  test("filters by providers option", async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedUrls.push(url);
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ models: [] }),
      };
    }) as unknown as typeof fetch;

    await discoverLocalProviders({ providers: ["ollama"] });

    // Should only have called fetch for Ollama's URL
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain("localhost:11434");
  });

  test("extracts model names from Ollama /api/tags", async () => {
    mockFetchByUrl({
      "http://localhost:11434/api/tags": () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              models: [
                { name: "llama3.2:3b" },
                { name: "codellama:7b" },
                { name: "mistral:latest" },
              ],
            }),
        }),
    });

    const providers = await discoverLocalProviders({ providers: ["ollama"] });

    expect(providers[0]?.models).toEqual(["llama3.2:3b", "codellama:7b", "mistral:latest"]);
  });

  test("extracts model names from /v1/models", async () => {
    mockFetchByUrl({
      "http://localhost:1234/v1/models": () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: [
                { id: "lmstudio-community/Llama-3.2-3B" },
                { id: "lmstudio-community/Mistral-7B" },
              ],
            }),
        }),
    });

    const providers = await discoverLocalProviders({ providers: ["lm-studio"] });

    expect(providers[0]?.models).toEqual([
      "lmstudio-community/Llama-3.2-3B",
      "lmstudio-community/Mistral-7B",
    ]);
  });

  test("handles JSON parse error gracefully", async () => {
    mockFetchByUrl({
      "http://localhost:8000/health": () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError("Unexpected end of JSON")),
        }),
    });

    const providers = await discoverLocalProviders({ providers: ["vllm"] });

    // Should still discover the provider, just with empty models
    expect(providers).toHaveLength(1);
    expect(providers[0]?.kind).toBe("vllm");
    expect(providers[0]?.models).toEqual([]);
  });

  test("probes all providers concurrently", async () => {
    const callOrder: string[] = [];

    mockFetchByUrl({
      "http://localhost:11434/api/tags": async () => {
        callOrder.push("ollama");
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ models: [] }),
        };
      },
      "http://localhost:8000/health": async () => {
        callOrder.push("vllm");
        return {
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error("no json")),
        };
      },
      "http://localhost:1234/v1/models": async () => {
        callOrder.push("lm-studio");
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [] }),
        };
      },
    });

    const providers = await discoverLocalProviders();

    // All three should be discovered
    expect(providers).toHaveLength(3);
    // All probes should have been initiated (order may vary due to concurrency)
    expect(callOrder).toHaveLength(3);
    expect(callOrder).toContain("ollama");
    expect(callOrder).toContain("vllm");
    expect(callOrder).toContain("lm-studio");
  });
});
