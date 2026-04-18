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

  test("returns undefined when fetch throws", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("network"))) as unknown as typeof fetch;

    const info = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://127.0.0.1:8912/callback",
    });

    expect(info).toBeUndefined();
  });
});
