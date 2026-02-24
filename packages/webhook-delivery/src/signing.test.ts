import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createSignatureHeaders, verifySignature } from "./signing.js";

describe("createSignatureHeaders", () => {
  test("produces Standard Webhooks compliant headers", () => {
    const headers = createSignatureHeaders(
      "msg_01EXAMPLE",
      1700000000,
      '{"kind":"session.started"}',
      "test-secret",
    );

    expect(headers["webhook-id"]).toBe("msg_01EXAMPLE");
    expect(headers["webhook-timestamp"]).toBe("1700000000");
    expect(headers["webhook-signature"]).toMatch(/^v1,.+$/);
    expect(headers["content-type"]).toBe("application/json");
  });

  test("signature matches manual HMAC computation", () => {
    const id = "wh_12345";
    const ts = 1700000000;
    const body = '{"kind":"tool.failed","data":{}}';
    const secret = "my-secret-key";

    const headers = createSignatureHeaders(id, ts, body, secret);

    // Manual computation
    const signedContent = `${id}.${ts}.${body}`;
    const expected = createHmac("sha256", secret).update(signedContent).digest("base64");

    expect(headers["webhook-signature"]).toBe(`v1,${expected}`);
  });

  test("different secrets produce different signatures", () => {
    const body = '{"kind":"session.started"}';
    const h1 = createSignatureHeaders("id1", 1000, body, "secret-a");
    const h2 = createSignatureHeaders("id1", 1000, body, "secret-b");

    expect(h1["webhook-signature"]).not.toBe(h2["webhook-signature"]);
  });

  test("different bodies produce different signatures", () => {
    const h1 = createSignatureHeaders("id1", 1000, '{"a":1}', "secret");
    const h2 = createSignatureHeaders("id1", 1000, '{"a":2}', "secret");

    expect(h1["webhook-signature"]).not.toBe(h2["webhook-signature"]);
  });

  test("different timestamps produce different signatures", () => {
    const h1 = createSignatureHeaders("id1", 1000, '{"a":1}', "secret");
    const h2 = createSignatureHeaders("id1", 2000, '{"a":1}', "secret");

    expect(h1["webhook-signature"]).not.toBe(h2["webhook-signature"]);
  });
});

describe("verifySignature", () => {
  const secret = "verify-test-secret";
  const body = '{"kind":"session.ended"}';

  test("roundtrip: sign then verify succeeds", () => {
    const id = "wh_roundtrip";
    const ts = 1700000000;
    const headers = createSignatureHeaders(id, ts, body, secret);

    const valid = verifySignature(
      id,
      ts,
      body,
      headers["webhook-signature"],
      secret,
      300,
      () => ts * 1000, // clock returns same time in ms
    );

    expect(valid).toBe(true);
  });

  test("tampered body fails verification", () => {
    const id = "wh_tampered";
    const ts = 1700000000;
    const headers = createSignatureHeaders(id, ts, body, secret);

    const valid = verifySignature(
      id,
      ts,
      '{"kind":"session.ended","tampered":true}', // different body
      headers["webhook-signature"],
      secret,
      300,
      () => ts * 1000,
    );

    expect(valid).toBe(false);
  });

  test("tampered timestamp fails verification", () => {
    const id = "wh_ts";
    const ts = 1700000000;
    const headers = createSignatureHeaders(id, ts, body, secret);

    const valid = verifySignature(
      id,
      ts + 1, // different timestamp
      body,
      headers["webhook-signature"],
      secret,
      300,
      () => ts * 1000,
    );

    expect(valid).toBe(false);
  });

  test("wrong secret fails verification", () => {
    const id = "wh_wrong_secret";
    const ts = 1700000000;
    const headers = createSignatureHeaders(id, ts, body, secret);

    const valid = verifySignature(
      id,
      ts,
      body,
      headers["webhook-signature"],
      "wrong-secret",
      300,
      () => ts * 1000,
    );

    expect(valid).toBe(false);
  });

  test("clock skew beyond tolerance fails", () => {
    const id = "wh_skew";
    const ts = 1700000000;
    const headers = createSignatureHeaders(id, ts, body, secret);

    const valid = verifySignature(
      id,
      ts,
      body,
      headers["webhook-signature"],
      secret,
      300,
      () => (ts + 301) * 1000, // 301 seconds later, tolerance is 300
    );

    expect(valid).toBe(false);
  });

  test("clock skew within tolerance succeeds", () => {
    const id = "wh_skew_ok";
    const ts = 1700000000;
    const headers = createSignatureHeaders(id, ts, body, secret);

    const valid = verifySignature(
      id,
      ts,
      body,
      headers["webhook-signature"],
      secret,
      300,
      () => (ts + 299) * 1000, // 299 seconds later, within tolerance
    );

    expect(valid).toBe(true);
  });

  test("invalid signature prefix fails", () => {
    const valid = verifySignature(
      "wh_1",
      1700000000,
      body,
      "v2,invalid",
      secret,
      300,
      () => 1700000000000,
    );

    expect(valid).toBe(false);
  });
});
