import { afterEach, describe, expect, mock, test } from "bun:test";
import { discoverAuthServer } from "./discovery.js";

// ---------------------------------------------------------------------------
// Mock fetch for testing discovery without network
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

describe("discoverAuthServer", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns undefined when no metadata found", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as typeof fetch;

    const result = await discoverAuthServer("https://mcp.example.com");
    expect(result).toBeUndefined();
  });

  test("uses configured metadata URL when provided", async () => {
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    };

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch;

    const result = await discoverAuthServer("https://mcp.example.com", {
      authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
    });

    expect(result).toBeDefined();
    expect(result?.issuer).toBe("https://auth.example.com");
    expect(result?.authorizationEndpoint).toBe("https://auth.example.com/authorize");
    expect(result?.tokenEndpoint).toBe("https://auth.example.com/token");
  });

  test("rejects non-HTTPS metadata URL", async () => {
    await expect(
      discoverAuthServer("https://mcp.example.com", {
        authServerMetadataUrl: "http://auth.example.com/.well-known",
      }),
    ).rejects.toThrow(/must use https/);
  });

  test("discovers via RFC 9728 protected resource metadata", async () => {
    const resourceMeta = {
      authorization_servers: ["https://auth.example.com"],
    };
    const asMeta = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    };

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("oauth-protected-resource")) {
        return Promise.resolve(new Response(JSON.stringify(resourceMeta), { status: 200 }));
      }
      if (urlStr.includes("oauth-authorization-server")) {
        return Promise.resolve(new Response(JSON.stringify(asMeta), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch;

    const result = await discoverAuthServer("https://mcp.example.com");
    expect(result).toBeDefined();
    expect(result?.issuer).toBe("https://auth.example.com");
  });

  test("validates required metadata fields", async () => {
    const incompleteMeta = {
      issuer: "https://auth.example.com",
      // missing authorization_endpoint and token_endpoint
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(incompleteMeta), { status: 200 })),
    ) as typeof fetch;

    const result = await discoverAuthServer("https://mcp.example.com", {
      authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
    });
    expect(result).toBeUndefined();
  });

  test("returns code_challenge_methods_supported when present", async () => {
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      code_challenge_methods_supported: ["S256"],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 })),
    ) as typeof fetch;

    const result = await discoverAuthServer("https://mcp.example.com", {
      authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
    });
    expect(result?.codeChallengeMethodsSupported).toEqual(["S256"]);
  });
});
