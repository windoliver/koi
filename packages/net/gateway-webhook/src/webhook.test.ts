import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GatewayFrame, Session } from "@koi/gateway-types";
import type { WebhookAuthenticator, WebhookServer } from "./webhook.js";
import { createWebhookServer } from "./webhook.js";

describe("WebhookServer — auth guard", () => {
  test("throws when no authentication is configured", () => {
    expect(() => createWebhookServer({ port: 0, pathPrefix: "/webhook" }, () => {})).toThrow(
      "no authentication configured",
    );
  });

  test("allowUnauthenticated bypasses the guard (testing only)", () => {
    expect(() =>
      createWebhookServer(
        { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
        () => {},
      ),
    ).not.toThrow();
  });

  test("authenticator satisfies the guard", () => {
    const auth: WebhookAuthenticator = async () => ({
      ok: true,
      value: { agentId: "test" },
    });
    expect(() =>
      createWebhookServer({ port: 0, pathPrefix: "/webhook" }, () => {}, auth),
    ).not.toThrow();
  });
});

describe("WebhookServer — core dispatch", () => {
  let server: WebhookServer;
  const dispatched: Array<{ session: Session; frame: GatewayFrame }> = [];

  function dispatcher(session: Session, frame: GatewayFrame): void {
    dispatched.push({ session, frame });
  }

  beforeEach(() => {
    dispatched.length = 0;
  });

  afterEach(() => {
    server?.stop();
  });

  test("POST dispatches frame with correct channel/account/peer", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/webhook/slack/acme`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Peer": "bot-user" },
      body: JSON.stringify({ event: "message", text: "hello" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; frameId: string };
    expect(body.ok).toBe(true);
    expect(typeof body.frameId).toBe("string");
    expect(dispatched).toHaveLength(1);
    const entry = dispatched[0];
    expect(entry?.session.routing?.channel).toBe("slack");
    expect(entry?.session.routing?.account).toBe("acme");
    expect(entry?.session.routing?.peer).toBe("bot-user");
    expect(entry?.frame.kind).toBe("event");
    expect(entry?.frame.payload).toEqual({ event: "message", text: "hello" });
  });

  test("non-POST returns 405", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, { method: "GET" });
    expect(res.status).toBe(405);
    expect(dispatched).toHaveLength(0);
  });

  test("wrong path returns 404", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/other`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(dispatched).toHaveLength(0);
  });

  test("path prefix boundary: /webhookadmin does not match /webhook", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhookadmin`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(dispatched).toHaveLength(0);
  });

  test("invalid JSON body returns 400", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid",
    });
    expect(res.status).toBe(400);
    expect(dispatched).toHaveLength(0);
  });

  test("payload exceeding maxBodyBytes returns 413", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", maxBodyBytes: 50, allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      body: JSON.stringify({ data: "x".repeat(100) }),
    });
    expect(res.status).toBe(413);
    expect(dispatched).toHaveLength(0);
  });

  test("payload within maxBodyBytes is accepted", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", maxBodyBytes: 500, allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
  });

  test("default peer is 'webhook' when header not set", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      body: JSON.stringify({ test: true }),
    });
    expect(res.status).toBe(200);
    expect(dispatched[0]?.session.routing?.peer).toBe("webhook");
  });

  test("path prefix with trailing slash works", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook/", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
  });

  test("exact prefix path dispatches with no channel/account", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook`, {
      method: "POST",
      body: JSON.stringify({ bare: true }),
    });
    expect(res.status).toBe(200);
    expect(dispatched[0]?.session.routing?.channel).toBeUndefined();
    expect(dispatched[0]?.session.routing?.account).toBeUndefined();
  });

  test("empty body dispatches with null payload", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(dispatched[0]?.frame.payload).toBeNull();
  });
});

describe("WebhookServer — authenticator", () => {
  let server: WebhookServer;
  const dispatched: Array<{ session: Session; frame: GatewayFrame }> = [];

  function dispatcher(session: Session, frame: GatewayFrame): void {
    dispatched.push({ session, frame });
  }

  beforeEach(() => {
    dispatched.length = 0;
  });

  afterEach(() => {
    server?.stop();
  });

  test("authenticator rejection returns 401", async () => {
    const authenticator: WebhookAuthenticator = async () => ({
      ok: false,
      error: { code: "PERMISSION" as const, message: "Not authorized", retryable: false },
    });
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher, authenticator);
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      body: JSON.stringify({ data: "test" }),
    });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  test("authenticator receives raw body for HMAC verification", async () => {
    let receivedBody = "";
    const authenticator: WebhookAuthenticator = async (_req, rawBody) => {
      receivedBody = rawBody;
      return { ok: true, value: { agentId: "hmac-agent" } };
    };
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher, authenticator);
    await server.start();
    const payload = JSON.stringify({ secret: "data" });
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(receivedBody).toBe(payload);
    expect(dispatched[0]?.session.agentId).toBe("hmac-agent");
  });

  test("authenticated request uses provided agentId + routing + metadata", async () => {
    const authenticator: WebhookAuthenticator = async () => ({
      ok: true,
      value: {
        agentId: "custom-agent",
        routing: { channel: "custom-channel", peer: "custom-peer" },
        metadata: { source: "test" },
      },
    });
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher, authenticator);
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      body: JSON.stringify({ data: "test" }),
    });
    expect(res.status).toBe(200);
    const d = dispatched[0];
    expect(d?.session.agentId).toBe("custom-agent");
    expect(d?.session.routing?.channel).toBe("custom-channel");
    expect(d?.session.routing?.peer).toBe("custom-peer");
    expect(d?.session.metadata).toEqual({ source: "test" });
  });
});

describe("WebhookServer — provider routing", () => {
  let server: WebhookServer;
  const dispatched: Array<{ session: Session; frame: GatewayFrame }> = [];

  function dispatcher(session: Session, frame: GatewayFrame): void {
    dispatched.push({ session, frame });
  }

  beforeEach(() => {
    dispatched.length = 0;
  });

  afterEach(() => {
    server?.stop();
  });

  test("unknown provider returns 400", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      dispatcher,
      undefined,
      { github: "secret" },
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/twitter`, {
      method: "POST",
      body: JSON.stringify({ event: "tweet" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Unknown webhook provider");
    expect(dispatched).toHaveLength(0);
  });

  test("missing secret for known provider returns 401", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      dispatcher,
      undefined,
      { github: "secret" }, // no slack secret
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      body: JSON.stringify({ action: "message" }),
    });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  test("invalid signature returns 401", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      dispatcher,
      undefined,
      { github: "real-secret" },
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/github`, {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha256=badhex" },
      body: JSON.stringify({ action: "push" }),
    });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });
});

describe("WebhookServer — idempotency (commit-after-success)", () => {
  let server: WebhookServer;
  const dispatched: Array<{ session: Session; frame: GatewayFrame }> = [];

  function dispatcher(session: Session, frame: GatewayFrame): void {
    dispatched.push({ session, frame });
  }

  beforeEach(() => {
    dispatched.length = 0;
  });

  afterEach(() => {
    server?.stop();
  });

  test("duplicate GitHub delivery is detected after successful dispatch", async () => {
    const secret = "test-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);

    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      dispatcher,
      undefined,
      { github: secret },
    );
    await server.start();

    const headers = {
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": "unique-delivery-id-abc",
      "Content-Type": "application/json",
    };

    // First delivery — succeeds and commits dedup key
    const res1 = await fetch(`http://localhost:${server.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res1.status).toBe(200);
    const b1 = (await res1.json()) as { ok: boolean; duplicate?: boolean };
    expect(b1.ok).toBe(true);
    expect(b1.duplicate).toBeUndefined();
    expect(dispatched).toHaveLength(1);

    // Duplicate delivery — detected, returns 200 without re-dispatching
    const res2 = await fetch(`http://localhost:${server.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { ok: boolean; duplicate?: boolean };
    expect(b2.ok).toBe(true);
    expect(b2.duplicate).toBe(true);
    expect(dispatched).toHaveLength(1); // not re-dispatched
  });

  test("failed dispatch does not commit dedup key — retry is accepted", async () => {
    const secret = "test-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);

    let dispatchCount = 0;
    function failingDispatcher(_session: Session, _frame: GatewayFrame): void {
      dispatchCount++;
      if (dispatchCount === 1) throw new Error("transient failure");
    }

    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      failingDispatcher,
      undefined,
      { github: secret },
    );
    await server.start();

    const headers = {
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": "retry-delivery-id",
      "Content-Type": "application/json",
    };

    // First delivery — dispatch fails → dedup key NOT committed
    const res1 = await fetch(`http://localhost:${server.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res1.status).toBe(500);

    // Provider retry — should be accepted (not treated as duplicate)
    const res2 = await fetch(`http://localhost:${server.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { ok: boolean; duplicate?: boolean };
    expect(b2.ok).toBe(true);
    expect(b2.duplicate).toBeUndefined();
    expect(dispatchCount).toBe(2);
  });

  test("duplicate Stripe event is deduplicated by event.id from payload", async () => {
    const secret = "stripe-secret";
    const eventId = "evt_test_123abc";
    const stripeBody = JSON.stringify({ id: eventId, type: "payment_intent.succeeded" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sigStr = `${ts}.${stripeBody}`;
    const stripeSig = `t=${ts},v1=${await computeHmacHex(secret, sigStr)}`;

    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      dispatcher,
      undefined,
      { stripe: secret },
    );
    await server.start();

    const headers = { "Stripe-Signature": stripeSig, "Content-Type": "application/json" };

    const res1 = await fetch(`http://localhost:${server.port()}/webhook/stripe`, {
      method: "POST",
      headers,
      body: stripeBody,
    });
    expect(res1.status).toBe(200);
    expect(dispatched).toHaveLength(1);

    // Stripe retry — same body, new timestamp+sig would be a real retry but same event.id
    // Simulate with same ts (simplest way to verify dedup key)
    const res2 = await fetch(`http://localhost:${server.port()}/webhook/stripe`, {
      method: "POST",
      headers,
      body: stripeBody,
    });
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { ok: boolean; duplicate?: boolean };
    expect(b2.duplicate).toBe(true);
    expect(dispatched).toHaveLength(1);
  });

  test("duplicate Slack Events API event is deduplicated by event_id", async () => {
    const secret = "slack-secret";
    const slackBody = JSON.stringify({
      type: "event_callback",
      event_id: "Ev0123456789",
      event: { type: "message", text: "hello" },
    });
    const ts = Math.floor(Date.now() / 1000).toString();
    const slackSig = `v0=${await computeHmacHex(secret, `v0:${ts}:${slackBody}`)}`;

    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      dispatcher,
      undefined,
      { slack: secret },
    );
    await server.start();

    const headers = {
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": slackSig,
      "Content-Type": "application/json",
    };

    const res1 = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers,
      body: slackBody,
    });
    expect(res1.status).toBe(200);
    expect(dispatched).toHaveLength(1);

    // Slack retry — same event_id
    const res2 = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers,
      body: slackBody,
    });
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { ok: boolean; duplicate?: boolean };
    expect(b2.duplicate).toBe(true);
    expect(dispatched).toHaveLength(1);
  });

  test("authenticator failure after dedup reservation aborts key — retry is accepted", async () => {
    const secret = "test-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);

    let authCallCount = 0;
    const flakyAuthenticator: WebhookAuthenticator = async (_req, _raw) => {
      authCallCount++;
      if (authCallCount === 1) {
        return {
          ok: false,
          error: { code: "AUTH_REQUIRED", message: "auth backend down", retryable: true },
        };
      }
      return { ok: true, value: { agentId: "webhook" } };
    };

    const srv = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      dispatcher,
      flakyAuthenticator,
      { github: secret },
    );
    await srv.start();

    const headers = {
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": "auth-fail-delivery-id",
      "Content-Type": "application/json",
    };

    // First delivery — authenticator fails → dedup key must be aborted
    const res1 = await fetch(`http://localhost:${srv.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res1.status).toBe(401);
    expect(dispatched).toHaveLength(0);

    // Retry — same delivery ID — must NOT be treated as duplicate
    const res2 = await fetch(`http://localhost:${srv.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { ok: boolean; duplicate?: boolean };
    expect(b2.ok).toBe(true);
    expect(b2.duplicate).toBeUndefined();
    expect(dispatched).toHaveLength(1);
    srv.stop();
  });

  test("async dispatcher rejection aborts dedup key — retry is accepted", async () => {
    const secret = "test-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);

    let dispatchCount = 0;
    async function asyncFailingDispatcher(_session: Session, _frame: GatewayFrame): Promise<void> {
      dispatchCount++;
      if (dispatchCount === 1) throw new Error("async transient failure");
    }

    const srv = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      asyncFailingDispatcher,
      undefined,
      { github: secret },
    );
    await srv.start();

    const headers = {
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": "async-fail-delivery-id",
      "Content-Type": "application/json",
    };

    // First delivery — async dispatcher rejects → dedup key aborted
    const res1 = await fetch(`http://localhost:${srv.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res1.status).toBe(500);

    // Retry — must be accepted, not treated as duplicate
    const res2 = await fetch(`http://localhost:${srv.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { ok: boolean; duplicate?: boolean };
    expect(b2.ok).toBe(true);
    expect(b2.duplicate).toBeUndefined();
    expect(dispatchCount).toBe(2);
    srv.stop();
  });
});

// ---------------------------------------------------------------------------
// Test helper — compute GitHub HMAC sig
// ---------------------------------------------------------------------------

async function computeHmacHex(secret: string, message: string): Promise<string> {
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

async function computeGitHubSig(secret: string, body: string): Promise<string> {
  return `sha256=${await computeHmacHex(secret, body)}`;
}
