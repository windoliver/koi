import { describe, expect, test } from "bun:test";
import type { RemoteAuthenticatorOptions } from "./index.js";
import { authenticateRemoteRequest, createInMemoryTrustedDeviceRegistry } from "./index.js";

const encoder = new TextEncoder();

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(encoder.encode(value));
}

function base64UrlEncodeBytes(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sign(payload: Record<string, unknown>, secret = "secret"): Promise<string> {
  const encodedHeader = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  return `${encodedHeader}.${encodedPayload}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

function createOptions(): RemoteAuthenticatorOptions {
  const trustedDevices = createInMemoryTrustedDeviceRegistry();
  trustedDevices.register({
    subject: "user-1",
    deviceId: "device-1",
    registeredAt: 1_000,
    metadata: { label: "laptop" },
  });
  return {
    jwt: {
      secret: "secret",
      issuer: "koi",
      audience: "remote",
      nowMs: () => 1_000_000,
    },
    trustedDevices,
    permissionMappings: [{ remote: "remote:read", action: "read_file", resource: "workspace:*" }],
    allowInsecureLocalhost: true,
  };
}

const validPayload = {
  iss: "koi",
  aud: "remote",
  exp: 2_000,
  sub: "user-1",
  device_id: "device-1",
  permissions: ["remote:read"],
  metadata: { label: "laptop" },
};

describe("authenticateRemoteRequest", () => {
  test("authenticates valid token, trusted device, permission, and transport", async () => {
    const result = await authenticateRemoteRequest(
      {
        bearerToken: `Bearer ${await sign(validPayload)}`,
        transport: "websocket",
        operation: "read",
        url: "ws://127.0.0.1/session",
      },
      createOptions(),
    );

    expect(result).toEqual({
      ok: true,
      subject: "user-1",
      deviceId: "device-1",
      permissions: [
        {
          principal: "remote",
          action: "read_file",
          resource: "workspace:*",
          context: { remotePermission: "remote:read" },
        },
      ],
    });
  });

  test("expired JWT denies with jwt_rejected", async () => {
    const result = await authenticateRemoteRequest(
      {
        bearerToken: await sign({ ...validPayload, exp: 999 }),
        transport: "websocket",
        operation: "read",
        url: "wss://remote.example.com/session",
      },
      createOptions(),
    );

    expect(result).toEqual({ ok: false, reason: "jwt_rejected" });
  });

  test("malformed JWT denies with jwt_rejected", async () => {
    const result = await authenticateRemoteRequest(
      {
        bearerToken: "not.a.jwt.with.too.many.parts",
        transport: "websocket",
        operation: "read",
        url: "wss://remote.example.com/session",
      },
      createOptions(),
    );

    expect(result).toEqual({ ok: false, reason: "jwt_rejected" });
  });

  test("revoked device denies with untrusted_device", async () => {
    const options = createOptions();
    options.trustedDevices.revoke("user-1", "device-1", 2_000);

    const result = await authenticateRemoteRequest(
      {
        bearerToken: await sign(validPayload),
        transport: "websocket",
        operation: "read",
        url: "wss://remote.example.com/session",
      },
      options,
    );

    expect(result).toEqual({ ok: false, reason: "untrusted_device" });
  });

  test("unknown device denies with untrusted_device", async () => {
    const result = await authenticateRemoteRequest(
      {
        bearerToken: await sign({ ...validPayload, device_id: "device-unknown" }),
        transport: "websocket",
        operation: "read",
        url: "wss://remote.example.com/session",
      },
      createOptions(),
    );

    expect(result).toEqual({ ok: false, reason: "untrusted_device" });
  });

  test("unknown permission denies with permission_rejected", async () => {
    const result = await authenticateRemoteRequest(
      {
        bearerToken: await sign({ ...validPayload, permissions: ["remote:admin"] }),
        transport: "websocket",
        operation: "read",
        url: "wss://remote.example.com/session",
      },
      createOptions(),
    );

    expect(result).toEqual({ ok: false, reason: "permission_rejected" });
  });

  test("wrong transport denies with transport_rejected", async () => {
    const result = await authenticateRemoteRequest(
      {
        bearerToken: await sign(validPayload),
        transport: "websocket",
        operation: "write",
        url: "wss://remote.example.com/session",
      },
      createOptions(),
    );

    expect(result).toEqual({ ok: false, reason: "transport_rejected" });
  });

  test("insecure transport denies with transport_rejected", async () => {
    const result = await authenticateRemoteRequest(
      {
        bearerToken: await sign(validPayload),
        transport: "http-post",
        operation: "write",
        url: "http://remote.example.com/session",
      },
      createOptions(),
    );

    expect(result).toEqual({ ok: false, reason: "transport_rejected" });
  });
});
