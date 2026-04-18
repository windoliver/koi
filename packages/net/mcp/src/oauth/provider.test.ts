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

  test("omits resource parameter when includeResourceParameter: false (legacy AS)", async () => {
    // Legacy authorization servers reject `resource` with invalid_target.
    // The opt-out lets operators preserve compatibility on a per-server
    // basis without losing OAuth functionality.
    const storage = createMockStorage();
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    };

    let authResource: string | null = "sentinel";
    let tokenResource: string | null = "sentinel";

    const runtime: OAuthRuntime = {
      authorize: mock(async (authUrl: string) => {
        const url = new URL(authUrl);
        authResource = url.searchParams.get("resource");
        return { code: "c", state: url.searchParams.get("state") ?? undefined };
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
        tokenResource = body.get("resource");
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "legacy",
      serverUrl: "https://mcp.example.com/v1",
      oauthConfig: {
        clientId: "c",
        includeResourceParameter: false,
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    await provider.startAuthFlow();
    expect(authResource).toBeNull();
    expect(tokenResource).toBeNull();
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

  test("concurrent DCR flows register at most one client (single winner)", async () => {
    // Simulate a lock that serializes the register/write sequence. Two
    // overlapping startAuthFlow() calls must end up with the same
    // persisted client id, not two competing writes.
    const map = new Map<string, string>();
    let heldFor: string | undefined;
    const waiters: Array<() => void> = [];
    const mockStorage = {
      get: async (key: string) => map.get(key),
      set: async (key: string, value: string) => {
        map.set(key, value);
      },
      delete: async (key: string) => map.delete(key),
      withLock: async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
        while (heldFor === key) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        heldFor = key;
        try {
          return await fn();
        } finally {
          heldFor = undefined;
          const next = waiters.shift();
          if (next !== undefined) next();
        }
      },
    } satisfies SecureStorage;

    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
    };

    let registerCounter = 0;
    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      if (urlStr.endsWith("/register")) {
        registerCounter += 1;
        const assigned = `dyn-${registerCounter}`;
        return Promise.resolve(
          new Response(JSON.stringify({ client_id: assigned }), { status: 201 }),
        );
      }
      if (urlStr.includes("/token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const make = (): ReturnType<typeof createOAuthAuthProvider> =>
      createOAuthAuthProvider({
        serverName: "race",
        serverUrl: "https://mcp.example.com",
        oauthConfig: {
          authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
        },
        runtime: createMockRuntime(),
        storage: mockStorage,
      });

    const a = make();
    const b = make();

    await Promise.all([a.startAuthFlow(), b.startAuthFlow()]);

    // Both providers must agree on the persisted client id — only one
    // registration should have actually been committed to storage.
    const { computeClientKey } = await import("./tokens.js");
    const stored = map.get(computeClientKey("race", "https://mcp.example.com"));
    expect(stored).toBeDefined();
    const { clientId } = JSON.parse(stored ?? "{}");
    expect(["dyn-1", "dyn-2"]).toContain(clientId);
    // And only one of the two register calls should have "won". If the
    // second saw the first's write under lock, it would not re-register.
    expect(registerCounter).toBe(1);
  });

  test("invalidates persisted DCR client when issuer changes", async () => {
    const storage = createMockStorage();
    const { computeClientKey } = await import("./tokens.js");
    // Persist a client bound to an old issuer that no longer matches
    // the currently-discovered authorization server.
    await storage.set(
      computeClientKey("migrated", "https://mcp.example.com"),
      JSON.stringify({
        clientId: "stale-client",
        registeredAt: 1,
        issuer: "https://old-auth.example.com",
        registrationEndpoint: "https://old-auth.example.com/register",
      }),
    );

    const metadata = {
      issuer: "https://new-auth.example.com",
      authorization_endpoint: "https://new-auth.example.com/authorize",
      token_endpoint: "https://new-auth.example.com/token",
      registration_endpoint: "https://new-auth.example.com/register",
    };

    let registerCalls = 0;
    let authUrlClientId: string | undefined;

    const runtime: OAuthRuntime = {
      authorize: mock(async (authUrl: string) => {
        const url = new URL(authUrl);
        authUrlClientId = url.searchParams.get("client_id") ?? undefined;
        return { code: "c", state: url.searchParams.get("state") ?? undefined };
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
          new Response(JSON.stringify({ client_id: "fresh-client" }), { status: 201 }),
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
      serverName: "migrated",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl:
          "https://new-auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    await provider.startAuthFlow();
    expect(registerCalls).toBe(1);
    expect(authUrlClientId).toBe("fresh-client");

    // Persisted record is rewritten with the new issuer binding.
    const stored = await storage.get(computeClientKey("migrated", "https://mcp.example.com"));
    const parsed = JSON.parse(stored ?? "{}");
    expect(parsed.clientId).toBe("fresh-client");
    expect(parsed.issuer).toBe("https://new-auth.example.com");
  });

  test("invalidates persisted DCR client when callbackPort (redirectUri) changes", async () => {
    const storage = createMockStorage();
    const { computeClientKey } = await import("./tokens.js");
    // Persist a client registered against the OLD callback port.
    await storage.set(
      computeClientKey("port-flip", "https://mcp.example.com"),
      JSON.stringify({
        clientId: "stale-port",
        registeredAt: 1,
        issuer: "https://auth.example.com",
        registrationEndpoint: "https://auth.example.com/register",
        redirectUri: "http://127.0.0.1:8912/callback",
      }),
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
        return { code: "c", state: url.searchParams.get("state") ?? undefined };
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
          new Response(JSON.stringify({ client_id: "fresh-port" }), { status: 201 }),
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
      serverName: "port-flip",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        // Operator changed the callback port — stored DCR client was
        // registered against :8912 but the new redirectUri is :9999, so
        // most ASes will reject the next code exchange with
        // invalid_grant. The provider must re-register instead of
        // reusing a stale registration.
        callbackPort: 9999,
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    await provider.startAuthFlow();
    expect(registerCalls).toBe(1);
    expect(authUrlClientId).toBe("fresh-port");

    const stored = await storage.get(computeClientKey("port-flip", "https://mcp.example.com"));
    const parsed = JSON.parse(stored ?? "{}");
    expect(parsed.clientId).toBe("fresh-port");
    expect(parsed.redirectUri).toBe("http://127.0.0.1:9999/callback");
  });

  test("invalidates persisted DCR client only on explicit invalid_client (not transient errors)", async () => {
    // Self-heal a server-side client revocation, but only when the AS
    // explicitly says invalid_client. Other failure modes — 5xx, timeouts,
    // malformed responses, resource-rejected configs — must NOT destroy
    // the persisted registration. Otherwise a transient outage would leak
    // a fresh DCR client on every retry.
    const seedClient = (storage: ReturnType<typeof createMockStorage>): Promise<void> =>
      storage
        .set(
          "mcp-oauth-client|revoked|" + "0".repeat(16), // hash placeholder, real one written by code
          "ignored",
        )
        .then(async () => {
          const { computeClientKey } = await import("./tokens.js");
          const clientKey = computeClientKey("revoked", "https://mcp.example.com");
          await storage.set(
            clientKey,
            JSON.stringify({
              clientId: "live-client",
              registeredAt: 1700000000,
              issuer: "https://auth.example.com",
              registrationEndpoint: "https://auth.example.com/register",
              redirectUri: "http://127.0.0.1:8912/callback",
            }),
          );
        });

    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
    };

    const cases: Array<{
      readonly name: string;
      readonly tokenStatus: number;
      readonly tokenBody: unknown;
      readonly shouldClearClient: boolean;
    }> = [
      {
        name: "invalid_client → invalidate",
        tokenStatus: 401,
        tokenBody: { error: "invalid_client" },
        shouldClearClient: true,
      },
      {
        name: "invalid_grant → preserve",
        tokenStatus: 400,
        tokenBody: { error: "invalid_grant" },
        shouldClearClient: false,
      },
      {
        name: "transient 503 → preserve",
        tokenStatus: 503,
        tokenBody: "upstream down",
        shouldClearClient: false,
      },
    ];

    for (const c of cases) {
      const storage = createMockStorage();
      await seedClient(storage);

      globalThis.fetch = mock((url: string | URL | Request) => {
        const urlStr =
          typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes("well-known")) {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        if (urlStr.includes("/token")) {
          const body = typeof c.tokenBody === "string" ? c.tokenBody : JSON.stringify(c.tokenBody);
          return Promise.resolve(new Response(body, { status: c.tokenStatus }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }) as unknown as typeof fetch;

      const provider = createOAuthAuthProvider({
        serverName: "revoked",
        serverUrl: "https://mcp.example.com",
        oauthConfig: {
          authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
        },
        runtime: createMockRuntime(),
        storage,
      });

      const ok = await provider.startAuthFlow();
      expect(ok, `${c.name}: startAuthFlow result`).toBe(false);

      const { computeClientKey } = await import("./tokens.js");
      const clientKey = computeClientKey("revoked", "https://mcp.example.com");
      const stored = await storage.get(clientKey);
      if (c.shouldClearClient) {
        expect(stored, `${c.name}: client should be cleared`).toBeUndefined();
      } else {
        expect(stored, `${c.name}: client should be preserved`).toBeDefined();
      }
    }
  });

  test("preserves configured (non-DCR) clientId on token exchange failure", async () => {
    // The persisted-client invalidation only fires for
    // dynamically-registered clients (registeredAt > 0). A statically
    // configured clientId is operator-managed; we must not silently
    // mutate storage on its behalf.
    const storage = createMockStorage();
    const { computeClientKey } = await import("./tokens.js");
    const clientKey = computeClientKey("static", "https://mcp.example.com");

    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    };

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      if (urlStr.includes("/token")) {
        return Promise.resolve(new Response("nope", { status: 400 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "static",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        clientId: "configured",
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime: createMockRuntime(),
      storage,
    });

    const ok = await provider.startAuthFlow();
    expect(ok).toBe(false);
    // We never persisted anything for the static path — and we must
    // not have attempted a delete that could surface as a side effect.
    expect(await storage.get(clientKey)).toBeUndefined();
  });

  test("token() is side-effect free — does NOT trigger DCR when no tokens are stored", async () => {
    // A passive `token()` probe (transport checking whether we have
    // auth) must never create a server-side OAuth client. Reconnect
    // retries and background health checks would otherwise leak fresh
    // DCR registrations on every loop — and client-info is kept across
    // `logout`, so those orphans accumulate.
    const storage = createMockStorage();
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
    };

    let registerCalls = 0;
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
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "probe",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime: createMockRuntime(),
      storage,
    });

    const result = await provider.token();
    expect(result).toBeUndefined();
    expect(registerCalls).toBe(0);
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
