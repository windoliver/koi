/**
 * E4 — End-to-end shutdown drain tests.
 *
 * Drives `createGatewayServer` over real Bun.serve and verifies the graceful
 * shutdown sequence: in-flight HTTP requests complete during drain, /healthz
 * flips to 503, listener stops accepting new connections, stop() is
 * idempotent, the grace budget is enforced (forceClose), and the PID lock is
 * released on stop.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gateway, GatewayFrame, Session } from "@koi/gateway-types";
import { createGatewayServer } from "../server.js";
import type { ChannelRegistration, GatewayHttpConfig, GatewayServer } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "test-secret-shutdown";

function sign(ts: string, body: string, secret: string = SECRET): string {
  const h = createHmac("sha256", secret);
  h.update(`v0:${ts}:${body}`);
  return `v0=${h.digest("hex")}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function tmpLockPath(): string {
  return join(tmpdir(), `koi-shutdown-${crypto.randomUUID()}.lock`);
}

interface StubGatewayOpts {
  readonly ingestSleepMs?: number;
  readonly ingestNeverResolves?: boolean;
}

interface StubGateway {
  readonly gateway: Gateway;
  readonly ingestCount: () => number;
  readonly forceCloseCount: () => number;
}

function makeStubGateway(opts: StubGatewayOpts = {}): StubGateway {
  let count = 0;
  let forceCount = 0;
  const gateway: Gateway = {
    ingest: async (_s: Session, _f: GatewayFrame): Promise<void> => {
      count++;
      if (opts.ingestNeverResolves === true) {
        await new Promise<void>(() => {
          // Intentional dangling promise; resolved only by process teardown.
        });
        return;
      }
      if (opts.ingestSleepMs !== undefined && opts.ingestSleepMs > 0) {
        await Bun.sleep(opts.ingestSleepMs);
      }
    },
    pauseIngress: () => undefined,
    forceClose: () => {
      forceCount++;
    },
    activeConnections: () => 0,
  };
  return {
    gateway,
    ingestCount: () => count,
    forceCloseCount: () => forceCount,
  };
}

function makeStubChannel(): ChannelRegistration {
  return {
    id: "slack",
    secret: SECRET,
    replayProtection: "nonce",
    authenticate: async (_req, _raw, payload) => {
      const p = payload as { team_id?: unknown };
      const tenantId = typeof p.team_id === "string" ? p.team_id : "T_DEFAULT";
      return { ok: true, value: { agentId: "a", tenantId } };
    },
    extractDeliveryId: (_req, payload) => {
      const p = payload as { event_id?: unknown };
      return typeof p.event_id === "string" ? p.event_id : undefined;
    },
  };
}

interface StartedServer {
  readonly server: GatewayServer;
  readonly url: string;
  readonly stub: StubGateway;
  readonly lockPath: string;
}

interface MakeServerOpts {
  readonly config?: Partial<GatewayHttpConfig>;
  readonly stub?: StubGateway;
}

async function makeServer(opts: MakeServerOpts = {}): Promise<StartedServer> {
  const stub = opts.stub ?? makeStubGateway();
  const lockPath = tmpLockPath();
  const server = createGatewayServer(
    {
      bind: "127.0.0.1:0",
      lockFilePath: lockPath,
      ...opts.config,
    },
    { gateway: stub.gateway },
  );
  const start = await server.start();
  if (!start.ok) throw new Error(`server start failed: ${start.error.message}`);
  const reg = server.registerChannel(makeStubChannel());
  if (!reg.ok) throw new Error(`channel register failed: ${reg.error.message}`);
  return { server, url: `http://127.0.0.1:${server.port()}`, stub, lockPath };
}

interface ReqOpts {
  readonly nonce?: string;
  readonly ts?: string;
}

function postWebhook(url: string, body: string, opts: ReqOpts = {}): Promise<Response> {
  const t = opts.ts ?? String(nowSec());
  return fetch(`${url}/webhooks/slack/T1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Timestamp": t,
      "X-Webhook-Signature": sign(t, body),
      "X-Webhook-Nonce": opts.nonce ?? "n1",
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shutdown.e2e", () => {
  let toStop: GatewayServer | undefined;
  afterEach(async () => {
    if (toStop !== undefined) {
      try {
        await toStop.stop();
      } catch (err: unknown) {
        // Best-effort cleanup; tests assert on stop() behaviour directly.
        void err;
      }
      toStop = undefined;
    }
  });

  test("in-flight HTTP requests complete during drain", async () => {
    const stub = makeStubGateway({ ingestSleepMs: 100 });
    const { server, url } = await makeServer({
      stub,
      config: { shutdownGraceMs: 5_000 },
    });

    // Fire 5 concurrent webhook requests with distinct nonces.
    const ts = String(nowSec());
    const requests: Promise<Response>[] = [];
    for (let i = 0; i < 5; i++) {
      const body = JSON.stringify({ team_id: "T1", event_id: `e${i}` });
      requests.push(postWebhook(url, body, { ts, nonce: `n${i}` }));
    }

    // Yield so the requests reach the slow ingest before we trigger drain.
    await Bun.sleep(30);
    const stopPromise = server.stop();
    toStop = undefined;

    const results = await Promise.all(requests);
    for (const r of results) expect(r.status).toBe(200);
    expect(stub.ingestCount()).toBe(5);
    await stopPromise;
  });

  test("/healthz flips to 503 once drain is in progress", async () => {
    const stub = makeStubGateway({ ingestSleepMs: 500 });
    const { server, url } = await makeServer({
      stub,
      config: { shutdownGraceMs: 5_000 },
    });

    // Start a real webhook that will hold drain open for ~500ms.
    const body = JSON.stringify({ team_id: "T1", event_id: "drain-1" });
    const inflight = postWebhook(url, body, { nonce: "n1" });
    await Bun.sleep(50);

    // Trigger stop without awaiting; healthz should now report draining.
    const stopPromise = server.stop();
    toStop = undefined;
    await Bun.sleep(50);

    const r = await fetch(`${url}/healthz`);
    expect(r.status).toBe(503);
    const j = (await r.json()) as { ok: boolean; draining: boolean };
    expect(j.ok).toBe(false);
    expect(j.draining).toBe(true);

    await inflight;
    await stopPromise;
  });

  test("after stop() resolves, new connections fail", async () => {
    const { server, url } = await makeServer();
    const port = server.port();

    await server.stop();
    toStop = undefined;

    let failed = false;
    try {
      await fetch(`${url}/healthz`);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    void port;
  });

  test("stop() is idempotent", async () => {
    const { server } = await makeServer();
    toStop = undefined;

    const a = server.stop();
    const b = server.stop();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
  });

  test("shutdownGraceMs respected: forceClose called when drain exceeds budget", async () => {
    const stub = makeStubGateway({ ingestNeverResolves: true });
    const { server, url } = await makeServer({
      stub,
      config: { shutdownGraceMs: 200 },
    });

    // Stick a request in dispatch that will never resolve.
    const body = JSON.stringify({ team_id: "T1", event_id: "stuck-1" });
    void postWebhook(url, body, { nonce: "n1" }).catch(() => {
      // Connection is force-closed once stop() exhausts the grace budget.
    });
    await Bun.sleep(50);

    const start = Date.now();
    await server.stop();
    toStop = undefined;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(600);
    expect(stub.forceCloseCount()).toBeGreaterThanOrEqual(1);
  });

  test("PID lock file is released after stop()", async () => {
    const { server, lockPath } = await makeServer();
    expect(existsSync(lockPath)).toBe(true);

    await server.stop();
    toStop = undefined;

    expect(existsSync(lockPath)).toBe(false);
  });
});
