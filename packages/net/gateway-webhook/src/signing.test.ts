import { describe, expect, test } from "bun:test";
import {
  verifyGenericSignature,
  verifyGitHubSignature,
  verifySlackSignature,
  verifyStripeSignature,
} from "./signing.js";

const SECRET = "test-secret-key";
const BODY = JSON.stringify({ event: "test", data: "hello" });

// ---------------------------------------------------------------------------
// Helpers: build provider-specific request objects
// ---------------------------------------------------------------------------

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Buffer.from(sig).toString("hex");
}

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers,
    body: BODY,
  });
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

describe("verifyGitHubSignature", () => {
  test("valid signature passes", async () => {
    const hex = await hmacHex(SECRET, BODY);
    const req = makeRequest({ "x-hub-signature-256": `sha256=${hex}` });
    expect(await verifyGitHubSignature(SECRET, BODY, req)).toBe(true);
  });

  test("invalid signature fails", async () => {
    const req = makeRequest({ "x-hub-signature-256": "sha256=badhex" });
    expect(await verifyGitHubSignature(SECRET, BODY, req)).toBe(false);
  });

  test("missing header fails", async () => {
    const req = makeRequest({});
    expect(await verifyGitHubSignature(SECRET, BODY, req)).toBe(false);
  });

  test("wrong secret fails", async () => {
    const hex = await hmacHex("wrong-secret", BODY);
    const req = makeRequest({ "x-hub-signature-256": `sha256=${hex}` });
    expect(await verifyGitHubSignature(SECRET, BODY, req)).toBe(false);
  });

  test("rawBodyBytes path: accepts signature computed over raw bytes", async () => {
    // Exercises the new hmacSha256HexBytes path used in production.
    const enc = new TextEncoder();
    const rawBodyBytes = enc.encode(BODY);
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, rawBodyBytes);
    const hex = Buffer.from(sigBuf).toString("hex");
    const req = makeRequest({ "x-hub-signature-256": `sha256=${hex}` });
    expect(await verifyGitHubSignature(SECRET, BODY, req, rawBodyBytes)).toBe(true);
  });

  test("rawBodyBytes path: multi-byte UTF-8 body verified byte-exact", async () => {
    const multiByteBody = JSON.stringify({ msg: "héllo 🎉" });
    const enc = new TextEncoder();
    const rawBodyBytes = enc.encode(multiByteBody);
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, rawBodyBytes);
    const hex = Buffer.from(sigBuf).toString("hex");
    const req = makeRequest({ "x-hub-signature-256": `sha256=${hex}` });
    expect(await verifyGitHubSignature(SECRET, multiByteBody, req, rawBodyBytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

describe("verifySlackSignature", () => {
  test("valid signature passes", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sigStr = `v0:${ts}:${BODY}`;
    const hex = await hmacHex(SECRET, sigStr);
    const req = makeRequest({
      "x-slack-request-timestamp": ts,
      "x-slack-signature": `v0=${hex}`,
    });
    expect(await verifySlackSignature(SECRET, BODY, req)).toBe(true);
  });

  test("expired timestamp fails (>5 min old)", async () => {
    const ts = Math.floor(Date.now() / 1000 - 400).toString();
    const sigStr = `v0:${ts}:${BODY}`;
    const hex = await hmacHex(SECRET, sigStr);
    const req = makeRequest({
      "x-slack-request-timestamp": ts,
      "x-slack-signature": `v0=${hex}`,
    });
    expect(await verifySlackSignature(SECRET, BODY, req)).toBe(false);
  });

  test("missing headers fails", async () => {
    const req = makeRequest({});
    expect(await verifySlackSignature(SECRET, BODY, req)).toBe(false);
  });

  test("invalid signature fails", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const req = makeRequest({
      "x-slack-request-timestamp": ts,
      "x-slack-signature": "v0=badsig",
    });
    expect(await verifySlackSignature(SECRET, BODY, req)).toBe(false);
  });

  test("rawBodyBytes path: accepts signature computed over concatBytes(prefix, rawBodyBytes)", async () => {
    // Exercises the concatBytes(v0:ts:, rawBodyBytes) path used in production.
    const ts = Math.floor(Date.now() / 1000).toString();
    const enc = new TextEncoder();
    const rawBodyBytes = enc.encode(BODY);
    const signingBytes = new Uint8Array([...enc.encode(`v0:${ts}:`), ...rawBodyBytes]);
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, signingBytes);
    const hex = Buffer.from(sigBuf).toString("hex");
    const req = makeRequest({
      "x-slack-request-timestamp": ts,
      "x-slack-signature": `v0=${hex}`,
    });
    expect(await verifySlackSignature(SECRET, BODY, req, undefined, rawBodyBytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

describe("verifyStripeSignature", () => {
  test("valid signature passes", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sigStr = `${ts}.${BODY}`;
    const hex = await hmacHex(SECRET, sigStr);
    const req = makeRequest({ "stripe-signature": `t=${ts},v1=${hex}` });
    expect(await verifyStripeSignature(SECRET, BODY, req)).toBe(true);
  });

  test("expired timestamp fails", async () => {
    const ts = Math.floor(Date.now() / 1000 - 400).toString();
    const sigStr = `${ts}.${BODY}`;
    const hex = await hmacHex(SECRET, sigStr);
    const req = makeRequest({ "stripe-signature": `t=${ts},v1=${hex}` });
    expect(await verifyStripeSignature(SECRET, BODY, req)).toBe(false);
  });

  test("missing header fails", async () => {
    const req = makeRequest({});
    expect(await verifyStripeSignature(SECRET, BODY, req)).toBe(false);
  });

  test("multiple v1 sigs — accepts if any match", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sigStr = `${ts}.${BODY}`;
    const goodHex = await hmacHex(SECRET, sigStr);
    const req = makeRequest({ "stripe-signature": `t=${ts},v1=badhex,v1=${goodHex}` });
    expect(await verifyStripeSignature(SECRET, BODY, req)).toBe(true);
  });

  test("rawBodyBytes path: accepts signature computed over concatBytes(prefix, rawBodyBytes)", async () => {
    // Exercises the concatBytes(ts., rawBodyBytes) path used in production.
    const ts = Math.floor(Date.now() / 1000).toString();
    const enc = new TextEncoder();
    const rawBodyBytes = enc.encode(BODY);
    const signingBytes = new Uint8Array([...enc.encode(`${ts}.`), ...rawBodyBytes]);
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, signingBytes);
    const hex = Buffer.from(sigBuf).toString("hex");
    const req = makeRequest({ "stripe-signature": `t=${ts},v1=${hex}` });
    expect(await verifyStripeSignature(SECRET, BODY, req, undefined, rawBodyBytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generic (Standard Webhooks)
// ---------------------------------------------------------------------------

describe("verifyGenericSignature", () => {
  test("valid signature passes", async () => {
    const webhookId = "wh-test-01";
    const ts = Math.floor(Date.now() / 1000).toString();
    const sigStr = `${webhookId}.${ts}.${BODY}`;
    const hex = await hmacHex(SECRET, sigStr);
    const b64 = Buffer.from(hex, "hex").toString("base64");
    const req = makeRequest({
      "x-webhook-id": webhookId,
      "x-webhook-timestamp": ts,
      "x-webhook-signature": `v1,${b64}`,
    });
    expect(await verifyGenericSignature(SECRET, BODY, req)).toBe(true);
  });

  test("rawBodyBytes path: accepts signature computed over raw bytes", async () => {
    // Exercises the new byte-exact code path used by webhook.ts in production.
    // The signature is computed over concatBytes(prefix, rawBodyBytes) — not re-encoded from string.
    const webhookId = "wh-bytes-test";
    const ts = Math.floor(Date.now() / 1000).toString();
    const enc = new TextEncoder();
    const rawBodyBytes = enc.encode(BODY);
    const signingBytes = new Uint8Array([...enc.encode(`${webhookId}.${ts}.`), ...rawBodyBytes]);
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, signingBytes);
    const b64 = Buffer.from(sigBuf).toString("base64");
    const req = makeRequest({
      "x-webhook-id": webhookId,
      "x-webhook-timestamp": ts,
      "x-webhook-signature": `v1,${b64}`,
    });
    expect(await verifyGenericSignature(SECRET, BODY, req, undefined, rawBodyBytes)).toBe(true);
  });

  test("rawBodyBytes path: multi-byte UTF-8 payload is signed byte-exact", async () => {
    // Non-ASCII characters (e.g. emoji) have multi-byte UTF-8 representations.
    // The raw-byte signing path preserves the exact wire bytes.
    const multiByteBody = JSON.stringify({ data: "héllo 🎉" });
    const webhookId = "wh-utf8-test";
    const ts = Math.floor(Date.now() / 1000).toString();
    const enc = new TextEncoder();
    const rawBodyBytes = enc.encode(multiByteBody);
    const signingBytes = new Uint8Array([...enc.encode(`${webhookId}.${ts}.`), ...rawBodyBytes]);
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, signingBytes);
    const b64 = Buffer.from(sigBuf).toString("base64");
    const req = makeRequest({
      "x-webhook-id": webhookId,
      "x-webhook-timestamp": ts,
      "x-webhook-signature": `v1,${b64}`,
    });
    expect(await verifyGenericSignature(SECRET, multiByteBody, req, undefined, rawBodyBytes)).toBe(
      true,
    );
    // Passing a mis-encoded body (wrong bytes) should fail — byte-exact matching
    const wrongBytes = enc.encode(`${multiByteBody} `); // extra space changes byte sequence
    expect(await verifyGenericSignature(SECRET, multiByteBody, req, undefined, wrongBytes)).toBe(
      false,
    );
  });

  test("expired timestamp fails", async () => {
    const webhookId = "wh-test-01";
    const ts = Math.floor(Date.now() / 1000 - 400).toString();
    const sigStr = `${webhookId}.${ts}.${BODY}`;
    const hex = await hmacHex(SECRET, sigStr);
    const b64 = Buffer.from(hex, "hex").toString("base64");
    const req = makeRequest({
      "x-webhook-id": webhookId,
      "x-webhook-timestamp": ts,
      "x-webhook-signature": `v1,${b64}`,
    });
    expect(await verifyGenericSignature(SECRET, BODY, req)).toBe(false);
  });

  test("missing headers fails", async () => {
    const req = makeRequest({});
    expect(await verifyGenericSignature(SECRET, BODY, req)).toBe(false);
  });

  test("bad signature fails", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const req = makeRequest({
      "x-webhook-id": "wh-test-01",
      "x-webhook-timestamp": ts,
      "x-webhook-signature": "v1,badsignature=",
    });
    expect(await verifyGenericSignature(SECRET, BODY, req)).toBe(false);
  });
});
