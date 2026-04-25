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

  test("throws when github provider configured without keyExtractor", () => {
    expect(() =>
      createWebhookServer(
        { port: 0, pathPrefix: "/webhook", providerRouting: true },
        () => {},
        undefined,
        { github: "secret" },
      ),
    ).toThrow("replay protection");
  });

  test("allowReplayableProviders bypasses the github/generic dedup guard", () => {
    expect(() =>
      createWebhookServer(
        { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
        () => {},
        undefined,
        { github: "secret" },
      ),
    ).not.toThrow();
  });

  test("keyExtractor satisfies the github/generic dedup guard", () => {
    expect(() =>
      createWebhookServer(
        {
          port: 0,
          pathPrefix: "/webhook",
          providerRouting: true,
          keyExtractor: (_p, req) => req.headers.get("X-GitHub-Delivery") ?? undefined,
        },
        () => {},
        undefined,
        { github: "secret" },
      ),
    ).not.toThrow();
  });

  test("slack and stripe providers do not trigger the replay guard", () => {
    expect(() =>
      createWebhookServer(
        { port: 0, pathPrefix: "/webhook", providerRouting: true },
        () => {},
        undefined,
        { slack: "secret", stripe: "secret2" },
      ),
    ).not.toThrow();
  });

  test("throws when custom idempotencyStore is provided without leaseRenewalMs", () => {
    const store = {
      tryBegin: (_key: string) => ({ state: "ok" as const, token: "t" }),
      renew: (_key: string, _token: string) => false,
      commit: (_key: string, _token: string) => {},
      abort: (_key: string, _token: string) => {},
      prune: () => {},
    };
    expect(() =>
      createWebhookServer(
        { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true, idempotencyStore: store },
        () => {},
      ),
    ).toThrow("leaseRenewalMs is required");
  });

  test("custom idempotencyStore with leaseRenewalMs does not throw", () => {
    const store = {
      tryBegin: (_key: string) => ({ state: "ok" as const, token: "t" }),
      renew: (_key: string, _token: string) => false,
      commit: (_key: string, _token: string) => {},
      abort: (_key: string, _token: string) => {},
      prune: () => {},
    };
    expect(() =>
      createWebhookServer(
        {
          port: 0,
          pathPrefix: "/webhook",
          allowUnauthenticated: true,
          idempotencyStore: store,
          leaseRenewalMs: 150_000,
        },
        () => {},
      ),
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

  test("non-JSON body is accepted — dispatched with raw string as payload", async () => {
    // Slack slash commands / form-encoded payloads must not be rejected at the
    // transport layer. The raw body is dispatched as-is so providers can interpret it.
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "command=%2Fecho&text=hello",
    });
    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.frame.payload).toBe("command=%2Fecho&text=hello");
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

  test("peer is undefined when X-Webhook-Peer header not set", async () => {
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
    expect(dispatched[0]?.session.routing?.peer).toBeUndefined();
  });

  test("X-Webhook-Peer is trusted on allowUnauthenticated paths", async () => {
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: { "X-Webhook-Peer": "internal-service" },
      body: JSON.stringify({ test: true }),
    });
    expect(res.status).toBe(200);
    expect(dispatched[0]?.session.routing?.peer).toBe("internal-service");
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

  test("provider route with account segment + shared secret rejects 401 without authenticator", async () => {
    // Shared provider secret cannot bind account segment — reject to prevent
    // silent cross-tenant misrouting in multi-tenant deployments.
    const secret = "test-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
      dispatcher,
      undefined,
      { github: secret },
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/github/my-tenant`, {
      method: "POST",
      headers: { "X-Hub-Signature-256": sig, "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
    const b = (await res.json()) as { ok: boolean; error: string };
    expect(b.error).toContain("per-account secret");
    expect(dispatched).toHaveLength(0);
  });

  test("provider route with account segment + per-account secret map accepts and binds account", async () => {
    const secret = "tenant-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
      dispatcher,
      undefined,
      { github: { "my-tenant": secret } },
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/github/my-tenant`, {
      method: "POST",
      headers: { "X-Hub-Signature-256": sig, "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(dispatched[0]?.session.routing?.account).toBe("my-tenant");
  });

  test("authenticator cannot override provider-authenticated account — per-account secret wins", async () => {
    // When account is verified by a per-account secret map, an authenticator that
    // returns a different routing.account must not reroute the event to a different tenant.
    const secretA = "secret-a";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secretA, body);
    const maliciousAuthenticator: WebhookAuthenticator = async () => ({
      ok: true,
      value: { agentId: "webhook", routing: { account: "tenant-b" } }, // tries to override to tenant-b
    });
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
      dispatcher,
      maliciousAuthenticator,
      { github: { "tenant-a": secretA } }, // per-account secret for tenant-a
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/github/tenant-a`, {
      method: "POST",
      headers: { "X-Hub-Signature-256": sig, "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    // account must remain tenant-a (from verified secret), not tenant-b (from authenticator)
    expect(dispatched[0]?.session.routing?.account).toBe("tenant-a");
  });

  test("authenticator without account binding rejects account-scoped URL with shared secret", async () => {
    // An authenticator that doesn't bind routing.account cannot authorize account paths
    // when the provider secret is shared (not per-account). The URL account is not
    // verified by the signature, so accepting it without explicit binding is unsafe.
    const secret = "test-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);
    const ignorantAuthenticator: WebhookAuthenticator = async () => ({
      ok: true,
      value: { agentId: "webhook" }, // no routing.account set
    });
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
      dispatcher,
      ignorantAuthenticator,
      { github: secret },
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/github/some-tenant`, {
      method: "POST",
      headers: { "X-Hub-Signature-256": sig, "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  test("authenticator that explicitly binds routing.account accepts account-scoped URL", async () => {
    const secret = "test-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);
    const bindingAuthenticator: WebhookAuthenticator = async (req) => {
      const urlAccount = new URL(req.url).pathname.split("/")[3]; // extract from path
      return {
        ok: true,
        value: { agentId: "webhook", routing: { account: urlAccount } },
      };
    };
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
      dispatcher,
      bindingAuthenticator,
      { github: secret },
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/github/my-org`, {
      method: "POST",
      headers: { "X-Hub-Signature-256": sig, "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(dispatched[0]?.session.routing?.account).toBe("my-org");
  });

  test("dedup keys are scoped by provider+account — same Slack event_id from two tenants dispatches both", async () => {
    // Two Slack tenants with different secrets should have independent dedup spaces.
    // If keys were unscoped, the second delivery would be incorrectly blocked as duplicate.
    const secretA = "secret-tenant-a";
    const secretB = "secret-tenant-b";
    const eventId = "Ev_shared_id"; // same event_id across both tenants
    const body = JSON.stringify({ event_id: eventId, type: "event_callback" });

    async function slackSig(secret: string, b: string): Promise<{ sig: string; ts: string }> {
      const ts = Math.floor(Date.now() / 1000).toString();
      const hex = await computeHmacHex(secret, `v0:${ts}:${b}`);
      return { sig: `v0=${hex}`, ts };
    }

    const { sig: sigA, ts: tsA } = await slackSig(secretA, body);
    const { sig: sigB, ts: tsB } = await slackSig(secretB, body);

    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      dispatcher,
      undefined,
      { slack: { "tenant-a": secretA, "tenant-b": secretB } },
    );
    await server.start();

    const resA = await fetch(`http://localhost:${server.port()}/webhook/slack/tenant-a`, {
      method: "POST",
      headers: {
        "X-Slack-Signature": sigA,
        "X-Slack-Request-Timestamp": tsA,
        "Content-Type": "application/json",
      },
      body,
    });
    expect(resA.status).toBe(200);

    const resB = await fetch(`http://localhost:${server.port()}/webhook/slack/tenant-b`, {
      method: "POST",
      headers: {
        "X-Slack-Signature": sigB,
        "X-Slack-Request-Timestamp": tsB,
        "Content-Type": "application/json",
      },
      body,
    });
    expect(resB.status).toBe(200);
    const bB = (await resB.json()) as { ok: boolean; duplicate?: boolean };
    expect(bB.duplicate).toBeUndefined(); // not a duplicate — different tenant
    expect(dispatched).toHaveLength(2); // both dispatched
  });

  test("X-Webhook-Peer is ignored on provider-routed requests", async () => {
    const secret = "test-secret";
    const body = JSON.stringify({ id: "Ev1", type: "event_callback" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sigPayload = `v0:${ts}:${body}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const rawSig = await crypto.subtle.sign("HMAC", key, enc.encode(sigPayload));
    const hex = Array.from(new Uint8Array(rawSig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const sig = `v0=${hex}`;

    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      dispatcher,
      undefined,
      { slack: secret },
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: {
        "X-Slack-Signature": sig,
        "X-Slack-Request-Timestamp": ts,
        "Content-Type": "application/json",
        "X-Webhook-Peer": "spoofed-peer",
      },
      body,
    });
    expect(res.status).toBe(200);
    // Peer must be ignored on provider-routed requests — not trusted from header
    expect(dispatched[0]?.session.routing?.peer).toBeUndefined();
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

  test("authenticator partial routing merges into verified baseline — does not erase channel", async () => {
    // Authenticator only sets peer — channel from URL path must be preserved.
    const authenticator: WebhookAuthenticator = async () => ({
      ok: true,
      value: { agentId: "merged-agent", routing: { peer: "auth-peer" } },
    });
    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", allowUnauthenticated: true },
      dispatcher,
      authenticator,
    );
    await server.start();
    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      body: JSON.stringify({ test: true }),
    });
    expect(res.status).toBe(200);
    const d = dispatched[0];
    expect(d?.session.routing?.channel).toBe("slack"); // preserved from URL
    expect(d?.session.routing?.peer).toBe("auth-peer"); // set by authenticator
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
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
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
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
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
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
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

  test("GitHub provider dispatches both deliveries — no provider-level dedup (no signed event ID)", async () => {
    // GitHub does not provide a signed delivery ID, so the provider returns no
    // dedup key. Both deliveries are accepted and dispatched. Callers that need
    // GitHub-level dedup must inject a custom IdempotencyStore.
    const secret = "test-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);

    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
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

    // First delivery
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

    // Second delivery (same payload) — no dedup key, so this is dispatched again
    const res2 = await fetch(`http://localhost:${server.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { ok: boolean; duplicate?: boolean };
    expect(b2.ok).toBe(true);
    expect(b2.duplicate).toBeUndefined();
    expect(dispatched).toHaveLength(2); // both dispatched
  });

  test("concurrent duplicate returns 503 (in-flight) not 200", async () => {
    // A provider retry that arrives while the first request is still processing
    // must NOT get a 200 duplicate response. The first request may fail later,
    // and a premature 200 would cause the provider to stop retrying.
    // Use a custom store that pretends the key is in-flight.
    const inFlightStore = {
      tryBegin: (_key: string) => ({ state: "in-flight" as const }),
      renew: (_key: string, _token: string) => false,
      commit: (_key: string, _token: string) => {},
      abort: (_key: string, _token: string) => {},
      prune: () => {},
    };
    const secret = "test-secret";
    const body = JSON.stringify({ event_id: "Ev1", type: "event_callback" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sigPayload = `v0:${ts}:${body}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const rawSig = await crypto.subtle.sign("HMAC", key, enc.encode(sigPayload));
    const hex = Array.from(new Uint8Array(rawSig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const sig = `v0=${hex}`;

    server = createWebhookServer(
      {
        port: 0,
        pathPrefix: "/webhook",
        providerRouting: true,
        idempotencyStore: inFlightStore,
        leaseRenewalMs: 150_000,
      },
      dispatcher,
      undefined,
      { slack: secret },
    );
    await server.start();

    const res = await fetch(`http://localhost:${server.port()}/webhook/slack`, {
      method: "POST",
      headers: {
        "X-Slack-Signature": sig,
        "X-Slack-Request-Timestamp": ts,
        "Content-Type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(503);
    const b = (await res.json()) as { ok: boolean; error: string };
    expect(b.ok).toBe(false);
    expect(b.error).toContain("in-flight");
    expect(dispatched).toHaveLength(0);
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
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
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
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
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

    // First delivery — authenticator returns retryable error → 503, dedup key must be aborted
    const res1 = await fetch(`http://localhost:${srv.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res1.status).toBe(503);
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
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
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

  test("throwing authenticator aborts dedup reservation — retry is accepted", async () => {
    const secret = "test-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);
    const dispatched2: Array<unknown> = [];

    let authCallCount = 0;
    const throwingAuthenticator: WebhookAuthenticator = async () => {
      authCallCount++;
      if (authCallCount === 1) throw new Error("auth backend timeout");
      return { ok: true, value: { agentId: "webhook" } };
    };

    const srv = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true, allowReplayableProviders: true },
      (_session, _frame) => {
        dispatched2.push(1);
      },
      throwingAuthenticator,
      { github: secret },
    );
    await srv.start();

    const headers = {
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": "auth-throw-delivery-id",
      "Content-Type": "application/json",
    };

    // First delivery — authenticator throws → 503, dedup key must be aborted
    const res1 = await fetch(`http://localhost:${srv.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res1.status).toBe(503);

    // Retry — same delivery ID — must NOT be treated as duplicate (key was aborted)
    const res2 = await fetch(`http://localhost:${srv.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res2.status).toBe(200);
    expect(dispatched2).toHaveLength(1);
    srv.stop();
  });
});

// ---------------------------------------------------------------------------
// keyExtractor — per-provider replay protection for GitHub/generic
// ---------------------------------------------------------------------------

describe("WebhookServer — keyExtractor", () => {
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

  test("keyExtractor enables dedup for GitHub provider via X-GitHub-Delivery header", async () => {
    const secret = "gh-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);
    const deliveryId = "unique-delivery-abc";

    server = createWebhookServer(
      {
        port: 0,
        pathPrefix: "/webhook",
        providerRouting: true,
        keyExtractor: (_provider, req) => req.headers.get("X-GitHub-Delivery") ?? undefined,
      },
      dispatcher,
      undefined,
      { github: secret },
    );
    await server.start();

    const headers = {
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": deliveryId,
      "Content-Type": "application/json",
    };

    // First delivery
    const res1 = await fetch(`http://localhost:${server.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res1.status).toBe(200);
    expect(dispatched).toHaveLength(1);

    // Retry with same delivery ID — should be deduplicated
    const res2 = await fetch(`http://localhost:${server.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { ok: boolean; duplicate?: boolean };
    expect(b2.duplicate).toBe(true);
    expect(dispatched).toHaveLength(1); // not re-dispatched
  });

  test("keyExtractor returning undefined skips dedup — delivery is always accepted", async () => {
    const secret = "gh-secret";
    const body = JSON.stringify({ action: "push" });
    const sig = await computeGitHubSig(secret, body);

    server = createWebhookServer(
      {
        port: 0,
        pathPrefix: "/webhook",
        providerRouting: true,
        keyExtractor: () => undefined, // no key — no dedup
      },
      dispatcher,
      undefined,
      { github: secret },
    );
    await server.start();

    const headers = {
      "X-Hub-Signature-256": sig,
      "Content-Type": "application/json",
    };

    const res1 = await fetch(`http://localhost:${server.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res1.status).toBe(200);
    const res2 = await fetch(`http://localhost:${server.port()}/webhook/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(res2.status).toBe(200);
    expect(dispatched).toHaveLength(2); // both dispatched — no dedup
  });
});

// ---------------------------------------------------------------------------
// Generic provider — built-in dedup via verified X-Webhook-ID
// ---------------------------------------------------------------------------

describe("WebhookServer — generic provider dedup", () => {
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

  async function computeGenericSig(
    secret: string,
    webhookId: string,
    timestamp: string,
    body: string,
  ): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signingString = `${webhookId}.${timestamp}.${body}`;
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingString));
    return `v1,${Buffer.from(sig).toString("base64")}`;
  }

  test("generic provider deduplicates via verified X-Webhook-ID without keyExtractor", async () => {
    const secret = "test-secret";
    const webhookId = "wh_abc123";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ event: "created" });
    const sig = await computeGenericSig(secret, webhookId, timestamp, body);

    server = createWebhookServer(
      { port: 0, pathPrefix: "/webhook", providerRouting: true },
      dispatcher,
      undefined,
      { generic: secret },
    );
    await server.start();

    const headers = {
      "X-Webhook-Signature": sig,
      "X-Webhook-ID": webhookId,
      "X-Webhook-Timestamp": timestamp,
      "Content-Type": "application/json",
    };

    const res1 = await fetch(`http://localhost:${server.port()}/webhook/generic`, {
      method: "POST",
      headers,
      body,
    });
    expect(res1.status).toBe(200);
    expect(dispatched).toHaveLength(1);

    // Duplicate — same webhook ID — must be deduplicated
    const res2 = await fetch(`http://localhost:${server.port()}/webhook/generic`, {
      method: "POST",
      headers,
      body,
    });
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { ok: boolean; duplicate?: boolean };
    expect(b2.duplicate).toBe(true);
    expect(dispatched).toHaveLength(1); // not dispatched again
  });
});

// ---------------------------------------------------------------------------
// maxDispatchMs — timeout aborts lease and voids replay protection
// ---------------------------------------------------------------------------

describe("WebhookServer — maxDispatchMs", () => {
  afterEach(() => {});

  test("maxDispatchMs stops renewal but slow-success dispatch commits and returns 200", async () => {
    // Dispatcher takes longer than maxDispatchMs — simulates a slow but healthy handler.
    // Server should return 200 (commit) since the handler succeeded — the provider
    // must not retry and cause duplicate side effects.
    // Uses generic provider which provides a built-in dedupKey via X-Webhook-ID.
    const secret = "test-secret";
    const webhookId = "wh_timeout_test";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ action: "test" });
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const rawSig = await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(`${webhookId}.${timestamp}.${body}`),
    );
    const sig = `v1,${Buffer.from(rawSig).toString("base64")}`;

    let resolveDispatch!: () => void;
    const dispatchGate = new Promise<void>((res) => {
      resolveDispatch = res;
    });

    const srv = createWebhookServer(
      {
        port: 0,
        pathPrefix: "/webhook",
        providerRouting: true,
        maxDispatchMs: 20,
      },
      async () => {
        await dispatchGate; // blocks until we resolve it after timeout
      },
      undefined,
      { generic: secret },
    );
    await srv.start();

    const fetchPromise = fetch(`http://localhost:${srv.port()}/webhook/generic`, {
      method: "POST",
      headers: {
        "X-Webhook-Signature": sig,
        "X-Webhook-ID": webhookId,
        "X-Webhook-Timestamp": timestamp,
        "Content-Type": "application/json",
      },
      body,
    });

    // Wait for timeout to fire (maxDispatchMs=20ms), then unblock dispatcher
    await new Promise<void>((res) => setTimeout(res, 50));
    resolveDispatch();

    const res = await fetchPromise;
    // Slow but successful: must commit (200), not abort (503)
    expect(res.status).toBe(200);
    const b = (await res.json()) as { ok: boolean; frameId: string };
    expect(b.ok).toBe(true);
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
