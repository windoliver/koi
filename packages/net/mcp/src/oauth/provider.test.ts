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
          new Response(
            JSON.stringify({ client_id: "dyn-123", token_endpoint_auth_method: "none" }),
            { status: 201 },
          ),
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
    const storedClient = await storage.get(
      computeClientKey(
        "dyn",
        "https://mcp.example.com",
        "http://127.0.0.1:8912/callback",
        "https://auth.example.com",
      ),
    );
    expect(storedClient).toBeDefined();
    const parsed = JSON.parse(storedClient ?? "{}");
    expect(parsed.clientId).toBe("dyn-123");
  });

  test("reuses persisted dynamically-registered client on subsequent flows", async () => {
    const storage = createMockStorage();
    const { computeClientKey } = await import("./tokens.js");
    await storage.set(
      computeClientKey(
        "reuse",
        "https://mcp.example.com",
        "http://127.0.0.1:8912/callback",
        "https://auth.example.com",
      ),
      JSON.stringify({
        clientId: "prev-reg",
        registeredAt: 1,
        issuer: "https://auth.example.com",
        registrationEndpoint: "https://auth.example.com/register",
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
          new Response(
            JSON.stringify({ client_id: "should-not-run", token_endpoint_auth_method: "none" }),
            { status: 201 },
          ),
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
          new Response(
            JSON.stringify({ client_id: assigned, token_endpoint_auth_method: "none" }),
            { status: 201 },
          ),
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
    const stored = map.get(
      computeClientKey(
        "race",
        "https://mcp.example.com",
        "http://127.0.0.1:8912/callback",
        "https://auth.example.com",
      ),
    );
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
    // The migration test deliberately seeds against the OLD authority
    // so the new discovered issuer triggers a re-register. Both keys
    // (old + new) end up in storage during the test.
    await storage.set(
      computeClientKey(
        "migrated",
        "https://mcp.example.com",
        "http://127.0.0.1:8912/callback",
        "https://old-auth.example.com",
      ),
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
          new Response(
            JSON.stringify({ client_id: "fresh-client", token_endpoint_auth_method: "none" }),
            { status: 201 },
          ),
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
    // Provider re-registered against the NEW authority — that's a new
    // key. The old-authority record stays put (graveyard) because each
    // authority gets its own scope; nothing prunes it. Validate the
    // fresh registration under the new authority key.
    const stored = await storage.get(
      computeClientKey(
        "migrated",
        "https://mcp.example.com",
        "http://127.0.0.1:8912/callback",
        "https://new-auth.example.com",
      ),
    );
    const parsed = JSON.parse(stored ?? "{}");
    expect(parsed.clientId).toBe("fresh-client");
    expect(parsed.issuer).toBe("https://new-auth.example.com");
  });

  test("same-URL configs with different callback ports get independent DCR records", async () => {
    // The client-info key is scoped to (serverUrl, redirectUri) so
    // running one config on :8912 and another on :9999 does NOT fight
    // over a single shared record — each port gets its own registration
    // that honors the AS's exact-match redirect_uri contract. A stored
    // record for port 8912 is invisible to a provider on port 9999.
    const storage = createMockStorage();
    const { computeClientKey } = await import("./tokens.js");
    // Persist a record under the :8912 key. Should remain untouched.
    await storage.set(
      computeClientKey(
        "port-8912",
        "https://mcp.example.com",
        "http://127.0.0.1:8912/callback",
        "https://auth.example.com",
      ),
      JSON.stringify({
        clientId: "port-8912-client",
        registeredAt: 1,
        issuer: "https://auth.example.com",
        registrationEndpoint: "https://auth.example.com/register",
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
          new Response(
            JSON.stringify({ client_id: "fresh-port", token_endpoint_auth_method: "none" }),
            { status: 201 },
          ),
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
      serverName: "port-9999",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        callbackPort: 9999,
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    await provider.startAuthFlow();
    // Provider on port 9999 ran its own DCR — its key is distinct from
    // the pre-seeded :8912 record.
    expect(registerCalls).toBe(1);
    expect(authUrlClientId).toBe("fresh-port");

    const port9999Stored = await storage.get(
      computeClientKey(
        "port-9999",
        "https://mcp.example.com",
        "http://127.0.0.1:9999/callback",
        "https://auth.example.com",
      ),
    );
    const port9999Parsed = JSON.parse(port9999Stored ?? "{}");
    expect(port9999Parsed.clientId).toBe("fresh-port");

    // Critical: the pre-seeded :8912 record is UNTOUCHED. Earlier
    // shared-key logic would have overwritten it.
    const port8912Stored = await storage.get(
      computeClientKey(
        "port-8912",
        "https://mcp.example.com",
        "http://127.0.0.1:8912/callback",
        "https://auth.example.com",
      ),
    );
    const port8912Parsed = JSON.parse(port8912Stored ?? "{}");
    expect(port8912Parsed.clientId).toBe("port-8912-client");
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
          const clientKey = computeClientKey(
            "revoked",
            "https://mcp.example.com",
            "http://127.0.0.1:8912/callback",
            "https://auth.example.com",
          );
          await storage.set(
            clientKey,
            JSON.stringify({
              clientId: "live-client",
              registeredAt: 1700000000,
              issuer: "https://auth.example.com",
              registrationEndpoint: "https://auth.example.com/register",
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
      const clientKey = computeClientKey(
        "revoked",
        "https://mcp.example.com",
        "http://127.0.0.1:8912/callback",
        "https://auth.example.com",
      );
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
    const clientKey = computeClientKey(
      "static",
      "https://mcp.example.com",
      "http://127.0.0.1:8912/callback",
      "https://auth.example.com",
    );

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
          new Response(
            JSON.stringify({ client_id: "should-not-run", token_endpoint_auth_method: "none" }),
            { status: 201 },
          ),
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

  test("two providers sharing one URL converge after one re-registers", async () => {
    // computeClientKey is name-independent — two aliases at the same
    // URL share one persisted DCR record. If provider A invalidates and
    // re-registers, provider B's NEXT getClient must read the repaired
    // record from storage instead of returning a stale in-memory copy
    // — otherwise B keeps building auth requests with the dead client_id.
    const storage = createMockStorage();
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
    };

    let registerCounter = 0;
    let nextRegisterId = "first";
    let exchangeShouldFail = false;
    const seenAuthClientIds: string[] = [];

    const runtime: OAuthRuntime = {
      authorize: mock(async (authUrl: string) => {
        const url = new URL(authUrl);
        const cid = url.searchParams.get("client_id") ?? "";
        seenAuthClientIds.push(cid);
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
        registerCounter += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({ client_id: nextRegisterId, token_endpoint_auth_method: "none" }),
            { status: 201 },
          ),
        );
      }
      if (urlStr.includes("/token")) {
        if (exchangeShouldFail) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const make = (alias: string): ReturnType<typeof createOAuthAuthProvider> =>
      createOAuthAuthProvider({
        serverName: alias,
        serverUrl: "https://mcp.example.com",
        oauthConfig: {
          authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
        },
        runtime,
        storage,
      });

    const a = make("alias-a");
    const b = make("alias-b");

    // 1) Both providers warm up against the SAME shared client.
    nextRegisterId = "first";
    await a.startAuthFlow();
    await b.startAuthFlow();
    expect(registerCounter).toBe(1); // shared registration
    expect(seenAuthClientIds).toEqual(["first", "first"]);

    // 2) Provider A's exchange fails with invalid_client → A drops the
    //    shared record from storage. The same startAuthFlow returns
    //    false but does not re-register (the user has to retry).
    exchangeShouldFail = true;
    await a.startAuthFlow();
    expect(registerCounter).toBe(1);

    // 3) A retries (now succeeding); the re-register emits a NEW
    //    client_id, persisted under the same shared key.
    exchangeShouldFail = false;
    nextRegisterId = "second";
    await a.startAuthFlow();
    expect(registerCounter).toBe(2);

    // 4) Provider B's next getClient MUST pick up the repaired record
    //    from storage, not return its stale in-memory cache pointing
    //    at "first" — that was the bug.
    seenAuthClientIds.length = 0;
    await b.startAuthFlow();
    expect(seenAuthClientIds).toEqual(["second"]);
  });

  test("reuses persisted DCR client when discovery stops advertising registration_endpoint", async () => {
    // An AS that disables DCR after we already have a client_id, or
    // whose discovery temporarily drops registration_endpoint, must NOT
    // brick our existing registration. The stored client_id is still
    // valid at the authorize/token endpoints — registration_endpoint
    // is only needed when we'd register a NEW client.
    const storage = createMockStorage();
    const { computeClientKey } = await import("./tokens.js");
    await storage.set(
      computeClientKey(
        "no-more-dcr",
        "https://mcp.example.com",
        "http://127.0.0.1:8912/callback",
        "https://auth.example.com",
      ),
      JSON.stringify({
        clientId: "still-valid",
        registeredAt: 1700000000,
        issuer: "https://auth.example.com",
        registrationEndpoint: "https://auth.example.com/register",
      }),
    );

    // Discovery now omits registration_endpoint.
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
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
          new Response(
            JSON.stringify({ client_id: "wont-happen", token_endpoint_auth_method: "none" }),
            { status: 201 },
          ),
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
      serverName: "no-more-dcr",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    await provider.startAuthFlow();
    expect(registerCalls).toBe(0);
    expect(authUrlClientId).toBe("still-valid");
  });

  test("invalidates legacy DCR records that lack issuer/registration_endpoint binding", async () => {
    // An installation upgraded from the earlier DCR shape (no issuer
    // binding) must NOT keep reusing that unbound client_id forever —
    // discovery may now point at a different AS, in which case the
    // stale id would silently fail every auth/refresh until the
    // operator manually wiped secure storage. Treat unbound DCR
    // records as stale so the next attempt re-registers cleanly.
    const storage = createMockStorage();
    const { computeClientKey } = await import("./tokens.js");
    await storage.set(
      computeClientKey(
        "legacy",
        "https://mcp.example.com",
        "http://127.0.0.1:8912/callback",
        "https://auth.example.com",
      ),
      JSON.stringify({
        clientId: "legacy-unbound",
        registeredAt: 1700000000, // DCR-registered, not static (registeredAt > 0)
        // no issuer, no registrationEndpoint — the legacy shape
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
          new Response(
            JSON.stringify({ client_id: "fresh-bound", token_endpoint_auth_method: "none" }),
            { status: 201 },
          ),
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
      serverName: "legacy",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    await provider.startAuthFlow();
    expect(registerCalls).toBe(1);
    expect(authUrlClientId).toBe("fresh-bound");
  });

  test("returns false (does NOT throw) when registration_endpoint is non-HTTPS", async () => {
    // registerDynamicClient throws on http:// to refuse credentials over
    // cleartext. The provider must convert that into a fail-closed
    // undefined so `koi mcp auth` reports a clean failure rather than
    // surfacing an exception through the CLI.
    const storage = createMockStorage();
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "http://auth.example.com/register", // INSECURE
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 })),
    ) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "insecure-dcr",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime: createMockRuntime(),
      storage,
    });

    // Must NOT throw — fail closed with false instead.
    await expect(provider.startAuthFlow()).resolves.toBe(false);
  });

  test("promotes legacy authority-less DCR record to authority-scoped key on first lookup", async () => {
    // Upgrade migration: a previous build persisted DCR records under
    // the no-authority key shape. The new authority-scoped lookup must
    // probe the legacy key, validate freshness against current
    // metadata, and promote the record so the operator does not get
    // re-registered (orphaning the prior client server-side).
    const storage = createMockStorage();
    const { computeClientKey } = await import("./tokens.js");

    // Seed legacy key (authority="") with a still-fresh record.
    const legacyKey = computeClientKey(
      "upgrade",
      "https://mcp.example.com",
      "http://127.0.0.1:8912/callback",
      "",
    );
    await storage.set(
      legacyKey,
      JSON.stringify({
        clientId: "legacy-but-good",
        registeredAt: 1700000000,
        issuer: "https://auth.example.com",
        registrationEndpoint: "https://auth.example.com/register",
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
          new Response(
            JSON.stringify({ client_id: "should-not-run", token_endpoint_auth_method: "none" }),
            { status: 201 },
          ),
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
      serverName: "upgrade",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    await provider.startAuthFlow();
    expect(registerCalls).toBe(0);
    expect(authUrlClientId).toBe("legacy-but-good");

    // Record promoted to new authority-scoped key, legacy key removed.
    const newKey = computeClientKey(
      "upgrade",
      "https://mcp.example.com",
      "http://127.0.0.1:8912/callback",
      "https://auth.example.com",
    );
    expect(await storage.get(newKey)).toBeDefined();
    expect(await storage.get(legacyKey)).toBeUndefined();
  });

  test("emits structured failure reasons via OAuthRuntime.onAuthFailure", async () => {
    // Operators need actionable diagnostics, not a generic boolean false.
    // Each fail-closed path must report a discriminant so hosts can
    // surface the actual breakage mode.
    const failures: Array<{ kind: string }> = [];
    const onAuthFailure = mock((reason: { kind: string }) => {
      failures.push(reason);
    });

    // Discovery returns 404 → discovery_failed.
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "obs",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {},
      runtime: {
        authorize: mock(async () => ({ code: "c", state: "s" })),
        onReauthNeeded: mock(async () => {}),
        onAuthFailure,
      },
      storage: createMockStorage(),
    });

    await provider.startAuthFlow();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.map((f) => f.kind)).toContain("discovery_failed");
  });

  test("handleUnauthorized clears tokens + prompts re-auth on terminal DCR failure", async () => {
    // Recovery story: 401 mid-session → handleUnauthorized refreshes
    // → DCR resolution returns terminal (insecure registration_endpoint,
    // confidential client, narrowed redirect_uris). Without terminal
    // propagation, tokens.ts would treat that as transient and
    // preserve dead state forever, leaving the connection in a
    // permanent auth-needed loop without ever telling the host to
    // re-auth. With this fix, terminal clears tokens so
    // onReauthNeeded fires.
    const storage = createMockStorage();
    const runtime: OAuthRuntime = {
      authorize: mock(async () => ({ code: "c", state: "s" })),
      onReauthNeeded: mock(async () => {}),
    };

    // DCR returns a confidential registration → terminal.
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
    };

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      if (urlStr.endsWith("/register")) {
        // Confidential registration — terminal failure.
        return Promise.resolve(
          new Response(JSON.stringify({ client_id: "confidential", client_secret: "shh" }), {
            status: 201,
          }),
        );
      }
      // Refresh path — should never be reached because client resolves terminal.
      return Promise.resolve(new Response("nope", { status: 400 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "terminal-dcr",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    // Pre-store expired tokens with a refresh token. The session looks
    // recoverable from secure storage but DCR cannot succeed.
    const { computeServerKey } = await import("./tokens.js");
    await storage.set(
      computeServerKey("terminal-dcr", "https://mcp.example.com"),
      JSON.stringify({
        accessToken: "expired",
        refreshToken: "rt",
        expiresAt: Date.now() - 1000,
      }),
    );

    await provider.handleUnauthorized();

    // Tokens MUST be cleared (dead session, no recovery path).
    expect(
      await storage.get(computeServerKey("terminal-dcr", "https://mcp.example.com")),
    ).toBeUndefined();
    // Host MUST be prompted to re-auth.
    expect(runtime.onReauthNeeded).toHaveBeenCalledWith("terminal-dcr");
  });

  test("preserves DCR-backed tokens when discovery is transiently unavailable", async () => {
    // Process restart with discovery briefly down: getMetadata returns
    // undefined, getClient cannot validate the persisted DCR record,
    // getClientId now reports `transient` (NOT terminal). Refresh
    // path must preserve the refresh token so the next attempt — once
    // discovery is back — can recover.
    const storage = createMockStorage();
    const { computeServerKey } = await import("./tokens.js");
    await storage.set(
      computeServerKey("flaky-discovery", "https://mcp.example.com"),
      JSON.stringify({
        accessToken: "expired",
        refreshToken: "rt-precious",
        expiresAt: Date.now() - 1000,
      }),
    );

    // Discovery returns 404 → metadata = undefined.
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "flaky-discovery",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {},
      runtime: createMockRuntime(),
      storage,
    });

    // Token call sees expired tokens, attempts refresh, hits transient
    // discovery failure → returns undefined WITHOUT clearing storage.
    const result = await provider.token();
    expect(result).toBeUndefined();
    // The refresh token MUST still be there for the next attempt.
    const stored = await storage.get(
      computeServerKey("flaky-discovery", "https://mcp.example.com"),
    );
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored ?? "{}");
    expect(parsed.refreshToken).toBe("rt-precious");
  });

  test("refresh recovers after discovery comes back online (no manager rebuild)", async () => {
    // Critical regression: if a provider was first invoked while
    // discovery was down, the cached TokenManager used to capture
    // metadata=undefined and then skip every refresh forever — even
    // after discovery recovered. The fix passes a lazy getMetadata()
    // resolver to TokenManager so each refresh re-discovers.
    const storage = createMockStorage();
    const { computeServerKey } = await import("./tokens.js");
    await storage.set(
      computeServerKey("recovers", "https://mcp.example.com"),
      JSON.stringify({
        accessToken: "expired",
        refreshToken: "rt",
        expiresAt: Date.now() - 1000,
      }),
    );

    const goodMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    };

    let discoveryUp = false;
    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        return Promise.resolve(
          discoveryUp
            ? new Response(JSON.stringify(goodMetadata), { status: 200 })
            : new Response(null, { status: 503 }),
        );
      }
      if (urlStr.includes("/token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "fresh" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "recovers",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        clientId: "static",
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime: createMockRuntime(),
      storage,
    });

    // 1) Discovery is down at first call → token() returns undefined
    //    transient, but does NOT clear the refresh token.
    expect(await provider.token()).toBeUndefined();
    const stored = await storage.get(computeServerKey("recovers", "https://mcp.example.com"));
    expect(stored).toBeDefined();

    // 2) Discovery recovers. The SAME provider instance must now
    //    succeed on refresh — without rebuilding the manager.
    discoveryUp = true;
    expect(await provider.token()).toBe("fresh");
  });

  test("does NOT retry exchange on generic invalid_request (would consume single-use code)", async () => {
    // RFC 8707 §2 ties resource rejection specifically to `invalid_target`.
    // `invalid_request` is the OAuth catch-all — PKCE mismatch, malformed
    // redirect, duplicated params. Replaying the auth code on
    // invalid_request would consume the single-use code and mask the
    // real error.
    const storage = createMockStorage();
    let exchangeCalls = 0;
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
        exchangeCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "single-use-guard",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        clientId: "static",
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime: createMockRuntime(),
      storage,
    });

    const ok = await provider.startAuthFlow();
    expect(ok).toBe(false);
    // Critical: must NOT replay the auth code.
    expect(exchangeCalls).toBe(1);
  });

  test("retries authorization without resource when authorize() throws (legacy AS rejects at auth endpoint)", async () => {
    // Some legacy ASes reject the unknown `resource` query parameter
    // at the authorization endpoint itself, before the redirect ever
    // happens. The host's runtime.authorize then rejects with a
    // browser error. The provider must retry once without `resource`
    // to give the same login a chance to succeed.
    const storage = createMockStorage();
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    };

    const seenAuthUrls: string[] = [];
    const runtime: OAuthRuntime = {
      authorize: mock(async (authUrl: string) => {
        seenAuthUrls.push(authUrl);
        const url = new URL(authUrl);
        if (url.searchParams.has("resource")) {
          throw new Error("authorization endpoint rejected resource");
        }
        return { code: "c", state: url.searchParams.get("state") ?? undefined };
      }),
      onReauthNeeded: mock(async () => {}),
    };

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      if (urlStr.includes("/token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "auth-endpoint-rejects",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        clientId: "static",
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime,
      storage,
    });

    const ok = await provider.startAuthFlow();
    expect(ok).toBe(true);
    expect(seenAuthUrls.length).toBe(2);
    expect(new URL(seenAuthUrls[0] ?? "").searchParams.has("resource")).toBe(true);
    expect(new URL(seenAuthUrls[1] ?? "").searchParams.has("resource")).toBe(false);
  });

  test("re-discovers metadata before declaring DCR terminally unavailable", async () => {
    // First discovery call returns valid metadata WITHOUT
    // registration_endpoint (degraded rollout / partial outage).
    // Without re-discovery, the cached snapshot would force every
    // subsequent refresh into terminal classification and brick
    // the session for the lifetime of the provider. The fix forces
    // a fresh discovery before returning terminal so the AS gets a
    // chance to recover in-process.
    const storage = createMockStorage();
    const { computeServerKey } = await import("./tokens.js");
    await storage.set(
      computeServerKey("recovers", "https://mcp.example.com"),
      JSON.stringify({
        accessToken: "expired",
        refreshToken: "rt",
        expiresAt: Date.now() - 1000,
      }),
    );

    let discoveryCalls = 0;
    let endpointPresent = false;
    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        discoveryCalls += 1;
        // First call: degraded — registration_endpoint missing.
        // Second call (forced by re-discovery on terminal path):
        // recovered.
        const md: Record<string, string> = {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        };
        if (endpointPresent) {
          md.registration_endpoint = "https://auth.example.com/register";
        }
        endpointPresent = true; // recovered for next call
        return Promise.resolve(new Response(JSON.stringify(md), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "recovers",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime: createMockRuntime(),
      storage,
    });

    // token() triggers refresh → DCR resolution → re-discovery before
    // terminal. Re-discovery returns the recovered metadata, so the
    // resolver returns transient instead of terminal. Tokens preserved.
    expect(await provider.token()).toBeUndefined();
    // Both discovery calls fired (initial + forced refresh).
    expect(discoveryCalls).toBeGreaterThanOrEqual(2);
    // Tokens MUST still be there — the recovery path saved them.
    expect(
      await storage.get(computeServerKey("recovers", "https://mcp.example.com")),
    ).toBeDefined();
  });

  test("retries exchange without resource on invalid_target (legacy-AS compatibility)", async () => {
    // Mirror of the refresh-path RFC 8707 shim. A legacy AS that
    // rejects `resource` with invalid_target on initial auth should
    // not hard-fail every login — the provider retries the code
    // exchange once without `resource`, just like refresh does.
    const storage = createMockStorage();
    let exchangeCalls = 0;
    let secondExchangeHadResource: boolean | undefined;
    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    };

    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("well-known")) {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      if (urlStr.includes("/token")) {
        exchangeCalls += 1;
        const body = new URLSearchParams((init?.body as string) ?? "");
        if (exchangeCalls === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "invalid_target" }), { status: 400 }),
          );
        }
        secondExchangeHadResource = body.has("resource");
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "legacy-fresh-auth",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        clientId: "static",
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime: createMockRuntime(),
      storage,
    });

    const ok = await provider.startAuthFlow();
    expect(ok).toBe(true);
    expect(exchangeCalls).toBe(2);
    expect(secondExchangeHadResource).toBe(false);
  });

  test("startAuthFlow returns false (does NOT throw) on browser/callback failures", async () => {
    // runtime.authorize is host-implemented and can fail for many
    // reasons unrelated to OAuth: browser launch error, callback
    // timeout, user-cancelled auth, listener bind error.
    // startAuthFlow's contract is Promise<boolean> — it must fail
    // closed, not propagate the exception out to the CLI.
    const storage = createMockStorage();
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
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const failures: Array<{ kind: string }> = [];
    const provider = createOAuthAuthProvider({
      serverName: "browser-fail",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        clientId: "static",
        // Disable resource so retry shim doesn't run.
        includeResourceParameter: false,
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime: {
        authorize: mock(async () => {
          throw new Error("browser launch failed");
        }),
        onReauthNeeded: mock(async () => {}),
        onAuthFailure: (r) => {
          failures.push(r);
        },
      },
      storage,
    });

    // Must NOT throw — clean false return.
    await expect(provider.startAuthFlow()).resolves.toBe(false);
    // Browser/callback failures are reported as `authorize_failed`,
    // distinct from `discovery_failed`. Hosts route remediation
    // differently for each.
    expect(failures.map((f) => f.kind)).toContain("authorize_failed");
  });

  test("preserves persisted DCR client on local authorize failure (browser crash, timeout, cancel)", async () => {
    // runtime.authorize() rejecting does NOT prove the persisted
    // DCR client_id is stale — it covers purely local failures (browser
    // launch error, callback listener bind, timeout, user cancel).
    // Auto-deleting the DCR record on every such failure would leak
    // orphaned registrations on every browser hiccup and burn DCR
    // rate-limit budget. A genuinely revoked client_id surfaces later
    // as `invalid_client` at the token endpoint — handled there.
    const storage = createMockStorage();
    const { computeClientKey } = await import("./tokens.js");
    const clientKey = computeClientKey(
      "browser-cancel",
      "https://mcp.example.com",
      "http://127.0.0.1:8912/callback",
      "https://auth.example.com",
    );
    const record = JSON.stringify({
      clientId: "still-healthy",
      registeredAt: 1700000000,
      issuer: "https://auth.example.com",
      registrationEndpoint: "https://auth.example.com/register",
    });
    await storage.set(clientKey, record);

    const metadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 })),
    ) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "browser-cancel",
      serverUrl: "https://mcp.example.com",
      oauthConfig: {
        includeResourceParameter: false,
        authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
      },
      runtime: {
        authorize: mock(async () => {
          throw new Error("user closed browser");
        }),
        onReauthNeeded: mock(async () => {}),
      },
      storage,
    });

    const ok = await provider.startAuthFlow();
    expect(ok).toBe(false);
    // DCR record MUST be preserved — next attempt can reuse it.
    expect(await storage.get(clientKey)).toBe(record);
  });

  test("handleUnauthorized clears corrupt token storage and prompts re-auth", async () => {
    // hasTokens() returns true on raw key existence, but parse may
    // fail. Without clearing the corrupt blob, handleUnauthorized
    // would see hasTokens=true and skip onReauthNeeded forever,
    // trapping the operator in a sticky failure that no longer
    // self-recovers.
    const storage = createMockStorage();
    const runtime = createMockRuntime();
    const { computeServerKey } = await import("./tokens.js");
    const key = computeServerKey("corrupt", "https://mcp.example.com");
    await storage.set(key, "{not json{");

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as unknown as typeof fetch;

    const provider = createOAuthAuthProvider({
      serverName: "corrupt",
      serverUrl: "https://mcp.example.com",
      oauthConfig: { clientId: "static" },
      runtime,
      storage,
    });

    await provider.handleUnauthorized();

    expect(await storage.get(key)).toBeUndefined();
    expect(runtime.onReauthNeeded).toHaveBeenCalledWith("corrupt");
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
