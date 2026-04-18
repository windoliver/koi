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
          JSON.stringify({ client_id: "registered-123", client_id_issued_at: 1700000000 }),
          { status: 201 },
        ),
      );
    }) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
      clientName: "test-server",
    });

    expect(info).toBeDefined();
    expect(info?.clientId).toBe("registered-123");
  });

  test("accepts 200 response with client_id", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ client_id: "ok-200" }), { status: 200 })),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info?.clientId).toBe("ok-200");
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

    expect(info).toBeUndefined();
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

    expect(info).toBeUndefined();
  });

  test("records issuer + registration endpoint on successful registration", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ client_id: "pub" }), { status: 201 })),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
      issuer: "https://auth.example.com",
    });

    expect(info?.issuer).toBe("https://auth.example.com");
    expect(info?.registrationEndpoint).toBe("https://auth.example.com/register");
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

    expect(info).toBeUndefined();
  });

  test("returns undefined when response is missing client_id", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ foo: "bar" }), { status: 201 })),
    ) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info).toBeUndefined();
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

    expect(info).toBeUndefined();
  });

  test("accepts registrations whose returned redirect_uris include ours", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: "ok",
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

    expect(info?.clientId).toBe("ok");
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

    expect(info).toBeUndefined();
    expect(deleteCalled).toBe(true);
    expect(deleteAuth).toBe("Bearer mgmt-token");
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

    expect(info).toBeUndefined();
    expect(deleteCalled).toBe(true);
  });

  test("returns undefined when fetch throws", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("network"))) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info).toBeUndefined();
  });
});
