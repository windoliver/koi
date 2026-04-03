import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySlackRequest, verifySlackSignature } from "./verify-signature.js";

/** Computes a valid Slack signature for testing. */
function computeSignature(secret: string, timestamp: string, body: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`v0:${timestamp}:${body}`);
  return `v0=${hmac.digest("hex")}`;
}

/** Returns a Unix epoch timestamp string for "now". */
function nowTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("verifySlackSignature", () => {
  const secret = "8f742231b10e8888abcd99yez67890";

  test("returns true for a valid signature", () => {
    const ts = "1531420618";
    const body = "token=foo&team_id=T1234&text=hello";
    const sig = computeSignature(secret, ts, body);

    expect(verifySlackSignature(secret, ts, body, sig)).toBe(true);
  });

  test("returns false for an invalid signature", () => {
    const ts = "1531420618";
    const body = "token=foo&team_id=T1234&text=hello";

    expect(verifySlackSignature(secret, ts, body, "v0=bad")).toBe(false);
  });

  test("returns false when signature has wrong length", () => {
    const ts = "1531420618";
    const body = "some body";
    // A valid signature is "v0=" + 64 hex chars = 67 chars total
    expect(verifySlackSignature(secret, ts, body, "v0=short")).toBe(false);
  });

  test("returns false for tampered body", () => {
    const ts = "1531420618";
    const body = "original body";
    const sig = computeSignature(secret, ts, body);

    expect(verifySlackSignature(secret, ts, "tampered body", sig)).toBe(false);
  });

  test("returns false for tampered timestamp", () => {
    const ts = "1531420618";
    const body = "original body";
    const sig = computeSignature(secret, ts, body);

    expect(verifySlackSignature(secret, "9999999999", body, sig)).toBe(false);
  });

  test("returns false for wrong secret", () => {
    const ts = "1531420618";
    const body = "some body";
    const sig = computeSignature(secret, ts, body);

    expect(verifySlackSignature("wrong-secret", ts, body, sig)).toBe(false);
  });
});

describe("verifySlackRequest", () => {
  const secret = "test-signing-secret-12345";

  test("returns ok: true for a valid request", async () => {
    const ts = nowTimestamp();
    const body = '{"type":"event_callback","event":{"type":"message"}}';
    const sig = computeSignature(secret, ts, body);

    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sig,
      },
      body,
    });

    const result = await verifySlackRequest(secret, request);
    expect(result.ok).toBe(true);
    expect(result.body).toBe(body);
  });

  test("returns ok: false when timestamp header is missing", async () => {
    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Signature": "v0=abc",
      },
      body: "{}",
    });

    const result = await verifySlackRequest(secret, request);
    expect(result.ok).toBe(false);
  });

  test("returns ok: false when signature header is missing", async () => {
    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": nowTimestamp(),
      },
      body: "{}",
    });

    const result = await verifySlackRequest(secret, request);
    expect(result.ok).toBe(false);
  });

  test("returns ok: false for replay attack (timestamp too old)", async () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 400); // 400s ago, > 300s window
    const body = "{}";
    const sig = computeSignature(secret, oldTs, body);

    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": oldTs,
        "X-Slack-Signature": sig,
      },
      body,
    });

    const result = await verifySlackRequest(secret, request);
    expect(result.ok).toBe(false);
  });

  test("returns ok: false for future timestamp beyond replay window", async () => {
    const futureTs = String(Math.floor(Date.now() / 1000) + 400);
    const body = "{}";
    const sig = computeSignature(secret, futureTs, body);

    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": futureTs,
        "X-Slack-Signature": sig,
      },
      body,
    });

    const result = await verifySlackRequest(secret, request);
    expect(result.ok).toBe(false);
  });

  test("returns ok: true for timestamp within 5-minute window", async () => {
    const recentTs = String(Math.floor(Date.now() / 1000) - 200); // 200s ago, < 300s window
    const body = '{"type":"event_callback"}';
    const sig = computeSignature(secret, recentTs, body);

    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": recentTs,
        "X-Slack-Signature": sig,
      },
      body,
    });

    const result = await verifySlackRequest(secret, request);
    expect(result.ok).toBe(true);
    expect(result.body).toBe(body);
  });

  test("returns ok: false for invalid signature with valid timestamp", async () => {
    const ts = nowTimestamp();
    const body = '{"type":"event_callback"}';

    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": "v0=0000000000000000000000000000000000000000000000000000000000000000",
      },
      body,
    });

    const result = await verifySlackRequest(secret, request);
    expect(result.ok).toBe(false);
    expect(result.body).toBe(body);
  });

  test("returns ok: false for non-numeric timestamp", async () => {
    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": "not-a-number",
        "X-Slack-Signature": "v0=abc",
      },
      body: "{}",
    });

    const result = await verifySlackRequest(secret, request);
    expect(result.ok).toBe(false);
  });
});
