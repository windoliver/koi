import { afterEach, describe, expect, mock, test } from "bun:test";
import { registerDynamicClient } from "./registration.js";

const originalFetch = globalThis.fetch;

describe("registerDynamicClient", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns client info on 201 response", async () => {
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.redirect_uris).toEqual(["http://127.0.0.1:8912/callback"]);
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
      expect(body.response_types).toEqual(["code"]);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: "registered-123",
            client_id_issued_at: 1700000000,
            token_endpoint_auth_method: "none",
          }),
          { status: 201 },
        ),
      );
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
      clientName: "test-server",
    });

    expect(info.ok).toBe(true);
    if (info.ok) expect(info.info.clientId).toBe("registered-123");
  });

  test("accepts 200 response with client_id", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ client_id: "ok-200", token_endpoint_auth_method: "none" }), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(true);
    if (info.ok) expect(info.info.clientId).toBe("ok-200");
  });

  test("rejects confidential clients (server returned a client_secret)", async () => {
    // We request public-client PKCE (token_endpoint_auth_method=none).
    // If the AS returns a confidential registration anyway, token
    // exchange/refresh would later fail with invalid_client because we
    // only send client_id. Fail fast here rather than persist unusable
    // credentials.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ client_id: "confidential", client_secret: "shh" }), {
          status: 201,
        }),
      ),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
  });

  test("rejects registrations that omit token_endpoint_auth_method (RFC 7591 default = confidential)", async () => {
    // Per RFC 7591 §2, an omitted token_endpoint_auth_method defaults
    // to client_secret_basic. We only implement the public-client path,
    // so demand explicit confirmation rather than guess. Without this,
    // a response with only client_id would later fail every token
    // exchange / refresh with invalid_client.
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ client_id: "ambiguous" }), { status: 201 })),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
  });

  test("rejects confidential auth methods (e.g. client_secret_basic)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: "pub",
            token_endpoint_auth_method: "client_secret_basic",
          }),
          { status: 201 },
        ),
      ),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
  });

  test("records issuer + registration endpoint on successful registration", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ client_id: "pub", token_endpoint_auth_method: "none" }), {
          status: 201,
        }),
      ),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
      issuer: "https://auth.example.com",
    });

    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.info.issuer).toBe("https://auth.example.com");
      expect(info.info.registrationEndpoint).toBe("https://auth.example.com/register");
    }
  });

  test("rejects non-HTTPS registration endpoints", async () => {
    await expect(
      registerDynamicClient({
        registrationEndpoint: "http://auth.example.com/register",
        redirectUri: "http://127.0.0.1:8912/callback",
      }),
    ).rejects.toThrow(/https/);
  });

  test("returns undefined on non-2xx responses", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("denied", { status: 400 })),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
  });

  test("returns undefined when response is missing client_id", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ foo: "bar" }), { status: 201 })),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
  });

  test("rejects registrations whose returned redirect_uris do not include ours", async () => {
    // RFC 7591 §3.2.1: when the AS echoes redirect_uris, it advertises
    // the URIs it actually accepted. If our requested callback was
    // narrowed/rewritten away, persisting the registration would create
    // a sticky failure on the next authorization with invalid_redirect_uri.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: "rewritten",
            redirect_uris: ["http://127.0.0.1:7777/callback"],
          }),
          { status: 201 },
        ),
      ),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
  });

  test("accepts registrations whose returned redirect_uris include ours", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: "ok",
            token_endpoint_auth_method: "none",
            redirect_uris: ["http://127.0.0.1:8912/callback", "http://127.0.0.1:7777/callback"],
          }),
          { status: 201 },
        ),
      ),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(true);
    if (info.ok) expect(info.info.clientId).toBe("ok");
  });

  test("rolls back orphaned client via RFC 7592 DELETE on confidential rejection", async () => {
    // When the AS returns a usable-looking 2xx but with a client_secret
    // we cannot honor, the client already exists server-side. RFC 7592
    // gives us a registration_client_uri + registration_access_token
    // for management; use it to delete the orphan so repeated
    // `koi mcp auth` retries do not exhaust DCR quotas.
    let deleteCalled = false;
    let deleteAuth: string | undefined;
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (init?.method === "DELETE") {
        deleteCalled = true;
        deleteAuth = (init.headers as Record<string, string>)?.Authorization;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (urlStr.endsWith("/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              client_id: "orphan",
              client_secret: "shh",
              registration_client_uri: "https://auth.example.com/register/orphan",
              registration_access_token: "mgmt-token",
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    expect(deleteCalled).toBe(true);
    expect(deleteAuth).toBe("Bearer mgmt-token");
  });

  test("does NOT DELETE when registration_client_uri points to a different origin (SSRF guard)", async () => {
    // A malicious / compromised registration endpoint could direct the
    // rollback DELETE at an attacker-controlled host and exfiltrate the
    // management token. Refuse anything that isn't HTTPS + same host as
    // the registration endpoint.
    let attemptedDelete = false;
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (init?.method === "DELETE") {
        attemptedDelete = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (urlStr.endsWith("/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              client_id: "ssrf-bait",
              client_secret: "shh",
              registration_client_uri: "https://attacker.example.com/exfil",
              registration_access_token: "mgmt-token",
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    // Cross-origin management URI must NOT trigger the DELETE.
    expect(attemptedDelete).toBe(false);
  });

  test("rolls back orphan when 2xx response is missing client_id", async () => {
    // The AS may have created the client and returned a successful
    // status with management metadata, but a buggy / partial response
    // omitted client_id. Without rolling back, every retry leaks
    // another orphaned registration on the AS.
    let deleteCalled = false;
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (init?.method === "DELETE") {
        deleteCalled = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (urlStr.endsWith("/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              // No client_id, but full management metadata.
              registration_client_uri: "https://auth.example.com/register/headless",
              registration_access_token: "mgmt-token",
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    if (!info.ok) expect(info.terminal).toBe(true);
    expect(deleteCalled).toBe(true);
  });

  test("does NOT DELETE when registration_access_token is missing (no proof of ownership)", async () => {
    // An unauthenticated DELETE against a server-selected
    // /register/{id} path could trigger destructive semantics we
    // never consented to. Without the bearer management token issued
    // for THIS specific client, we have no proof of ownership —
    // safer to leave the orphan than to issue an unauthenticated
    // destructive request across the trust boundary.
    let attemptedDelete = false;
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (init?.method === "DELETE") {
        attemptedDelete = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (urlStr.endsWith("/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              client_id: "no-token",
              client_secret: "shh",
              registration_client_uri: "https://auth.example.com/register/no-token",
              // NO registration_access_token — must skip cleanup.
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    expect(attemptedDelete).toBe(false);
  });

  test("does NOT DELETE when registration_client_uri equals the registration endpoint (would target the collection)", async () => {
    // A buggy or hostile AS could echo back the bare registration
    // endpoint. Without strict-child validation, rollback would
    // bearer-DELETE the collection itself — server-defined semantics
    // could mean deleting every registered client. Refuse to send
    // an authenticated DELETE against the endpoint itself.
    let attemptedDelete = false;
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (init?.method === "DELETE") {
        attemptedDelete = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (urlStr.endsWith("/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              client_id: "collection-bait",
              client_secret: "shh",
              // BAD: same as registration endpoint, no per-client suffix.
              registration_client_uri: "https://auth.example.com/register",
              registration_access_token: "mgmt-token",
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    expect(attemptedDelete).toBe(false);
  });

  test("does NOT DELETE when registration_client_uri is on a different path on the same host", async () => {
    // Same-origin is necessary but not sufficient: the URI must be the
    // registration endpoint or a sub-path of it (RFC 7592
    // `{registration_endpoint}/{client_id}` shape). Otherwise a
    // compromised AS could direct rollback at any DELETE-capable
    // endpoint sharing the host (admin APIs, other resources).
    let attemptedDelete = false;
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (init?.method === "DELETE") {
        attemptedDelete = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (urlStr.endsWith("/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              client_id: "wrong-path",
              client_secret: "shh",
              // Same host as registration endpoint, but unrelated path.
              registration_client_uri: "https://auth.example.com/admin/users/42",
              registration_access_token: "mgmt-token",
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    // Must NOT issue authenticated DELETE to an unrelated same-host path.
    expect(attemptedDelete).toBe(false);
  });

  test("DOES DELETE when registration_client_uri is registration_endpoint/{client_id}", async () => {
    let deleteUrl: string | undefined;
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (init?.method === "DELETE") {
        deleteUrl = urlStr;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (urlStr.endsWith("/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              client_id: "valid",
              client_secret: "shh",
              registration_client_uri: "https://auth.example.com/register/valid",
              registration_access_token: "mgmt-token",
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    expect(deleteUrl).toBe("https://auth.example.com/register/valid");
  });

  test("does NOT DELETE when registration_client_uri uses http:// (downgrade guard)", async () => {
    let attemptedDelete = false;
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (init?.method === "DELETE") {
        attemptedDelete = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (urlStr.endsWith("/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              client_id: "downgrade",
              client_secret: "shh",
              registration_client_uri: "http://auth.example.com/register/downgrade",
              registration_access_token: "mgmt-token",
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    expect(attemptedDelete).toBe(false);
  });

  test("rolls back orphan when narrowed redirect_uris come back with management uri", async () => {
    let deleteCalled = false;
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (init?.method === "DELETE") {
        deleteCalled = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (urlStr.endsWith("/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              client_id: "narrowed",
              redirect_uris: ["http://127.0.0.1:7777/callback"],
              registration_client_uri: "https://auth.example.com/register/narrowed",
              registration_access_token: "mgmt-token",
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    expect(deleteCalled).toBe(true);
  });

  test("classifies malformed 2xx JSON as terminal (so dead sessions can clear)", async () => {
    // A server that returns 201 with broken JSON cannot be recovered
    // by retry. The refresh path needs `terminal: true` so token.ts
    // clears expired tokens and onReauthNeeded fires, instead of
    // looping forever on a transient classification.
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("{not json", { status: 201 })),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    if (!info.ok) expect(info.terminal).toBe(true);
  });

  test("classifies 429 (rate limit) as transient (so retries don't destroy state)", async () => {
    // Throttling clears on its own. Treating it as terminal would
    // delete a perfectly recoverable session and force operators
    // through a fresh re-auth on every transient rate-limit.
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("retry later", { status: 429 })),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    if (!info.ok) expect(info.terminal).toBe(false);
  });

  test("classifies 500 (server error) as transient", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("oops", { status: 502 })),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    if (!info.ok) expect(info.terminal).toBe(false);
  });

  test("classifies 400 (validation) as terminal", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("invalid_redirect_uri", { status: 400 })),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
    if (!info.ok) expect(info.terminal).toBe(true);
  });

  test("returns undefined when fetch throws", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("network"))) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info.ok).toBe(false);
  });
});
