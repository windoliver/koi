/**
 * OAuth flow integration tests — real HTTP against a local Bun.serve()
 * mock authorization server, real provider code, real JSON framing.
 *
 * Unit tests (provider.test.ts / tokens.test.ts / registration.test.ts)
 * stub `globalThis.fetch` at the test boundary and verify branching.
 * This file wires everything together: startAuthFlow and getAccessToken
 * run end-to-end against a controllable AS so we catch integration
 * bugs unit mocks can miss (request-body framing, header handling,
 * redirect-follow behavior of runtime.authorize).
 *
 * DCR itself (`registerDynamicClient`) requires HTTPS by contract, so
 * this harness exercises the STATIC clientId path. DCR internals stay
 * covered by dedicated unit tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SecureStorage } from "@koi/secure-storage";
import type { Server } from "bun";
import { createOAuthAuthProvider } from "../provider.js";
import { computeServerKey } from "../tokens.js";
import type { OAuthRuntime } from "../types.js";

// ---------------------------------------------------------------------------
// Mock authorization server
// ---------------------------------------------------------------------------

type TokenScenario = "ok" | "invalid_target" | "invalid_grant" | "rate_limited" | "invalid_client";

interface MockState {
  issuedTokens: Map<string, { refreshToken: string; accessToken: string }>;
  tokenScenario: TokenScenario;
  rotateRefreshToken: boolean;
  authorizeReturnsCode: boolean;
  authorizeReturnsState: "echo" | "wrong" | "missing";
  tokenRequestCount: number;
  lastTokenBody: URLSearchParams | undefined;
}

const state: MockState = {
  issuedTokens: new Map(),
  tokenScenario: "ok",
  rotateRefreshToken: true,
  authorizeReturnsCode: true,
  authorizeReturnsState: "echo",
  tokenRequestCount: 0,
  lastTokenBody: undefined,
};

function resetState(): void {
  state.issuedTokens.clear();
  state.tokenScenario = "ok";
  state.rotateRefreshToken = true;
  state.authorizeReturnsCode = true;
  state.authorizeReturnsState = "echo";
  state.tokenRequestCount = 0;
  state.lastTokenBody = undefined;
}

let server: Server<undefined>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      // RFC 8414 discovery
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
        });
      }

      // Authorize endpoint — our tests don't route the "browser" through
      // this; the runtime mock synthesizes callback results directly.
      // Still respond so Bun doesn't error on stray hits.
      if (url.pathname === "/authorize") {
        return new Response("authorize", { status: 200 });
      }

      // Token endpoint
      if (url.pathname === "/token" && req.method === "POST") {
        state.tokenRequestCount += 1;
        const body = new URLSearchParams(await req.text());
        state.lastTokenBody = body;
        const grantType = body.get("grant_type");

        switch (state.tokenScenario) {
          case "invalid_target":
            return Response.json({ error: "invalid_target" }, { status: 400 });
          case "invalid_grant":
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          case "invalid_client":
            return Response.json({ error: "invalid_client" }, { status: 401 });
          case "rate_limited":
            return Response.json({ error: "too_many_requests" }, { status: 429 });
          default: {
            if (grantType === "authorization_code") {
              const accessToken = `access-${state.tokenRequestCount}`;
              const refreshToken = `refresh-${state.tokenRequestCount}`;
              state.issuedTokens.set(accessToken, { accessToken, refreshToken });
              return Response.json({
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_in: 3600,
                token_type: "Bearer",
              });
            }
            if (grantType === "refresh_token") {
              const accessToken = `access-rotated-${state.tokenRequestCount}`;
              const refreshToken = state.rotateRefreshToken
                ? `refresh-rotated-${state.tokenRequestCount}`
                : (body.get("refresh_token") ?? "");
              return Response.json({
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_in: 3600,
                token_type: "Bearer",
              });
            }
            return new Response("unsupported_grant_type", { status: 400 });
          }
        }
      }

      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// In-memory SecureStorage
// ---------------------------------------------------------------------------

function createMemStorage(): SecureStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => {
      data.set(k, v);
    },
    delete: async (k) => data.delete(k),
    withLock: async (_k, fn) => fn(),
  };
}

// Builds a runtime that synthesizes the redirect callback: reads the
// authorization URL params, produces a matching (code, state) result.
function createMockRuntime(opts?: { stateMode?: "echo" | "wrong" | "missing" }): OAuthRuntime {
  return {
    authorize: mock(async (authUrl: string) => {
      const url = new URL(authUrl);
      const requested = url.searchParams.get("state") ?? undefined;
      const mode = opts?.stateMode ?? "echo";
      const returnedState =
        mode === "wrong" ? "not-the-right-state" : mode === "missing" ? undefined : requested;
      return { code: "test-auth-code", state: returnedState };
    }),
    onReauthNeeded: mock(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuth integration — happy path", () => {
  test("startAuthFlow → token exchange → persists tokens", async () => {
    const storage = createMemStorage();
    const provider = createOAuthAuthProvider({
      serverName: "t",
      serverUrl: baseUrl,
      oauthConfig: { clientId: "static" },
      runtime: createMockRuntime(),
      storage,
    });

    await expect(provider.startAuthFlow()).resolves.toBe(true);

    const stored = await storage.get(computeServerKey("t", baseUrl));
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored ?? "{}");
    expect(parsed.accessToken).toMatch(/^access-/);
    expect(parsed.refreshToken).toMatch(/^refresh-/);
  });

  test("expired access token triggers refresh against real endpoint", async () => {
    const storage = createMemStorage();
    const key = computeServerKey("t", baseUrl);
    await storage.set(
      key,
      JSON.stringify({
        accessToken: "expired",
        refreshToken: "rt-ok",
        expiresAt: Date.now() - 1000,
      }),
    );

    const provider = createOAuthAuthProvider({
      serverName: "t",
      serverUrl: baseUrl,
      oauthConfig: { clientId: "static" },
      runtime: createMockRuntime(),
      storage,
    });

    const token = await provider.token();
    expect(token).toMatch(/^access-rotated-/);
    // Rotated refresh token persisted
    const parsed = JSON.parse((await storage.get(key)) ?? "{}");
    expect(parsed.refreshToken).toMatch(/^refresh-rotated-/);
  });

  test("non-rotating refresh keeps the original refresh_token", async () => {
    state.rotateRefreshToken = false;

    const storage = createMemStorage();
    const key = computeServerKey("t", baseUrl);
    await storage.set(
      key,
      JSON.stringify({
        accessToken: "expired",
        refreshToken: "rt-stable",
        expiresAt: Date.now() - 1000,
      }),
    );

    const provider = createOAuthAuthProvider({
      serverName: "t",
      serverUrl: baseUrl,
      oauthConfig: { clientId: "static" },
      runtime: createMockRuntime(),
      storage,
    });

    const token = await provider.token();
    expect(token).toMatch(/^access-rotated-/);
    const parsed = JSON.parse((await storage.get(key)) ?? "{}");
    // AS did not rotate — original refresh token preserved.
    expect(parsed.refreshToken).toBe("rt-stable");
  });
});

describe("OAuth integration — RFC 8707 retry shim", () => {
  test("refresh with invalid_target retries without resource and succeeds", async () => {
    // First request scenario = invalid_target; after that, flip to ok
    // so the retry succeeds.
    state.tokenScenario = "invalid_target";
    const origFetch = globalThis.fetch;
    // Sniff + flip: after the first /token POST, switch to ok.
    let tokenHits = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/token") && init?.method === "POST") {
        tokenHits += 1;
        if (tokenHits === 2) state.tokenScenario = "ok";
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      const storage = createMemStorage();
      const key = computeServerKey("t", baseUrl);
      await storage.set(
        key,
        JSON.stringify({
          accessToken: "expired",
          refreshToken: "rt",
          expiresAt: Date.now() - 1000,
        }),
      );

      const provider = createOAuthAuthProvider({
        serverName: "t",
        serverUrl: baseUrl,
        oauthConfig: { clientId: "static" },
        runtime: createMockRuntime(),
        storage,
      });

      const token = await provider.token();
      expect(token).toMatch(/^access-rotated-/);
      // First call had resource, second didn't — state.lastTokenBody
      // reflects the LATEST (successful) call, which must lack resource.
      expect(state.lastTokenBody?.has("resource")).toBe(false);
      expect(state.tokenRequestCount).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("OAuth integration — retryable 429", () => {
  test("refresh 429 preserves tokens (transient classification)", async () => {
    state.tokenScenario = "rate_limited";

    const storage = createMemStorage();
    const key = computeServerKey("t", baseUrl);
    await storage.set(
      key,
      JSON.stringify({
        accessToken: "expired",
        refreshToken: "rt-keep",
        expiresAt: Date.now() - 1000,
      }),
    );

    const provider = createOAuthAuthProvider({
      serverName: "t",
      serverUrl: baseUrl,
      oauthConfig: { clientId: "static" },
      runtime: createMockRuntime(),
      storage,
    });

    expect(await provider.token()).toBeUndefined();
    const stored = await storage.get(key);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored ?? "{}");
    expect(parsed.refreshToken).toBe("rt-keep");
  });
});

describe("OAuth integration — terminal refresh failures", () => {
  test("refresh invalid_grant clears tokens + handleUnauthorized prompts re-auth", async () => {
    state.tokenScenario = "invalid_grant";

    const storage = createMemStorage();
    const runtime = createMockRuntime();
    const key = computeServerKey("t", baseUrl);
    await storage.set(
      key,
      JSON.stringify({
        accessToken: "expired",
        refreshToken: "rt-dead",
        expiresAt: Date.now() - 1000,
      }),
    );

    const provider = createOAuthAuthProvider({
      serverName: "t",
      serverUrl: baseUrl,
      oauthConfig: { clientId: "static" },
      runtime,
      storage,
    });

    await provider.handleUnauthorized();
    expect(await storage.get(key)).toBeUndefined();
    expect(runtime.onReauthNeeded).toHaveBeenCalledWith("t");
  });
});

describe("OAuth integration — state mismatch (CSRF guard)", () => {
  test("callback with wrong state aborts flow + reports state_mismatch", async () => {
    const storage = createMemStorage();
    const failures: Array<{ kind: string }> = [];
    const runtime: OAuthRuntime = {
      ...createMockRuntime({ stateMode: "wrong" }),
      onAuthFailure: (r) => {
        failures.push(r);
      },
    };

    const provider = createOAuthAuthProvider({
      serverName: "t",
      serverUrl: baseUrl,
      oauthConfig: { clientId: "static" },
      runtime,
      storage,
    });

    await expect(provider.startAuthFlow()).resolves.toBe(false);
    // No tokens persisted
    expect(await storage.get(computeServerKey("t", baseUrl))).toBeUndefined();
    expect(failures.map((f) => f.kind)).toContain("state_mismatch");
  });
});

describe("OAuth integration — corrupt storage self-heal", () => {
  test("handleUnauthorized clears unparseable token blob + prompts re-auth", async () => {
    const storage = createMemStorage();
    const runtime = createMockRuntime();
    const key = computeServerKey("t", baseUrl);
    // Unparseable garbage
    await storage.set(key, "{not json{");

    const provider = createOAuthAuthProvider({
      serverName: "t",
      serverUrl: baseUrl,
      oauthConfig: { clientId: "static" },
      runtime,
      storage,
    });

    await provider.handleUnauthorized();
    expect(await storage.get(key)).toBeUndefined();
    expect(runtime.onReauthNeeded).toHaveBeenCalledWith("t");
  });
});
