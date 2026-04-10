import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SecureStorage } from "@koi/secure-storage";
import { createOAuthAuthProvider } from "./provider.js";
import type { OAuthRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockStorage(): SecureStorage {
  const data = new Map<string, string>();
  return {
    get: mock(async (key: string) => data.get(key)),
    set: mock(async (key: string, value: string) => {
      data.set(key, value);
    }),
    delete: mock(async (key: string) => data.delete(key)),
    withLock: mock(async (_key: string, fn: () => Promise<unknown>) =>
      fn(),
    ) as SecureStorage["withLock"],
  };
}

function createMockRuntime(): OAuthRuntime {
  return {
    authorize: mock(async () => "auth-code-123"),
    onReauthNeeded: mock(async () => {}),
  };
}

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOAuthAuthProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("token() returns undefined when no tokens stored", async () => {
    const provider = createOAuthAuthProvider({
      serverName: "test",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {},
      runtime: createMockRuntime(),
      storage: createMockStorage(),
    });

    // Mock discovery to return no metadata (no OAuth server)
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as unknown as typeof fetch;

    const result = await provider.token();
    expect(result).toBeUndefined();
  });

  test("token() returns stored access token when not expired", async () => {
    const storage = createMockStorage();
    // Pre-store a token
    const tokens = {
      accessToken: "valid-token",
      expiresAt: Date.now() + 3600_000,
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "test",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {},
      runtime: createMockRuntime(),
      storage,
    });

    // Manually store tokens via the storage key
    const { computeServerKey } = await import("./tokens.js");
    const key = computeServerKey("test", "https://mcp.example.com");
    await storage.set(key, JSON.stringify(tokens));

    const result = await provider.token();
    expect(result).toBe("valid-token");
  });

  test("handleUnauthorized clears tokens and notifies runtime", async () => {
    const storage = createMockStorage();
    const runtime = createMockRuntime();

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "test",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {},
      runtime,
      storage,
    });

    // Pre-store tokens
    const { computeServerKey } = await import("./tokens.js");
    const key = computeServerKey("test", "https://mcp.example.com");
    await storage.set(key, JSON.stringify({ accessToken: "old" }));

    await provider.handleUnauthorized();

    expect(runtime.onReauthNeeded).toHaveBeenCalledWith("test");
    // Tokens should be cleared
    const stored = await storage.get(key);
    expect(stored).toBeUndefined();
  });

  test("startAuthFlow returns false when no metadata discoverable", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "test",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {},
      runtime: createMockRuntime(),
      storage: createMockStorage(),
    });

    const result = await provider.startAuthFlow();
    expect(result).toBe(false);
  });

  test("startAuthFlow exchanges code and stores tokens on success", async () => {
    const storage = createMockStorage();
    const runtime = createMockRuntime();

    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    };

    const tokenResponse = {
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    };

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      if (urlStr.includes("/token")) {
        return Promise.resolve(new Response(JSON.stringify(tokenResponse), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "test",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    const result = await provider.startAuthFlow();
    expect(result).toBe(true);
    expect(runtime.authorize).toHaveBeenCalled();

    // Verify tokens stored
    const { computeServerKey } = await import("./tokens.js");
    const key = computeServerKey("test", "https://mcp.example.com");
    const stored = await storage.get(key);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored ?? "{}");
    expect(parsed.accessToken).toBe("new-access-token");
    expect(parsed.refreshToken).toBe("new-refresh-token");
  });
});
