import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySlackRequest, verifySlackSignature } from "./verify-signature.js";

const SECRET = "8f742231b10e8888abcd99yyyzz85a5";

function sign(timestamp: string, body: string, secret: string = SECRET): string {
  const h = createHmac("sha256", secret);
  h.update(`v0:${timestamp}:${body}`);
  return `v0=${h.digest("hex")}`;
}

function nowTs(offsetSec = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSec);
}

describe("verifySlackSignature", () => {
  test("accepts a correctly signed message", () => {
    const ts = nowTs();
    const body = '{"type":"event_callback"}';
    expect(verifySlackSignature(SECRET, ts, body, sign(ts, body))).toBe(true);
  });

  test("rejects a wrong signature", () => {
    const ts = nowTs();
    const body = "x";
    const bad = sign(ts, "different-body");
    expect(verifySlackSignature(SECRET, ts, body, bad)).toBe(false);
  });

  test("rejects mismatched length signature without throwing", () => {
    expect(verifySlackSignature(SECRET, nowTs(), "x", "v0=short")).toBe(false);
  });
});

describe("verifySlackRequest", () => {
  test("ok=true for a valid request and returns the body", async () => {
    const ts = nowTs();
    const body = '{"hello":"world"}';
    const req = new Request("http://x/slack/events", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, body),
      },
      body,
    });
    const r = await verifySlackRequest(SECRET, req);
    expect(r.ok).toBe(true);
    expect(r.body).toBe(body);
  });

  test("ok=false when headers are missing", async () => {
    const req = new Request("http://x/slack/events", { method: "POST", body: "{}" });
    const r = await verifySlackRequest(SECRET, req);
    expect(r.ok).toBe(false);
  });

  test("ok=false when timestamp is older than 5 minutes (replay window)", async () => {
    const ts = nowTs(-301);
    const body = "{}";
    const req = new Request("http://x", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, body),
      },
      body,
    });
    const r = await verifySlackRequest(SECRET, req);
    expect(r.ok).toBe(false);
  });

  test("rejects oversized requests via Content-Length", async () => {
    const ts = nowTs();
    const req = new Request("http://x", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, "ignored"),
        "content-length": "1000000", // 1 MB — well over the 100 KB cap
      },
      body: "x", // tiny placeholder; the guard reads only the header
    });
    const r = await verifySlackRequest(SECRET, req);
    expect(r.ok).toBe(false);
    expect(r.tooLarge).toBe(true);
  });

  test("rejects oversized bodies even when Content-Length is missing or wrong", async () => {
    const ts = nowTs();
    const big = "x".repeat(150_000);
    const req = new Request("http://x", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(ts, big),
        // no content-length header — server has to fall back to length-after-read check
      },
      body: big,
    });
    const r = await verifySlackRequest(SECRET, req);
    expect(r.ok).toBe(false);
    expect(r.tooLarge).toBe(true);
  });

  test("rejects oversized chunked bodies during streaming (no Content-Length)", async () => {
    // Regression: omitted Content-Length used to bypass the up-front guard
    // and force `await request.text()` to buffer the entire payload before
    // the post-read check. Streaming reader must abort mid-stream.
    const ts = nowTs();
    const huge = new Uint8Array(150_000);
    huge.fill(0x78); // 'x'
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(huge);
        c.close();
      },
    });
    const req = new Request("http://x", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": "v0=00",
      },
      body: stream,
    });
    const r = await verifySlackRequest(SECRET, req);
    expect(r.ok).toBe(false);
    expect(r.tooLarge).toBe(true);
  });

  test("ok=false when timestamp is non-numeric", async () => {
    const req = new Request("http://x", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": "not-a-number",
        "X-Slack-Signature": "v0=00",
      },
      body: "{}",
    });
    const r = await verifySlackRequest(SECRET, req);
    expect(r.ok).toBe(false);
  });
});
