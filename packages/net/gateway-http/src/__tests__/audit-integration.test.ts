/**
 * E3 — Audit sink integration tests.
 *
 * Drives the real `createGatewayServer` over Bun.serve and asserts that an
 * in-memory `AuditSink` receives exactly one `AuditEntry` per request, with
 * the metadata fields produced by `buildGatewayRequestEntry` (status,
 * authResult, path, method, channel, remoteAddr) plus the synthetic gateway
 * defaults (schema_version, agentId, turnIndex).
 *
 * Note: `start()` emits a one-shot startup audit (kind=gateway.request,
 * path="/(start)", authResult="skipped"). Each test filters that out and only
 * asserts on entries produced by HTTP traffic.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry, AuditSink } from "@koi/core";
import type { Gateway, GatewayFrame, Session } from "@koi/gateway-types";
import { createGatewayServer } from "../server.js";
import type { ChannelRegistration, GatewayHttpConfig, GatewayServer } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers (intentionally close to pentest.test.ts so the suites stay aligned).
// ---------------------------------------------------------------------------

const SECRET = "test-secret-audit";

function sign(ts: string, body: string, secret: string = SECRET): string {
  const h = createHmac("sha256", secret);
  h.update(`v0:${ts}:${body}`);
  return `v0=${h.digest("hex")}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function tmpLockPath(): string {
  return join(tmpdir(), `koi-audit-${crypto.randomUUID()}.lock`);
}

function makeStubGateway(): Gateway {
  return {
    ingest: async (_s: Session, _f: GatewayFrame): Promise<void> => undefined,
    pauseIngress: () => undefined,
    forceClose: () => undefined,
    activeConnections: () => 0,
  };
}

interface RecordingSink {
  readonly sink: AuditSink;
  readonly entries: AuditEntry[];
}

function makeRecordingSink(): RecordingSink {
  const entries: AuditEntry[] = [];
  return {
    sink: {
      log: async (e: AuditEntry): Promise<void> => {
        entries.push(e);
      },
    },
    entries,
  };
}

function makeStubChannel(
  overrides: Partial<{
    rateLimit: ChannelRegistration["rateLimit"];
    authenticate: ChannelRegistration["authenticate"];
  }> = {},
): ChannelRegistration {
  const base: ChannelRegistration = {
    id: "slack",
    secret: SECRET,
    replayProtection: "nonce",
    authenticate:
      overrides.authenticate ??
      (async (_req, _raw, payload) => {
        const p = payload as { team_id?: unknown };
        const tenantId = typeof p.team_id === "string" ? p.team_id : "T_DEFAULT";
        return { ok: true, value: { agentId: "a", tenantId } };
      }),
    extractDeliveryId: (_req, payload) => {
      const p = payload as { event_id?: unknown };
      return typeof p.event_id === "string" ? p.event_id : undefined;
    },
  };
  return overrides.rateLimit !== undefined ? { ...base, rateLimit: overrides.rateLimit } : base;
}

interface StartedServer {
  readonly server: GatewayServer;
  readonly url: string;
  readonly entries: AuditEntry[];
}

interface MakeServerOpts {
  readonly config?: Partial<GatewayHttpConfig>;
  readonly sink?: AuditSink;
  readonly channel?: ChannelRegistration;
}

async function makeServer(opts: MakeServerOpts = {}): Promise<StartedServer> {
  const recording = makeRecordingSink();
  const sink = opts.sink ?? recording.sink;
  const server = createGatewayServer(
    {
      bind: "127.0.0.1:0",
      lockFilePath: tmpLockPath(),
      ...opts.config,
    },
    { gateway: makeStubGateway(), auditSink: sink },
  );
  const start = await server.start();
  if (!start.ok) throw new Error(`server start failed: ${start.error.message}`);
  const reg = server.registerChannel(opts.channel ?? makeStubChannel());
  if (!reg.ok) throw new Error(`channel register failed: ${reg.error.message}`);
  return { server, url: `http://127.0.0.1:${server.port()}`, entries: recording.entries };
}

interface ReqOpts {
  readonly ts?: string;
  readonly sig?: string;
  readonly nonce?: string;
  readonly contentType?: string;
}

function postWebhook(url: string, body: string, opts: ReqOpts = {}): Promise<Response> {
  const t = opts.ts ?? String(nowSec());
  const s = opts.sig ?? sign(t, body);
  return fetch(`${url}/webhooks/slack/T1`, {
    method: "POST",
    headers: {
      "Content-Type": opts.contentType ?? "application/json",
      "X-Webhook-Timestamp": t,
      "X-Webhook-Signature": s,
      "X-Webhook-Nonce": opts.nonce ?? "n1",
    },
    body,
  });
}

// startup audit is now its own kind=gateway.startup — drop it so tests
// assert only on traffic-driven gateway.request entries.
function requestEntries(entries: readonly AuditEntry[]): AuditEntry[] {
  return entries.filter((e) => e.kind === "gateway.request");
}

interface GatewayMeta {
  readonly status: number;
  readonly authResult: string;
  readonly path: string;
  readonly method: string;
  readonly channel: string | undefined;
  readonly remoteAddr: string | undefined;
}

function meta(entry: AuditEntry): GatewayMeta {
  const m = entry.metadata ?? {};
  return {
    status: m.status as number,
    authResult: m.authResult as string,
    path: m.path as string,
    method: m.method as string,
    channel: m.channel as string | undefined,
    remoteAddr: m.remoteAddr as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("audit-integration", () => {
  let toStop: GatewayServer | undefined;
  afterEach(async () => {
    if (toStop !== undefined) {
      await toStop.stop();
      toStop = undefined;
    }
  });

  test("200 success emits one entry with kind=gateway.request and full metadata", async () => {
    const { server, url, entries } = await makeServer();
    toStop = server;

    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const r = await postWebhook(url, body);
    expect(r.status).toBe(200);

    const reqs = requestEntries(entries);
    expect(reqs.length).toBe(1);
    const e = reqs[0];
    if (e === undefined) throw new Error("missing entry");
    expect(e.kind).toBe("gateway.request");
    expect(e.schema_version).toBe(1);
    expect(e.agentId).toBe("gateway");
    expect(e.turnIndex).toBe(0);

    const m = meta(e);
    expect(m.status).toBe(200);
    expect(m.authResult).toBe("ok");
    expect(m.path).toBe("/webhooks/slack/T1");
    expect(m.method).toBe("POST");
    expect(m.channel).toBe("slack");
    expect(m.remoteAddr).toBe("127.0.0.1");
  });

  test("401 bad HMAC emits status=401 authResult=rejected:auth", async () => {
    const { server, url, entries } = await makeServer();
    toStop = server;
    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const ts = String(nowSec());
    const r = await postWebhook(url, body, { ts, sig: "v0=deadbeef" });
    expect(r.status).toBe(401);

    const reqs = requestEntries(entries);
    expect(reqs.length).toBe(1);
    const m = meta(reqs[0] ?? ({} as AuditEntry));
    expect(m.status).toBe(401);
    expect(m.authResult).toBe("rejected:auth");
    expect(m.path).toBe("/webhooks/slack/T1");
  });

  test("429 source rate limit emits authResult=rejected:rate-limit-source", async () => {
    const { server, url, entries } = await makeServer({
      config: {
        sourceLimit: { capacity: 1, refillPerSec: 0.001 },
      },
    });
    toStop = server;

    const body1 = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const r1 = await postWebhook(url, body1, { nonce: "n1" });
    expect(r1.status).toBe(200);

    const body2 = JSON.stringify({ team_id: "T1", event_id: "e2" });
    const ts2 = String(nowSec() + 1);
    const r2 = await postWebhook(url, body2, { ts: ts2, nonce: "n2" });
    expect(r2.status).toBe(429);

    const reqs = requestEntries(entries);
    expect(reqs.length).toBe(2);
    expect(meta(reqs[0] ?? ({} as AuditEntry)).authResult).toBe("ok");
    const m2 = meta(reqs[1] ?? ({} as AuditEntry));
    expect(m2.status).toBe(429);
    expect(m2.authResult).toBe("rejected:rate-limit-source");
  });

  test("400 INVALID_BODY emits status=400 authResult=rejected:invalid-body", async () => {
    const { server, url, entries } = await makeServer();
    toStop = server;

    const body = `{"team_id":`; // truncated JSON, signed
    const r = await postWebhook(url, body);
    expect(r.status).toBe(400);

    const reqs = requestEntries(entries);
    expect(reqs.length).toBe(1);
    const m = meta(reqs[0] ?? ({} as AuditEntry));
    expect(m.status).toBe(400);
    expect(m.authResult).toBe("rejected:invalid-body");
  });

  test("idempotent replay emits authResult=idempotent-replay on second call", async () => {
    const { server, url, entries } = await makeServer();
    toStop = server;

    const body = JSON.stringify({ team_id: "T1", event_id: "dup-1" });
    const r1 = await postWebhook(url, body, { nonce: "n1" });
    expect(r1.status).toBe(200);

    // Same delivery (event_id), fresh ts + nonce so replay/nonce gates pass.
    const ts2 = String(nowSec() + 1);
    const r2 = await postWebhook(url, body, { ts: ts2, nonce: "n2" });
    expect(r2.status).toBe(200);

    const reqs = requestEntries(entries);
    expect(reqs.length).toBe(2);
    expect(meta(reqs[0] ?? ({} as AuditEntry)).authResult).toBe("ok");
    expect(meta(reqs[1] ?? ({} as AuditEntry)).authResult).toBe("idempotent-replay");
  });

  test("each request results in exactly one audit entry across mixed outcomes", async () => {
    const { server, url, entries } = await makeServer();
    toStop = server;

    // 200, 401 (bad sig), 400 (bad body) — three requests, three entries.
    const okBody = JSON.stringify({ team_id: "T1", event_id: "k1" });
    expect((await postWebhook(url, okBody, { nonce: "n1" })).status).toBe(200);
    expect((await postWebhook(url, okBody, { sig: "v0=deadbeef", nonce: "n2" })).status).toBe(401);
    expect((await postWebhook(url, `{"broken":`, { nonce: "n3" })).status).toBe(400);

    expect(requestEntries(entries).length).toBe(3);
  });

  test("audit sink failure does not break the request", async () => {
    const failing: AuditSink = {
      log: async (): Promise<void> => {
        throw new Error("sink down");
      },
    };
    const { server, url } = await makeServer({ sink: failing });
    toStop = server;

    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const start = Date.now();
    const r = await postWebhook(url, body);
    const elapsed = Date.now() - start;
    expect(r.status).toBe(200);
    // Sink failure shouldn't gate the response on retry/backoff.
    expect(elapsed).toBeLessThan(2_000);
  });
});
