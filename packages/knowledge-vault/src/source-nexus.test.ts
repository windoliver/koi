import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { scanNexus } from "./source-nexus.js";
import type { NexusSourceConfig } from "./types.js";

// Use a test server to mock Nexus HTTP responses
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

// Track responses per path for different test scenarios
const responseMap = new Map<string, { status: number; body: unknown }>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const handler = responseMap.get(url.pathname);
      if (handler !== undefined) {
        return new Response(JSON.stringify(handler.body), {
          status: handler.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${String(server.port)}`;
});

afterEach(() => {
  responseMap.clear();
});

afterAll(() => {
  server.stop(true);
});

describe("scanNexus", () => {
  test("fetches documents from nexus endpoint", async () => {
    responseMap.set("/knowledge", {
      status: 200,
      body: {
        documents: [
          {
            id: "doc-1",
            title: "Auth Patterns",
            content: "Authentication patterns and best practices.",
            tags: ["auth", "patterns"],
            lastModified: 1000,
          },
          {
            id: "doc-2",
            title: "API Design",
            content: "REST API design guidelines.",
            tags: ["api"],
          },
        ],
      },
    });

    const config: NexusSourceConfig = {
      kind: "nexus",
      name: "test-nexus",
      endpoint: `${baseUrl}/knowledge`,
    };

    const result = await scanNexus(config, 100);
    expect(result.documents).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);

    expect(result.documents[0]?.path).toBe("doc-1");
    expect(result.documents[0]?.title).toBe("Auth Patterns");
    expect(result.documents[0]?.tags).toEqual(["auth", "patterns"]);

    expect(result.documents[1]?.title).toBe("API Design");
  });

  test("returns warning on HTTP error", async () => {
    responseMap.set("/error", {
      status: 500,
      body: { error: "Internal server error" },
    });

    const config: NexusSourceConfig = {
      kind: "nexus",
      name: "failing-nexus",
      endpoint: `${baseUrl}/error`,
    };

    const result = await scanNexus(config, 100);
    expect(result.documents).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("HTTP 500");
  });

  test("returns warning on response error field", async () => {
    responseMap.set("/api-error", {
      status: 200,
      body: { error: "Rate limit exceeded" },
    });

    const config: NexusSourceConfig = {
      kind: "nexus",
      name: "rate-limited",
      endpoint: `${baseUrl}/api-error`,
    };

    const result = await scanNexus(config, 100);
    expect(result.documents).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Rate limit exceeded");
  });

  test("handles empty documents array", async () => {
    responseMap.set("/empty", {
      status: 200,
      body: { documents: [] },
    });

    const config: NexusSourceConfig = {
      kind: "nexus",
      endpoint: `${baseUrl}/empty`,
    };

    const result = await scanNexus(config, 100);
    expect(result.documents).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("handles missing optional fields with defaults", async () => {
    responseMap.set("/minimal", {
      status: 200,
      body: {
        documents: [{ id: "min-doc", content: "Minimal document." }],
      },
    });

    const config: NexusSourceConfig = {
      kind: "nexus",
      endpoint: `${baseUrl}/minimal`,
    };

    const result = await scanNexus(config, 100);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.title).toBe("min-doc");
    expect(result.documents[0]?.tags).toEqual([]);
    expect(result.documents[0]?.lastModified).toBeGreaterThan(0);
  });
});
