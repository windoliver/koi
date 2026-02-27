import { describe, expect, mock, test } from "bun:test";
import type { SkillRegistryEntry, SkillVersion } from "@koi/core";
import { skillId } from "@koi/core";
import type { RegistryHttpConfig } from "./config.js";
import { createSkillRegistryHttp } from "./skill-registry-http.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEntry(id: string): SkillRegistryEntry {
  return {
    id: skillId(id),
    name: `skill-${id}`,
    description: `Description for ${id}`,
    tags: ["test"],
    version: "1.0.0",
    publishedAt: Date.now(),
  };
}

function createMockFetch(
  handler: (url: string, init?: RequestInit) => Response,
): typeof globalThis.fetch {
  return mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
}

function createConfig(fetchFn: typeof globalThis.fetch): RegistryHttpConfig {
  return {
    baseUrl: "https://registry.example.com/v1",
    authToken: "test-token",
    fetch: fetchFn,
    cacheTtlMs: 60_000,
    maxCacheEntries: 100,
  };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe("search", () => {
  test("returns results from API", async () => {
    const entry = createMockEntry("skill-1");
    const fetchFn = createMockFetch(() =>
      Response.json({ items: [entry], cursor: undefined, total: 1 }),
    );
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const page = await registry.search({ text: "test" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("skill-1");
  });

  test("returns empty page on network failure", async () => {
    const fetchFn = createMockFetch(() => {
      throw new Error("Network error");
    });
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const page = await registry.search({ text: "test" });
    expect(page.items).toHaveLength(0);
  });

  test("passes query parameters correctly", async () => {
    let capturedUrl = "";
    const fetchFn = createMockFetch((url) => {
      capturedUrl = url;
      return Response.json({ items: [] });
    });
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    await registry.search({ text: "hello", tags: ["a", "b"], cursor: "next-page" });
    expect(capturedUrl).toContain("text=hello");
    expect(capturedUrl).toContain("tags=a%2Cb");
    expect(capturedUrl).toContain("cursor=next-page");
  });

  test("caches individual entries from search results", async () => {
    const entry = createMockEntry("skill-cache");
    let callCount = 0;
    const fetchFn = createMockFetch((url) => {
      callCount++;
      if (url.includes("/skills/skill-cache")) {
        return Response.json(entry);
      }
      return Response.json({ items: [entry] });
    });
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    // Search populates cache
    await registry.search({});
    expect(callCount).toBe(1);

    // get should use cache, not make another request
    const result = await registry.get(skillId("skill-cache"));
    expect(result.ok).toBe(true);
    expect(callCount).toBe(1); // No additional fetch
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("get", () => {
  test("returns entry from API", async () => {
    const entry = createMockEntry("s1");
    const fetchFn = createMockFetch(() => Response.json(entry));
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const result = await registry.get(skillId("s1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("skill-s1");
    }
  });

  test("returns NOT_FOUND for 404", async () => {
    const fetchFn = createMockFetch(() => new Response("not found", { status: 404 }));
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const result = await registry.get(skillId("missing"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("caches successful responses", async () => {
    const entry = createMockEntry("cached");
    let callCount = 0;
    const fetchFn = createMockFetch(() => {
      callCount++;
      return Response.json(entry);
    });
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    await registry.get(skillId("cached"));
    await registry.get(skillId("cached"));
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

describe("versions", () => {
  test("returns version list", async () => {
    const versions: SkillVersion[] = [
      { version: "1.0.0", publishedAt: 1000 },
      { version: "0.9.0", publishedAt: 900, deprecated: true },
    ];
    const fetchFn = createMockFetch(() => Response.json(versions));
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const result = await registry.versions(skillId("s1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

describe("install", () => {
  test("returns artifact from API", async () => {
    const artifact = {
      id: "brick_skill-1",
      kind: "skill",
      name: "test-skill",
      content: "# Test",
    };
    const fetchFn = createMockFetch(() => Response.json(artifact));
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const result = await registry.install(skillId("s1"));
    expect(result.ok).toBe(true);
  });

  test("passes version parameter when provided", async () => {
    let capturedUrl = "";
    const fetchFn = createMockFetch((url) => {
      capturedUrl = url;
      return Response.json({});
    });
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    await registry.install(skillId("s1"), "2.0.0");
    expect(capturedUrl).toContain("version=2.0.0");
  });
});

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

describe("publish", () => {
  test("posts to /skills and returns entry", async () => {
    const entry = createMockEntry("new-skill");
    let capturedMethod = "";
    const fetchFn = createMockFetch((_url, init) => {
      capturedMethod = init?.method ?? "";
      return Response.json(entry);
    });
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const result = await registry.publish({
      id: skillId("new-skill"),
      name: "new-skill",
      description: "A new skill",
      tags: ["test"],
      version: "1.0.0",
      content: "# Content",
    });
    expect(result.ok).toBe(true);
    expect(capturedMethod).toBe("POST");
  });

  test("returns error on server failure", async () => {
    const fetchFn = createMockFetch(() => new Response("Internal error", { status: 500 }));
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const result = await registry.publish({
      id: skillId("fail"),
      name: "fail",
      description: "will fail",
      tags: [],
      version: "1.0.0",
      content: "#",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// unpublish
// ---------------------------------------------------------------------------

describe("unpublish", () => {
  test("sends DELETE request", async () => {
    let capturedMethod = "";
    const fetchFn = createMockFetch((_url, init) => {
      capturedMethod = init?.method ?? "";
      return new Response(null, { status: 204 });
    });
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const result = await registry.unpublish(skillId("remove-me"));
    expect(result.ok).toBe(true);
    expect(capturedMethod).toBe("DELETE");
  });

  test("invalidates cache on success", async () => {
    const entry = createMockEntry("to-remove");
    let callCount = 0;
    const fetchFn = createMockFetch((_url, init) => {
      callCount++;
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return Response.json(entry);
    });
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    // Populate cache
    await registry.get(skillId("to-remove"));
    expect(callCount).toBe(1);

    // Unpublish — invalidates cache
    await registry.unpublish(skillId("to-remove"));

    // Next get should hit network
    await registry.get(skillId("to-remove"));
    expect(callCount).toBe(3); // get + delete + get
  });
});

// ---------------------------------------------------------------------------
// deprecate
// ---------------------------------------------------------------------------

describe("deprecate", () => {
  test("posts to deprecate endpoint", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchFn = createMockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(null, { status: 204 });
    });
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const result = await registry.deprecate(skillId("old-skill"), "1.0.0");
    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain("/deprecate");
    expect(capturedBody).toContain("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// Auth header
// ---------------------------------------------------------------------------

describe("auth", () => {
  test("sends Bearer token in Authorization header", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const fetchFn = createMockFetch((_url, init) => {
      capturedHeaders = init?.headers;
      return Response.json(createMockEntry("auth-test"));
    });
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    await registry.get(skillId("auth-test"));
    const headers = capturedHeaders as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer test-token");
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("error mapping", () => {
  test("maps 401 to PERMISSION error", async () => {
    const fetchFn = createMockFetch(() => new Response("Unauthorized", { status: 401 }));
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const result = await registry.get(skillId("unauthorized"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("maps 429 to RATE_LIMIT error", async () => {
    const fetchFn = createMockFetch(() => new Response("Too many requests", { status: 429 }));
    const registry = createSkillRegistryHttp(createConfig(fetchFn));

    const result = await registry.get(skillId("rate-limited"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
  });
});
