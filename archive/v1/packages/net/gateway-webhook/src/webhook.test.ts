import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GatewayFrame, Session } from "@koi/gateway-types";
import type { WebhookAuthenticator, WebhookServer } from "./webhook.js";
import { createWebhookServer } from "./webhook.js";

describe("WebhookServer", () => {
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
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher);
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/webhook/slack/acme`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Peer": "bot-user",
      },
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
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher);
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "GET",
    });

    expect(res.status).toBe(405);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  test("wrong path returns 404", async () => {
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher);
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/other/path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(dispatched).toHaveLength(0);
  });

  test("path prefix boundary: /webhookadmin does not match /webhook", async () => {
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher);
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/webhookadmin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(dispatched).toHaveLength(0);
  });

  test("invalid JSON body returns 400", async () => {
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher);
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  test("payload exceeding maxBodyBytes returns 413", async () => {
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook", maxBodyBytes: 50 }, dispatcher);
    await server.start();

    const largePayload = JSON.stringify({ data: "x".repeat(100) });
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: largePayload,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  test("payload within maxBodyBytes is accepted", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", maxBodyBytes: 500 },
      dispatcher,
    );
    await server.start();

    const smallPayload = JSON.stringify({ ok: true });
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: smallPayload,
    });

    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "test" }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  test("authenticator receives raw body for HMAC verification", async () => {
    let receivedBody = "";
    const authenticator: WebhookAuthenticator = async (_req, rawBody) => {
      receivedBody = rawBody;
      return {
        ok: true,
        value: { agentId: "hmac-agent" },
      };
    };

    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher, authenticator);
    await server.start();

    const payload = JSON.stringify({ secret: "data" });
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    expect(res.status).toBe(200);
    expect(receivedBody).toBe(payload);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.session.agentId).toBe("hmac-agent");
  });

  test("authenticated request uses provided agentId", async () => {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "test" }),
    });

    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    const dispatched0 = dispatched[0];
    expect(dispatched0?.session.agentId).toBe("custom-agent");
    expect(dispatched0?.session.routing?.channel).toBe("custom-channel");
    expect(dispatched0?.session.routing?.peer).toBe("custom-peer");
    expect(dispatched0?.session.metadata).toEqual({ source: "test" });
  });

  test("empty body dispatches with null payload", async () => {
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher);
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.frame.payload).toBeNull();
  });

  test("default peer is 'webhook' when header not set", async () => {
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher);
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    });

    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.session.routing?.peer).toBe("webhook");
  });

  test("path prefix with trailing slash works", async () => {
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook/" }, dispatcher);
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
  });

  test("exact prefix path dispatches with no channel/account", async () => {
    server = createWebhookServer({ port: 0, pathPrefix: "/webhook" }, dispatcher);
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bare: true }),
    });

    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.session.routing?.channel).toBeUndefined();
    expect(dispatched[0]?.session.routing?.account).toBeUndefined();
  });
});
