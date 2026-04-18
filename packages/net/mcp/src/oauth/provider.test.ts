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
    authorize: mock(async (authUrl: string) => {
      // Extract state from the authorization URL to simulate valid callback
      const url = new URL(authUrl);
      const state = url.searchParams.get("state") ?? undefined;
      return { code: "auth-code-123", state };
    }),
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

  test("handleUnauthorized clears tokens and notifies runtime when refresh fails", async () => {
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

    // Pre-store expired tokens (no refresh token — can't refresh)
    const { computeServerKey } = await import("./tokens.js");
    const key = computeServerKey("test", "https://mcp.example.com");
    await storage.set(key, JSON.stringify({ accessToken: "old", expiresAt: Date.now() - 1000 }));

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
        clientId: "configured",
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

  test("auth URL and token exchange carry resource parameter (RFC 8707)", async () => {
    const storage = createMockStorage();
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    };

    let seenAuthResource: string | undefined;
    let seenTokenResource: string | undefined;

    const runtime: OAuthRuntime = {
      authorize: mock(async (authUrl: string) => {
        const url = new URL(authUrl);
        seenAuthResource = url.searchParams.get("resource") ?? undefined;
        const state = url.searchParams.get("state") ?? undefined;
        return { code: "code-ok", state };
      }),
      onReauthNeeded: mock(async () => {}),
    };

    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      if (urlStr.includes("/token")) {
        const body = new URLSearchParams((init?.body as string) ?? "");
        seenTokenResource = body.get("resource") ?? undefined;
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "r",
      serverUrl: "https://mcp.example.com/v1",
      oauthConfig: {
        clientId: "c",
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    await provider.startAuthFlow();
    expect(seenAuthResource).toBe("https://mcp.example.com/v1");
    expect(seenTokenResource).toBe("https://mcp.example.com/v1");
  });

  test("falls back to dynamic client registration when no clientId configured", async () => {
    const storage = createMockStorage();
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
    };

    let registeredOnce = false;
    let authUrlClientId: string | undefined;

    const runtime: OAuthRuntime = {
      authorize: mock(async (authUrl: string) => {
        const url = new URL(authUrl);
        authUrlClientId = url.searchParams.get("client_id") ?? undefined;
        const state = url.searchParams.get("state") ?? undefined;
        return { code: "code", state };
      }),
      onReauthNeeded: mock(async () => {}),
    };

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      if (urlStr.endsWith("/register")) {
        registeredOnce = true;
        return Promise.resolve(
          new Response(JSON.stringify({ client_id: "dyn-123" }), { status: 201 }),
        );
      }
      if (urlStr.includes("/token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "dyn",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    const ok = await provider.startAuthFlow();
    expect(ok).toBe(true);
    expect(registeredOnce).toBe(true);
    expect(authUrlClientId).toBe("dyn-123");

    // Registered client persisted under the client-info key
    const { computeClientKey } = await import("./tokens.js");
    const storedClient = await storage.get(computeClientKey("dyn", "https://mcp.example.com"));
    expect(storedClient).toBeDefined();
    const parsed = JSON.parse(storedClient ?? "{}");
    expect(parsed.clientId).toBe("dyn-123");
  });

  test("reuses persisted dynamically-registered client on subsequent flows", async () => {
    const storage = createMockStorage();
    const { computeClientKey } = await import("./tokens.js");
    await storage.set(
      computeClientKey("reuse", "https://mcp.example.com"),
      JSON.stringify({ clientId: "prev-reg", registeredAt: 1 }),
    );

    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
    };

    let registerCalls = 0;
    let authUrlClientId: string | undefined;

    const runtime: OAuthRuntime = {
      authorize: mock(async (authUrl: string) => {
        const url = new URL(authUrl);
        authUrlClientId = url.searchParams.get("client_id") ?? undefined;
        return { code: "code", state: url.searchParams.get("state") ?? undefined };
      }),
      onReauthNeeded: mock(async () => {}),
    };

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      if (urlStr.endsWith("/register")) {
        registerCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ client_id: "should-not-run" }), { status: 201 }),
        );
      }
      if (urlStr.includes("/token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "reuse",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    await provider.startAuthFlow();
    expect(registerCalls).toBe(0);
    expect(authUrlClientId).toBe("prev-reg");
  });

  test("returns false when no clientId and no registration_endpoint", async () => {
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 })),
    ) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "no-dcr",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime: createMockRuntime(),
      storage: createMockStorage(),
    });

    expect(await provider.startAuthFlow()).toBe(false);
  });
});
