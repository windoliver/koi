import { describe, expect, test } from "bun:test";
import { createRegistryClient } from "./client.js";

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(url, init));
  };
  return fn as unknown as typeof fetch;
}

describe("createRegistryClient.searchServers", () => {
  test("hits the v0.1/servers endpoint with query and limit", async () => {
    let captured = "";
    const client = createRegistryClient({
      baseUrl: "https://reg.example.com",
      fetch: mockFetch((url) => {
        captured = url;
        return new Response(JSON.stringify({ servers: [] }), { status: 200 });
      }),
    });
    const result = await client.searchServers({ query: "git", limit: 10 });
    expect(result.ok).toBe(true);
    expect(captured).toContain("https://reg.example.com/v0.1/servers");
    expect(captured).toContain("search=git");
    expect(captured).toContain("limit=10");
  });

  test("URL-encodes the query param", async () => {
    let captured = "";
    const client = createRegistryClient({
      fetch: mockFetch((url) => {
        captured = url;
        return new Response(JSON.stringify({ servers: [] }), { status: 200 });
      }),
    });
    await client.searchServers({ query: "foo bar/baz" });
    // URLSearchParams encodes space as "+" (form encoding) — both "+" and "%20" are valid.
    expect(captured).toMatch(/search=foo(\+|%20)bar%2Fbaz/);
  });

  test("returns parsed results with nextCursor", async () => {
    const client = createRegistryClient({
      fetch: mockFetch(
        () =>
          new Response(
            JSON.stringify({
              servers: [{ name: "io.example/a", description: "a", version: "1.0.0" }],
              metadata: { nextCursor: "next-1", count: 1 },
            }),
            { status: 200 },
          ),
      ),
    });
    const result = await client.searchServers({ query: "a" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.servers).toHaveLength(1);
    expect(result.value.nextCursor).toBe("next-1");
  });

  test("maps 429 to retryable RATE_LIMIT error", async () => {
    const client = createRegistryClient({
      fetch: mockFetch(() => new Response("rate limited", { status: 429 })),
    });
    const result = await client.searchServers({ query: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("RATE_LIMIT");
    expect(result.error.retryable).toBe(true);
  });

  test("maps 5xx to retryable EXTERNAL error", async () => {
    const client = createRegistryClient({
      fetch: mockFetch(() => new Response("oops", { status: 503 })),
    });
    const result = await client.searchServers({ query: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.retryable).toBe(true);
  });

  test("maps malformed JSON to VALIDATION error", async () => {
    const client = createRegistryClient({
      fetch: mockFetch(() => new Response("not json", { status: 200 })),
    });
    const result = await client.searchServers({ query: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("VALIDATION");
  });

  test("maps fetch throw to EXTERNAL error", async () => {
    const client = createRegistryClient({
      fetch: (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch,
    });
    const result = await client.searchServers({ query: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("network down");
  });
});

describe("createRegistryClient.getServer", () => {
  test("URL-encodes reverse-DNS server name with slashes", async () => {
    let captured = "";
    const client = createRegistryClient({
      fetch: mockFetch((url) => {
        captured = url;
        return new Response(
          JSON.stringify({ name: "io.example/foo", description: "x", version: "1.0.0" }),
          { status: 200 },
        );
      }),
    });
    await client.getServer("io.example/foo");
    expect(captured).toContain("/v0.1/servers/io.example%2Ffoo/versions/latest");
  });

  test("uses provided version", async () => {
    let captured = "";
    const client = createRegistryClient({
      fetch: mockFetch((url) => {
        captured = url;
        return new Response(
          JSON.stringify({ name: "io.example/foo", description: "x", version: "2.0.0" }),
          { status: 200 },
        );
      }),
    });
    await client.getServer("io.example/foo", "2.0.0");
    expect(captured).toContain("/versions/2.0.0");
  });

  test("returns NOT_FOUND on 404", async () => {
    const client = createRegistryClient({
      fetch: mockFetch(() => new Response("nope", { status: 404 })),
    });
    const result = await client.getServer("io.example/missing");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("returns parsed server detail on 200", async () => {
    const client = createRegistryClient({
      fetch: mockFetch(
        () =>
          new Response(
            JSON.stringify({
              name: "io.example/foo",
              description: "Foo server",
              version: "1.0.0",
              packages: [{ registryType: "npm", identifier: "@foo/mcp", version: "1.0.0" }],
            }),
            { status: 200 },
          ),
      ),
    });
    const result = await client.getServer("io.example/foo");
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.name).toBe("io.example/foo");
    expect(result.value.packages?.[0]?.identifier).toBe("@foo/mcp");
  });
});
