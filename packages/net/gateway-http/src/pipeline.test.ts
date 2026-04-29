import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createChannelRegistry } from "./channel.js";
import { DEFAULT_GATEWAY_HTTP_CONFIG } from "./defaults.js";
import { createIdempotencyStore } from "./idempotency.js";
import { createNonceStore } from "./nonce.js";
import { type PipelineDeps, runPipeline } from "./pipeline.js";
import { createRateLimitStore } from "./rate-limit.js";
import type { ChannelRegistration, GatewayHttpConfig, RateLimitConfig } from "./types.js";

const SECRET = "shh";

function sign(ts: string, body: string, secret: string = SECRET): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
}

function makeReg(overrides: Partial<ChannelRegistration> = {}): ChannelRegistration {
  return {
    id: "slack",
    secret: SECRET,
    replayProtection: "nonce",
    authenticate: async (_req, _raw, payload) => {
      const p = payload as { team_id?: unknown };
      if (typeof p.team_id !== "string") {
        return {
          ok: false,
          error: { code: "PERMISSION", message: "no team_id", retryable: false },
        };
      }
      return { ok: true, value: { agentId: "a", tenantId: p.team_id } };
    },
    extractDeliveryId: (_req, payload) => {
      const p = payload as { event_id?: unknown };
      return typeof p.event_id === "string" ? p.event_id : undefined;
    },
    ...overrides,
  };
}

interface DepsOverrides {
  readonly config?: Partial<GatewayHttpConfig>;
  readonly reg?: ChannelRegistration;
  readonly dispatch?: PipelineDeps["dispatch"];
  readonly audit?: PipelineDeps["audit"];
  readonly sourceAddr?: string;
  readonly inFlight?: { count: number };
  readonly now?: number;
}

function makeDeps(overrides: DepsOverrides = {}): PipelineDeps {
  const now = overrides.now ?? 1_730_000_000_000;
  const channels = createChannelRegistry();
  channels.register(overrides.reg ?? makeReg());
  const config: GatewayHttpConfig = { ...DEFAULT_GATEWAY_HTTP_CONFIG, ...overrides.config };
  return {
    config,
    channels,
    rateLimits: createRateLimitStore(() => now),
    nonces: createNonceStore({ perTenantCapacity: 100, maxTenants: 100 }),
    idempotency: createIdempotencyStore(
      { perTenantCapacity: 100, maxTenants: 100, ttlSeconds: 86_400 },
      () => now,
    ),
    clock: () => now,
    dispatch: overrides.dispatch ?? (async () => "frame-1"),
    audit: overrides.audit ?? (() => {}),
    sourceAddr: overrides.sourceAddr ?? "127.0.0.1",
    inFlight: overrides.inFlight ?? { count: 0 },
  };
}

function makeReq(
  body: string,
  ts: string,
  opts: { sig?: string; nonce?: string; channel?: string; account?: string; origin?: string } = {},
): Request {
  const channel = opts.channel ?? "slack";
  const account = opts.account ?? "T1";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": ts,
    "X-Webhook-Signature": opts.sig ?? sign(ts, body),
    "X-Webhook-Nonce": opts.nonce ?? "n1",
  };
  if (opts.origin !== undefined) headers.Origin = opts.origin;
  return new Request(`http://x/webhooks/${channel}/${account}`, {
    method: "POST",
    headers,
    body,
  });
}

describe("pipeline happy path", () => {
  test("signed valid body returns 200 with frameId", async () => {
    const deps = makeDeps();
    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const ts = String(Math.floor(deps.clock() / 1000));
    const res = await runPipeline(makeReq(body, ts), deps);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; frameId: string };
    expect(json.ok).toBe(true);
    expect(json.frameId).toBe("frame-1");
    expect(deps.inFlight.count).toBe(0);
  });
});

describe("pipeline rejections", () => {
  test("bad signature returns 401", async () => {
    const deps = makeDeps();
    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const ts = String(Math.floor(deps.clock() / 1000));
    const res = await runPipeline(makeReq(body, ts, { sig: "v0=deadbeef" }), deps);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });

  test("stale timestamp returns 401", async () => {
    const deps = makeDeps();
    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const staleTs = String(Math.floor(deps.clock() / 1000) - 10_000);
    const res = await runPipeline(makeReq(body, staleTs), deps);
    expect(res.status).toBe(401);
  });

  test("malformed signed body returns 400 INVALID_BODY (not 500)", async () => {
    const deps = makeDeps();
    const body = `{"team_id":`; // truncated JSON
    const ts = String(Math.floor(deps.clock() / 1000));
    const res = await runPipeline(makeReq(body, ts), deps);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("INVALID_BODY");
  });

  test("unknown channel returns 401 (oracle closed; full pipeline runs)", async () => {
    const deps = makeDeps();
    const body = "{}";
    const ts = String(Math.floor(deps.clock() / 1000));
    const req = new Request("http://x/webhooks/discord/X", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": ts,
        "X-Webhook-Signature": "v0=deadbeef",
        "X-Webhook-Nonce": "n1",
      },
      body,
    });
    const res = await runPipeline(req, deps);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });
});

describe("pipeline idempotency", () => {
  test("idempotent replay returns cached 200; dispatch called once", async () => {
    let dispatchCount = 0;
    const deps = makeDeps({
      dispatch: async () => {
        dispatchCount++;
        return `frame-${dispatchCount}`;
      },
    });
    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const ts1 = String(Math.floor(deps.clock() / 1000));
    const r1 = await runPipeline(makeReq(body, ts1, { nonce: "n1" }), deps);
    expect(r1.status).toBe(200);

    const ts2 = String(Math.floor(deps.clock() / 1000) + 1);
    const r2 = await runPipeline(makeReq(body, ts2, { nonce: "n2", sig: sign(ts2, body) }), deps);
    expect(r2.status).toBe(200);
    expect(dispatchCount).toBe(1);
    const j = (await r2.json()) as { frameId: string };
    expect(j.frameId).toBe("frame-1");
  });

  test("concurrent retry while pending returns 409 DELIVERY_IN_FLIGHT", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps = makeDeps({
      dispatch: async () => {
        await gate;
        return "frame-1";
      },
    });
    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const ts1 = String(Math.floor(deps.clock() / 1000));
    const p1 = runPipeline(makeReq(body, ts1, { nonce: "n1" }), deps);
    // Wait one tick so the first request reaches dispatch and reserves pending.
    await new Promise((r) => setTimeout(r, 5));

    const ts2 = String(Math.floor(deps.clock() / 1000) + 1);
    const r2 = await runPipeline(makeReq(body, ts2, { nonce: "n2", sig: sign(ts2, body) }), deps);
    expect(r2.status).toBe(409);
    const j = (await r2.json()) as { code: string };
    expect(j.code).toBe("DELIVERY_IN_FLIGHT");

    release();
    const r1 = await p1;
    expect(r1.status).toBe(200);
  });

  test("5xx dispatch failure clears reservation; retry re-dispatches", async () => {
    let count = 0;
    const deps = makeDeps({
      dispatch: async () => {
        count++;
        if (count === 1) throw new Error("boom");
        return "frame-2";
      },
    });
    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const ts1 = String(Math.floor(deps.clock() / 1000));

    const r1 = await runPipeline(makeReq(body, ts1, { nonce: "n1" }), deps);
    expect(r1.status).toBe(500);

    const ts2 = String(Math.floor(deps.clock() / 1000) + 1);
    const r2 = await runPipeline(makeReq(body, ts2, { nonce: "n2", sig: sign(ts2, body) }), deps);
    expect(r2.status).toBe(200);
    expect(count).toBe(2);
  });

  test("tenant isolation: same deliveryId, different tenantId both dispatch", async () => {
    let count = 0;
    const deps = makeDeps({
      dispatch: async () => {
        count++;
        return `frame-${count}`;
      },
    });
    const ts = String(Math.floor(deps.clock() / 1000));

    const bodyA = JSON.stringify({ team_id: "T1", event_id: "shared" });
    const r1 = await runPipeline(makeReq(bodyA, ts, { nonce: "n1" }), deps);
    expect(r1.status).toBe(200);

    const bodyB = JSON.stringify({ team_id: "T2", event_id: "shared" });
    const ts2 = String(Math.floor(deps.clock() / 1000) + 1);
    const r2 = await runPipeline(makeReq(bodyB, ts2, { nonce: "n2", sig: sign(ts2, bodyB) }), deps);
    expect(r2.status).toBe(200);
    expect(count).toBe(2);
  });
});

describe("pipeline rate limiting", () => {
  test("front-door source limiter rejects flood", async () => {
    const sourceLimit: RateLimitConfig = { capacity: 2, refillPerSec: 0 };
    const deps = makeDeps({ config: { sourceLimit } });
    const ts = String(Math.floor(deps.clock() / 1000));

    for (let i = 0; i < 2; i++) {
      const body = JSON.stringify({ team_id: "T1", event_id: `e${i}` });
      const r = await runPipeline(makeReq(body, ts, { nonce: `n${i}`, sig: sign(ts, body) }), deps);
      expect(r.status).toBe(200);
    }
    const body = JSON.stringify({ team_id: "T1", event_id: "e3" });
    const r = await runPipeline(makeReq(body, ts, { nonce: "n3", sig: sign(ts, body) }), deps);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).not.toBeNull();
  });

  test("tenant rate-limit rejects when capacity exhausted", async () => {
    const reg = makeReg({ rateLimit: { capacity: 1, refillPerSec: 0 } });
    const deps = makeDeps({ reg });
    const ts = String(Math.floor(deps.clock() / 1000));

    const b1 = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const r1 = await runPipeline(makeReq(b1, ts, { nonce: "n1", sig: sign(ts, b1) }), deps);
    expect(r1.status).toBe(200);

    const b2 = JSON.stringify({ team_id: "T1", event_id: "e2" });
    const ts2 = String(Math.floor(deps.clock() / 1000) + 1);
    const r2 = await runPipeline(makeReq(b2, ts2, { nonce: "n2", sig: sign(ts2, b2) }), deps);
    expect(r2.status).toBe(429);
  });
});

describe("pipeline body and CORS", () => {
  test("body too large returns 413", async () => {
    const deps = makeDeps({ config: { maxBodyBytes: 16 } });
    const body = JSON.stringify({ team_id: "T1", event_id: "x".repeat(100) });
    const ts = String(Math.floor(deps.clock() / 1000));
    const res = await runPipeline(makeReq(body, ts, { sig: sign(ts, body) }), deps);
    expect(res.status).toBe(413);
  });

  test("CORS disallowed origin returns 403", async () => {
    const deps = makeDeps();
    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const ts = String(Math.floor(deps.clock() / 1000));
    const res = await runPipeline(makeReq(body, ts, { origin: "http://evil.example.com" }), deps);
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("pipeline routing", () => {
  test("non-webhook routes return 404 from pipeline", async () => {
    const deps = makeDeps();
    const req = new Request("http://x/healthz", { method: "GET" });
    const res = await runPipeline(req, deps);
    expect(res.status).toBe(404);
  });
});

describe("pipeline backpressure", () => {
  test("inFlight cap returns 429 + Retry-After: 1", async () => {
    const deps = makeDeps({
      config: { maxInFlight: 1 },
      inFlight: { count: 1 },
    });
    const body = JSON.stringify({ team_id: "T1", event_id: "e1" });
    const ts = String(Math.floor(deps.clock() / 1000));
    const res = await runPipeline(makeReq(body, ts), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    // count was already 1 — pipeline must not have decremented past 0 or further incremented
    expect(deps.inFlight.count).toBe(1);
  });
});
