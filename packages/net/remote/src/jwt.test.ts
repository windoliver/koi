import { describe, expect, test } from "bun:test";

import { verifyRemoteJwt } from "./index.js";

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

async function sign(
  payload: Record<string, unknown>,
  secret = "secret",
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): Promise<string> {
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  return signRawPayload(JSON.stringify(payload), secret, encodedHeader);
}

async function signRawPayload(
  payloadJson: string,
  secret = "secret",
  encodedHeader = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
): Promise<string> {
  const encodedPayload = base64UrlEncode(payloadJson);
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

const validPayload = {
  iss: "koi",
  aud: "remote",
  exp: 2_000,
  sub: "user-1",
  device_id: "device-1",
  agent_id: "agent-1",
  permissions: ["remote:connect"],
  metadata: { label: "laptop" },
};

const verifierOptions = {
  secret: "secret",
  issuer: "koi",
  audience: "remote",
  nowMs: () => 1_000_000,
};

describe("verifyRemoteJwt", () => {
  test("valid HS256 token verifies", async () => {
    const result = await verifyRemoteJwt(await sign(validPayload), verifierOptions);

    expect(result).toEqual({
      ok: true,
      claims: {
        subject: "user-1",
        deviceId: "device-1",
        agentId: "agent-1",
        permissions: ["remote:connect"],
        metadata: { label: "laptop" },
      },
    });
  });

  test("expired token rejects with expired", async () => {
    const result = await verifyRemoteJwt(
      await sign({ ...validPayload, exp: 999 }),
      verifierOptions,
    );

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  test("non-finite expiration rejects with expired", async () => {
    const result = await verifyRemoteJwt(
      await signRawPayload(
        '{"iss":"koi","aud":"remote","exp":1e999,"sub":"user-1","device_id":"device-1"}',
      ),
      verifierOptions,
    );

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  test("malformed compact JWT rejects with malformed", async () => {
    const result = await verifyRemoteJwt("not.a.jwt.with.too.many.parts", {
      ...verifierOptions,
    });

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  test("wrong issuer rejects with invalid_issuer", async () => {
    const result = await verifyRemoteJwt(
      await sign({ ...validPayload, iss: "other" }),
      verifierOptions,
    );

    expect(result).toEqual({ ok: false, reason: "invalid_issuer" });
  });

  test("wrong audience rejects with invalid_audience", async () => {
    const result = await verifyRemoteJwt(
      await sign({ ...validPayload, aud: "other" }),
      verifierOptions,
    );

    expect(result).toEqual({ ok: false, reason: "invalid_audience" });
  });

  test("alg none rejects with unsupported_alg", async () => {
    const token = [
      base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" })),
      base64UrlEncode(JSON.stringify(validPayload)),
      "",
    ].join(".");

    const result = await verifyRemoteJwt(token, verifierOptions);

    expect(result).toEqual({ ok: false, reason: "unsupported_alg" });
  });

  test("invalid signature rejects with invalid_signature", async () => {
    const result = await verifyRemoteJwt(await sign(validPayload, "wrong-secret"), verifierOptions);

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("missing sub rejects with missing_subject", async () => {
    const { sub: _sub, ...payload } = validPayload;
    const result = await verifyRemoteJwt(await sign(payload), verifierOptions);

    expect(result).toEqual({ ok: false, reason: "missing_subject" });
  });

  test("missing device_id rejects with missing_device", async () => {
    const { device_id: _deviceId, ...payload } = validPayload;
    const result = await verifyRemoteJwt(await sign(payload), verifierOptions);

    expect(result).toEqual({ ok: false, reason: "missing_device" });
  });

  test("not-before token rejects with not_before", async () => {
    const result = await verifyRemoteJwt(
      await sign({ ...validPayload, nbf: 1_001 }),
      verifierOptions,
    );

    expect(result).toEqual({ ok: false, reason: "not_before" });
  });

  test("non-finite not-before rejects with not_before", async () => {
    const result = await verifyRemoteJwt(
      await signRawPayload(
        '{"iss":"koi","aud":"remote","exp":2000,"nbf":1e999,"sub":"user-1","device_id":"device-1"}',
      ),
      verifierOptions,
    );

    expect(result).toEqual({ ok: false, reason: "not_before" });
  });

  test("mixed permissions array is treated as empty", async () => {
    const result = await verifyRemoteJwt(
      await sign({ ...validPayload, permissions: ["remote:connect", 123] }),
      verifierOptions,
    );

    expect(result).toEqual({
      ok: true,
      claims: {
        subject: "user-1",
        deviceId: "device-1",
        agentId: "agent-1",
        permissions: [],
        metadata: { label: "laptop" },
      },
    });
  });
});
