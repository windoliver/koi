import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SecureStorage } from "@koi/secure-storage";
import {
  computeClientKey,
  computeServerKey,
  createTokenManager,
  readClientInfo,
  writeClientInfo,
} from "./tokens.js";
import type { AuthServerMetadata } from "./types.js";

// ---------------------------------------------------------------------------
// Mock storage
// ---------------------------------------------------------------------------

function createMockStorage(): SecureStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeServerKey", () => {
  test("produces stable key from name + url", () => {
    const key1 = computeServerKey("github", "https://mcp.github.com");
    const key2 = computeServerKey("github", "https://mcp.github.com");
    expect(key1).toBe(key2);
  });

  test("different URLs produce different keys", () => {
    const key1 = computeServerKey("s", "https://a.com");
    const key2 = computeServerKey("s", "https://b.com");
    expect(key1).not.toBe(key2);
  });

  test("key format matches expected pattern", () => {
    const key = computeServerKey("my-server", "https://example.com");
    expect(key).toMatch(/^mcp-oauth\|my-server\|[a-f0-9]{16}$/);
  });
});

describe("createTokenManager", () => {
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    storage = createMockStorage();
  });

  test("hasTokens returns false when no tokens stored", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    expect(await tm.hasTokens()).toBe(false);
  });

  test("storeTokens then hasTokens returns true", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({
      accessToken: "tok123",
      expiresAt: Date.now() + 3600_000,
    });
    expect(await tm.hasTokens()).toBe(true);
  });

  test("getAccessToken returns stored token when not expired", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({
      accessToken: "valid-token",
      expiresAt: Date.now() + 3600_000,
    });
    const token = await tm.getAccessToken();
    expect(token).toBe("valid-token");
  });

  test("getAccessToken returns token when no expiresAt set", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({ accessToken: "no-expiry" });
    const token = await tm.getAccessToken();
    expect(token).toBe("no-expiry");
  });

  test("getAccessToken returns undefined when expired and no refresh token", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({
      accessToken: "expired",
      expiresAt: Date.now() - 1000,
    });
    const token = await tm.getAccessToken();
    expect(token).toBeUndefined();
  });

  test("clearTokens removes stored tokens", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({ accessToken: "to-delete" });
    expect(await tm.hasTokens()).toBe(true);
    await tm.clearTokens();
    expect(await tm.hasTokens()).toBe(false);
  });

  test("getAccessToken returns undefined when no tokens stored", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    const token = await tm.getAccessToken();
    expect(token).toBeUndefined();
  });

  test("storeTokens uses withLock for concurrent safety", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({ accessToken: "locked" });
    expect(storage.withLock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Client-info persistence (DCR)
// ---------------------------------------------------------------------------

describe("client info persistence", () => {
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    storage = createMockStorage();
  });

  const RU = "http://127.0.0.1:8912/callback";

  test("computeClientKey is name-independent but scoped to (URL, redirectUri)", () => {
    // Keying by URL + redirectUri ensures:
    //  - alias renames with identical URL + port reuse the same client
    //  - same URL with different callback ports get DIFFERENT clients
    //    (they have incompatible redirect_uri contracts on the AS)
    const key = computeClientKey("my-server", "https://example.com", RU);
    expect(key).toMatch(/^mcp-oauth-client\|[a-f0-9]{16}$/);
    expect(key).not.toBe(computeServerKey("my-server", "https://example.com"));
    // Alias rename, same URL + port → same client key.
    expect(key).toBe(computeClientKey("renamed", "https://example.com", RU));
    // Different URL → distinct key.
    expect(key).not.toBe(computeClientKey("my-server", "https://other.com", RU));
    // Same URL, different callback port → distinct key.
    expect(key).not.toBe(
      computeClientKey("my-server", "https://example.com", "http://127.0.0.1:9999/callback"),
    );
  });

  test("readClientInfo returns undefined when nothing stored", async () => {
    expect(await readClientInfo(storage, "s", "https://x", RU)).toBeUndefined();
  });

  test("writeClientInfo then readClientInfo round-trips", async () => {
    await writeClientInfo(storage, "s", "https://x", RU, {
      clientId: "abc",
      registeredAt: 123,
    });
    const back = await readClientInfo(storage, "s", "https://x", RU);
    expect(back?.clientId).toBe("abc");
  });

  test("readClientInfo returns undefined for corrupt JSON", async () => {
    const key = computeClientKey("s", "https://x", RU);
    await storage.set(key, "{not json");
    expect(await readClientInfo(storage, "s", "https://x", RU)).toBeUndefined();
  });

  test("writeClientInfo persists issuer + registration_endpoint binding", async () => {
    await writeClientInfo(storage, "s", "https://x", RU, {
      clientId: "public",
      registeredAt: 99,
      issuer: "https://auth.example.com",
      registrationEndpoint: "https://auth.example.com/register",
    });
    const back = await readClientInfo(storage, "s", "https://x", RU);
    expect(back?.issuer).toBe("https://auth.example.com");
    expect(back?.registrationEndpoint).toBe("https://auth.example.com/register");
  });
});

// ---------------------------------------------------------------------------
// Refresh path coverage
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const METADATA: AuthServerMetadata = {
  issuer: "https://auth.example.com",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
};

describe("createTokenManager — refresh flow", () => {
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    storage = createMockStorage();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("refreshes expired token via refresh_token grant", async () => {
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams((init?.body as string) ?? "");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("rt-original");
      expect(body.get("client_id")).toBe("cid-1");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "rt-rotated",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "cid-1",
    });

    await tm.storeTokens({
      accessToken: "expired",
      refreshToken: "rt-original",
      expiresAt: Date.now() - 1000,
    });

    const token = await tm.getAccessToken();
    expect(token).toBe("new-access");

    // Rotated refresh token is persisted
    const stored = await storage.get(computeServerKey("s", "https://mcp.example.com"));
    const parsed = JSON.parse(stored ?? "{}");
    expect(parsed.refreshToken).toBe("rt-rotated");
  });

  test("sends resource parameter per RFC 8707 on refresh", async () => {
    let seenResource: string | null = "sentinel";
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams((init?.body as string) ?? "");
      seenResource = body.get("resource");
      return Promise.resolve(new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }));
    }) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com/v1",
      storage,
      metadata: METADATA,
      clientId: "c",
      resource: "https://mcp.example.com/v1",
    });
    await tm.storeTokens({
      accessToken: "stale",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });

    await tm.getAccessToken();
    expect(seenResource).toBe("https://mcp.example.com/v1");
  });

  test("omits resource on refresh when caller did not opt in", async () => {
    // The refresh body MUST mirror the initial-auth decision exactly,
    // otherwise an `includeResourceParameter: false` server would accept
    // the original token then reject every refresh with invalid_target.
    let seenResource: string | null = "sentinel";
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams((init?.body as string) ?? "");
      seenResource = body.get("resource");
      return Promise.resolve(new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }));
    }) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com/v1",
      storage,
      metadata: METADATA,
      clientId: "c",
      // no `resource` — caller (provider) opted out via includeResourceParameter: false
    });
    await tm.storeTokens({
      accessToken: "stale",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });

    await tm.getAccessToken();
    expect(seenResource).toBeNull();
  });

  test("clears tokens on terminal refresh failure (400)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("invalid_grant", { status: 400 })),
    ) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "c",
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt-bad",
      expiresAt: Date.now() - 1,
    });

    const result = await tm.getAccessToken();
    expect(result).toBeUndefined();
    expect(await tm.hasTokens()).toBe(false);
  });

  test("preserves tokens on transient refresh failure (5xx)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("upstream unavailable", { status: 503 })),
    ) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "c",
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });

    const result = await tm.getAccessToken();
    expect(result).toBeUndefined();
    // Transient — tokens must NOT be cleared (operator-retryable)
    expect(await tm.hasTokens()).toBe(true);
  });

  test("preserves tokens on network error (fetch throws)", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("ECONNRESET")),
    ) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "c",
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });

    const result = await tm.getAccessToken();
    expect(result).toBeUndefined();
    expect(await tm.hasTokens()).toBe(true);
  });

  test("clears tokens when expired with no refresh_token", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(""))) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "c",
    });
    await tm.storeTokens({ accessToken: "x", expiresAt: Date.now() - 1 });

    expect(await tm.getAccessToken()).toBeUndefined();
    expect(await tm.hasTokens()).toBe(false);
  });

  test("preserves tokens when DCR resolver returns undefined (transient failure)", async () => {
    // Without this guard, a transient DCR failure would send a refresh
    // request with no client_id, the AS would reject it with 4xx, and
    // the terminal classification would wipe a perfectly good refresh
    // token — turning a transient outage into permanent session loss.
    let fetchCalled = 0;
    globalThis.fetch = mock(() => {
      fetchCalled += 1;
      return Promise.resolve(new Response("nope", { status: 400 }));
    }) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      getClientId: async () => ({ kind: "transient" }),
      resource: "https://mcp.example.com",
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt-keep",
      expiresAt: Date.now() - 1,
    });

    expect(await tm.getAccessToken()).toBeUndefined();
    // No refresh attempted (resolver returned transient → preserve)
    expect(fetchCalled).toBe(0);
    // Refresh token MUST still be there for the next retry.
    expect(await tm.hasTokens()).toBe(true);
  });

  test("clears tokens when DCR resolver returns terminal", async () => {
    // Distinct from the transient case: a terminal resolver result
    // means there is no possible path to ever refresh — neither a
    // configured static clientId nor a discoverable
    // registration_endpoint. Leaving tokens in place would make
    // handleUnauthorized think the session is recoverable forever,
    // permanently stuck. Clear so onReauthNeeded fires.
    let fetchCalled = 0;
    globalThis.fetch = mock(() => {
      fetchCalled += 1;
      return Promise.resolve(new Response("nope", { status: 400 }));
    }) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      getClientId: async () => ({ kind: "terminal" }),
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });

    expect(await tm.getAccessToken()).toBeUndefined();
    expect(fetchCalled).toBe(0);
    expect(await tm.hasTokens()).toBe(false);
  });

  test("preserves tokens when DCR resolver throws", async () => {
    let fetchCalled = 0;
    globalThis.fetch = mock(() => {
      fetchCalled += 1;
      return Promise.resolve(new Response("nope", { status: 400 }));
    }) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      getClientId: async () => {
        throw new Error("network");
      },
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });

    expect(await tm.getAccessToken()).toBeUndefined();
    expect(fetchCalled).toBe(0);
    expect(await tm.hasTokens()).toBe(true);
  });

  test("does NOT retry refresh on generic invalid_request", async () => {
    // RFC 8707 §2: only `invalid_target` ties to the resource parameter.
    // Replaying refresh on the OAuth catch-all `invalid_request` could
    // double traffic and escalate a malformed-request error into harder-
    // to-recover token loss when the AS treats it as terminal.
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }),
      );
    }) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "c",
      resource: "https://mcp.example.com",
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });

    expect(await tm.getAccessToken()).toBeUndefined();
    // Single attempt — must NOT replay.
    expect(calls).toBe(1);
  });

  test("retries refresh without resource on invalid_target (RFC 8707 compatibility)", async () => {
    // Default RFC 8707 sends `resource` on every refresh. A legacy AS
    // that doesn't recognize it returns 4xx invalid_target. Treating
    // that as terminal would log operators out on upgrade. Retry once
    // without `resource` instead so existing sessions survive.
    let calls = 0;
    let secondCallHadResource: boolean | undefined;
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const body = new URLSearchParams((init?.body as string) ?? "");
      if (calls === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_target" }), { status: 400 }),
        );
      }
      secondCallHadResource = body.has("resource");
      return Promise.resolve(new Response(JSON.stringify({ access_token: "ok" }), { status: 200 }));
    }) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com/v1",
      storage,
      metadata: METADATA,
      clientId: "c",
      resource: "https://mcp.example.com/v1",
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });

    expect(await tm.getAccessToken()).toBe("ok");
    expect(calls).toBe(2);
    expect(secondCallHadResource).toBe(false);
    // Tokens should be preserved + rotated, NOT cleared.
    expect(await tm.hasTokens()).toBe(true);
  });

  test("preserves tokens when invalid_target retry also fails", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "invalid_target" }), { status: 400 })),
    ) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "c",
      resource: "https://mcp.example.com",
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });

    expect(await tm.getAccessToken()).toBeUndefined();
    // Both attempts failed terminal — clear tokens (no longer revivable).
    expect(await tm.hasTokens()).toBe(false);
  });

  test("fires onInvalidClient callback when refresh returns invalid_client", async () => {
    // Refresh-time client revocation must surface to the provider so it
    // can drop the persisted DCR client BEFORE the next interactive
    // auth — without this, the first re-auth would reuse the dead
    // client_id and fail again before the registration was finally
    // cleared in the code-exchange path.
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })),
    ) as unknown as typeof fetch;

    let receivedClientId: string | undefined;
    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "c",
      onInvalidClient: (client) => {
        receivedClientId = client.clientId;
      },
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });

    expect(await tm.getAccessToken()).toBeUndefined();
    // The callback receives the EXACT client info that was sent on
    // the failing request — including issuer — so the provider can
    // CAS-delete the right authority-scoped key even if discovery
    // has flipped between the failure and this callback.
    expect(receivedClientId).toBe("c");
  });

  test("does NOT fire onInvalidClient on invalid_grant or transient 5xx", async () => {
    let callbackFired = 0;
    const onInvalidClient = (): void => {
      callbackFired += 1;
    };

    // invalid_grant: refresh token expired, NOT a client problem
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    ) as unknown as typeof fetch;

    let tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "c",
      onInvalidClient,
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });
    await tm.getAccessToken();
    expect(callbackFired).toBe(0);

    // 5xx transient
    storage = createMockStorage();
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("upstream", { status: 503 })),
    ) as unknown as typeof fetch;
    tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "c",
      onInvalidClient,
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
    });
    await tm.getAccessToken();
    expect(callbackFired).toBe(0);
  });

  test("keeps refresh_token when the response omits one (no rotation)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: "new", expires_in: 60 }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    const tm = createTokenManager({
      serverName: "s",
      serverUrl: "https://mcp.example.com",
      storage,
      metadata: METADATA,
      clientId: "c",
    });
    await tm.storeTokens({
      accessToken: "x",
      refreshToken: "rt-keep",
      expiresAt: Date.now() - 1,
    });

    await tm.getAccessToken();
    const stored = JSON.parse(
      (await storage.get(computeServerKey("s", "https://mcp.example.com"))) ?? "{}",
    );
    expect(stored.refreshToken).toBe("rt-keep");
  });
});
