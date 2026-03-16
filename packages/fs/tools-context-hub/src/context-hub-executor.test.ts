import { describe, expect, test } from "bun:test";
import { type ContextHubExecutorConfig, createContextHubExecutor } from "./context-hub-executor.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_REGISTRY = {
  version: "1.0.0",
  generated: "2026-01-01T00:00:00Z",
  docs: [
    {
      id: "stripe/payments",
      name: "Stripe Payments API",
      description: "Accept payments online with Stripe",
      source: "official",
      tags: ["payments", "billing"],
      languages: [
        {
          language: "javascript",
          versions: [
            {
              version: "2.0.0",
              path: "stripe/payments/javascript/DOC.md",
              size: 5000,
              lastUpdated: "2026-01-01",
            },
          ],
          recommendedVersion: "2.0.0",
        },
        {
          language: "python",
          versions: [
            {
              version: "2.0.0",
              path: "stripe/payments/python/DOC.md",
              size: 4800,
              lastUpdated: "2026-01-01",
            },
          ],
          recommendedVersion: "2.0.0",
        },
      ],
    },
    {
      id: "openai/chat",
      name: "OpenAI Chat Completions",
      description: "Generate text with GPT models",
      source: "community",
      tags: ["ai", "llm"],
      languages: [
        {
          language: "python",
          versions: [
            {
              version: "1.0.0",
              path: "openai/chat/python/DOC.md",
              size: 3000,
              lastUpdated: "2025-12-01",
            },
          ],
          recommendedVersion: "1.0.0",
        },
      ],
    },
  ],
  base_url: "https://cdn.test.example/v1",
};

const FIXTURE_DOC_CONTENT =
  "# Stripe Payments API\n\nAccept payments with Stripe.\n\n## Quick Start\n...";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Creates a fetch stub that returns fixture data based on URL. */
function createMockFetch(overrides?: {
  readonly registryStatus?: number;
  readonly registryBody?: unknown;
  readonly docStatus?: number;
  readonly docBody?: string;
}): FetchFn {
  const registryStatus = overrides?.registryStatus ?? 200;
  const registryBody = overrides?.registryBody ?? FIXTURE_REGISTRY;
  const docStatus = overrides?.docStatus ?? 200;
  const docBody = overrides?.docBody ?? FIXTURE_DOC_CONTENT;

  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("registry.json")) {
      return new Response(JSON.stringify(registryBody), {
        status: registryStatus,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("DOC.md")) {
      return new Response(docBody, {
        status: docStatus,
        headers: { "content-type": "text/markdown" },
      });
    }

    return new Response("Not Found", { status: 404 });
  };
}

function createExecutor(
  overrides?: Parameters<typeof createMockFetch>[0],
  config?: Partial<ContextHubExecutorConfig>,
): ReturnType<typeof createContextHubExecutor> {
  return createContextHubExecutor({
    fetchFn: createMockFetch(overrides),
    baseUrl: "https://cdn.test.example/v1",
    cacheTtlMs: 60_000,
    ...config,
  });
}

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

describe("ContextHubExecutor.search", () => {
  test("returns ranked results for valid query", async () => {
    const executor = createExecutor();
    const result = await executor.search("stripe payments");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
    expect(result.value[0]?.id).toBe("stripe/payments");
    expect(result.value[0]?.name).toBe("Stripe Payments API");
    expect(result.value[0]?.source).toBe("official");
    expect(result.value[0]?.tags).toContain("payments");
  });

  test("returns rich metadata including languages", async () => {
    const executor = createExecutor();
    const result = await executor.search("stripe");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value[0];
    expect(doc?.languages.length).toBeGreaterThan(0);
    expect(doc?.languages[0]?.language).toBeDefined();
    expect(doc?.languages[0]?.recommendedVersion).toBeDefined();
  });

  test("returns empty array for no matches", async () => {
    const executor = createExecutor();
    const result = await executor.search("kubernetes helm charts");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  test("respects maxResults parameter", async () => {
    const executor = createExecutor();
    const result = await executor.search("api", 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeLessThanOrEqual(1);
  });

  test("returns REGISTRY_UNAVAILABLE when CDN is down", async () => {
    const executor = createExecutor({ registryStatus: 500 });
    const result = await executor.search("stripe");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("Registry unavailable");
    expect(result.error.retryable).toBe(true);
  });

  test("returns VALIDATION for invalid registry JSON schema", async () => {
    const executor = createExecutor({ registryBody: { invalid: true } });
    const result = await executor.search("stripe");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("schema mismatch");
  });

  test("rebuilds search index when registry content changes after TTL expiry", async () => {
    // Regression: same version, same doc count, but changed name/description/tags.
    // The search index must reflect the new content, not the stale cached index.
    const makeRegistry = (desc: string, tags: readonly string[]): typeof FIXTURE_REGISTRY => ({
      version: "1.0.0",
      generated: "2026-01-01T00:00:00Z",
      base_url: "https://cdn.test.example/v1",
      docs: [
        {
          id: "acme/api",
          name: desc,
          description: `${desc} integration`,
          source: "official",
          tags: [...tags],
          languages: [
            {
              language: "javascript",
              versions: [
                {
                  version: "1.0.0",
                  path: "acme/api/javascript/DOC.md",
                  size: 2000,
                  lastUpdated: "2026-01-01",
                },
              ],
              recommendedVersion: "1.0.0",
            },
          ],
        },
      ],
    });

    let currentRegistry = makeRegistry("payments", ["payments", "billing"]);
    const fetchFn: FetchFn = async (input, _init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("registry.json")) {
        return new Response(JSON.stringify(currentRegistry), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("doc content", { status: 200 });
    };

    const executor = createContextHubExecutor({
      fetchFn,
      baseUrl: "https://cdn.test.example/v1",
      cacheTtlMs: 50, // 50ms TTL for fast test
    });

    // First search — "messaging" not in V1 content
    const r1 = await executor.search("messaging");
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toEqual([]);

    // Wait for registry TTL to expire, swap to content with "messaging"
    await new Promise((resolve) => setTimeout(resolve, 60));
    currentRegistry = makeRegistry("messaging", ["sms", "messaging"]);

    // Second search — must rebuild index and find "messaging"
    const r2 = await executor.search("messaging");
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.length).toBeGreaterThan(0);
      expect(r2.value[0]?.id).toBe("acme/api");
    }
  });

  test("returns TIMEOUT when fetch aborts", async () => {
    const executor = createContextHubExecutor({
      fetchFn: async (): Promise<Response> => {
        throw new DOMException("The operation was aborted", "AbortError");
      },
      timeoutMs: 100,
    });
    const result = await executor.search("stripe");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe("ContextHubExecutor.get", () => {
  test("returns doc content for valid id", async () => {
    const executor = createExecutor();
    const result = await executor.get("openai/chat");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("openai/chat");
    expect(result.value.content).toContain("Stripe");
    expect(result.value.language).toBe("python");
    expect(result.value.version).toBe("1.0.0");
    expect(result.value.truncated).toBe(false);
  });

  test("returns doc for specific language variant", async () => {
    const executor = createExecutor();
    const result = await executor.get("stripe/payments", "python");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.language).toBe("python");
  });

  test("auto-selects language when only one exists", async () => {
    const executor = createExecutor();
    const result = await executor.get("openai/chat");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.language).toBe("python");
  });

  test("returns LANG_NOT_FOUND when multiple languages exist and none specified", async () => {
    const executor = createExecutor();
    const result = await executor.get("stripe/payments");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("Multiple languages");
    expect(result.error.message).toContain("javascript");
    expect(result.error.message).toContain("python");
  });

  test("returns NOT_FOUND for nonexistent language", async () => {
    const executor = createExecutor();
    const result = await executor.get("stripe/payments", "ruby");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("ruby");
    expect(result.error.message).toContain("Available");
  });

  test("returns NOT_FOUND for nonexistent doc id", async () => {
    const executor = createExecutor();
    const result = await executor.get("nonexistent/doc");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("returns NOT_FOUND when CDN returns 404", async () => {
    const executor = createExecutor({ docStatus: 404 });
    const result = await executor.get("openai/chat");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("truncates large docs and sets truncated flag", async () => {
    const largeDoc = "x".repeat(60_000);
    const executor = createExecutor({ docBody: largeDoc }, { maxBodyChars: 50_000 });
    const result = await executor.get("openai/chat");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.content.length).toBe(50_000);
  });

  test("caches doc content on subsequent calls", async () => {
    let fetchCount = 0;
    const countingFetch: FetchFn = async (input, init) => {
      fetchCount++;
      return createMockFetch()(input, init);
    };

    const executor = createContextHubExecutor({
      fetchFn: countingFetch,
      baseUrl: "https://cdn.test.example/v1",
      cacheTtlMs: 60_000,
    });

    // First call: fetches registry + doc = 2 fetches
    await executor.get("openai/chat");
    const firstCount = fetchCount;

    // Second call: should use cache = 0 additional fetches
    await executor.get("openai/chat");
    expect(fetchCount).toBe(firstCount);
  });

  test("returns REGISTRY_UNAVAILABLE when CDN is down", async () => {
    const executor = createExecutor({ registryStatus: 503 });
    const result = await executor.get("stripe/payments", "javascript");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("Registry unavailable");
  });
});
