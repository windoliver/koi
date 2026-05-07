/**
 * Runtime corner-case tests for the Cloudflare gateway shim template (Worker A).
 *
 * Strategy: evaluate the template via `new Function`, with `export default`
 * rewritten to assign onto an injected exports object. Drives every claim /
 * waiter / takeover / handler-failure branch end-to-end with mocked DO and
 * Service Binding.
 */

import { describe, expect, it } from "bun:test";

import { GATEWAY_SHIM_SOURCE } from "./shim-templates.js";

type FetchHandler = (req: Request, env: unknown, ctx: unknown) => Promise<Response>;

const buildGateway = (): FetchHandler => {
  const src = GATEWAY_SHIM_SOURCE.replace("export default", "__exports.default = ");
  const fn = new Function("__exports", src);
  const exports: { default?: { fetch: FetchHandler } } = {};
  fn(exports);
  if (exports.default === undefined) throw new Error("template eval failed");
  return exports.default.fetch.bind(exports.default);
};

interface DoCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

const buildEnv = (
  doScript: (call: DoCall) => unknown,
  handlerScript: (req: Request) => Response,
): { env: unknown; doCalls: DoCall[]; handlerCalls: number } => {
  const doCalls: DoCall[] = [];
  let handlerCalls = 0;
  const stub = {
    fetch: async (url: string, init: { method: string; body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const path = new URL(url).pathname;
      doCalls.push({ path, body });
      return new Response(JSON.stringify(doScript({ path, body })), { status: 200 });
    },
  };
  const env = {
    KOI_INSTANCE_TOKEN: "tok",
    KOI_OWNER_ID: "owner-1",
    KOI_DEDUPE_DO: {
      idFromName: (_n: string) => ({ name: _n }),
      get: (_id: unknown) => stub,
    },
    HANDLER_RUNNER: {
      fetch: async (req: Request) => {
        handlerCalls++;
        return handlerScript(req);
      },
    },
  };
  // Wrap so callers can read the live counter.
  return new Proxy(
    {
      env,
      doCalls,
      get handlerCalls() {
        return handlerCalls;
      },
    },
    {},
  ) as unknown as { env: unknown; doCalls: DoCall[]; handlerCalls: number };
};

const buildInvokeRequest = (
  overrides: Partial<{
    operationId: string;
    requestId: string;
    payload: unknown;
    dedupeFingerprint: string;
    dedupeExpiresAtMs: number;
    bodyOverride: string;
    token: string;
    method: string;
  }> = {},
): Request => {
  const body =
    overrides.bodyOverride ??
    JSON.stringify({
      operationId: overrides.operationId ?? "op-1",
      requestId: overrides.requestId ?? "req-1",
      payload: overrides.payload ?? { x: 1 },
      dedupeFingerprint: overrides.dedupeFingerprint ?? "fp-1",
      dedupeExpiresAtMs: overrides.dedupeExpiresAtMs ?? Date.now() + 60_000,
    });
  return new Request("https://gateway.example.test/invoke", {
    method: overrides.method ?? "POST",
    headers: {
      "content-type": "application/json",
      "X-Koi-Instance-Token": overrides.token ?? "tok",
    },
    body,
  });
};

describe("cloudflare gateway shim — runtime corner cases", () => {
  it("rejects non-POST → 405 METHOD_NOT_ALLOWED", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      () => ({ status: "fresh" }),
      () => new Response("{}", { status: 200 }),
    );
    const resp = await fetchHandler(new Request("https://x/", { method: "GET" }), e.env, {});
    expect(resp.status).toBe(405);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("METHOD_NOT_ALLOWED");
  });

  it("rejects bad token → 401 UNAUTHORIZED", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      () => ({ status: "fresh" }),
      () => new Response("{}", { status: 200 }),
    );
    const resp = await fetchHandler(buildInvokeRequest({ token: "wrong" }), e.env, {});
    expect(resp.status).toBe(401);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("UNAUTHORIZED");
  });

  it("rejects malformed body → 400 INVALID_BODY", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      () => ({ status: "fresh" }),
      () => new Response("{}", { status: 200 }),
    );
    const resp = await fetchHandler(buildInvokeRequest({ bodyOverride: "not json" }), e.env, {});
    expect(resp.status).toBe(400);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("INVALID_BODY");
  });

  it("missing required field → 400 INVALID_BODY", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      () => ({ status: "fresh" }),
      () => new Response("{}", { status: 200 }),
    );
    const resp = await fetchHandler(
      buildInvokeRequest({
        bodyOverride: JSON.stringify({ operationId: "op-1" }),
      }),
      e.env,
      {},
    );
    expect(resp.status).toBe(400);
  });

  it("happy path: fresh claim → handler success → DO complete → 200 success", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      ({ path }) => {
        if (path === "/claim") return { status: "fresh" };
        if (path === "/complete") return { committed: true };
        throw new Error("unexpected DO path " + path);
      },
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "X-Koi-Handler-Outcome": "success" },
        }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Koi-Result-Kind")).toBe("success");
    expect(await resp.json()).toEqual({ ok: true });
    expect(e.doCalls.map((c) => c.path)).toEqual(["/claim", "/complete"]);
    expect(e.handlerCalls).toBe(1);
  });

  it("DO claim returns completed → 200 success replay (no handler call)", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      () => ({ status: "completed", result: { cached: true } }),
      () => new Response("should-not-call", { status: 500 }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ cached: true });
    expect(e.handlerCalls).toBe(0);
  });

  it("DO claim returns failed-permanent → 200 cached failure (no handler call)", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      () => ({ status: "failed-permanent", error: { code: "NOPE" } }),
      () => new Response("should-not-call", { status: 500 }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Koi-Result-Kind")).toBe("failed-permanent");
    expect(e.handlerCalls).toBe(0);
  });

  it("DO claim fingerprint-conflict → 409 OPERATION_ID_CONFLICT", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      () => ({ status: "fingerprint-conflict", storedFingerprint: "fp-original" }),
      () => new Response("{}", { status: 200 }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(409);
    expect(resp.headers.get("X-Koi-Result-Kind")).toBe("operation-id-conflict");
    expect(await resp.json()).toMatchObject({ storedFingerprint: "fp-original" });
  });

  it("DO claim operation-expired → 410 OPERATION_EXPIRED", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      () => ({ status: "operation-expired" }),
      () => new Response("{}", { status: 200 }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(410);
    expect(resp.headers.get("X-Koi-Result-Kind")).toBe("operation-expired");
  });

  it("handler 503 transient → DO release called → 503 HANDLER_TRANSIENT (NOT cached)", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      ({ path }) => {
        if (path === "/claim") return { status: "fresh" };
        if (path === "/release") return { released: true };
        throw new Error("unexpected DO path " + path);
      },
      () => new Response("oops", { status: 503 }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(503);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("HANDLER_TRANSIENT");
    expect(e.doCalls.map((c) => c.path)).toEqual(["/claim", "/release"]);
  });

  it("handler 200 but outcome=transient → release called, NOT cached", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      ({ path }) => {
        if (path === "/claim") return { status: "fresh" };
        if (path === "/release") return { released: true };
        throw new Error("unexpected " + path);
      },
      () =>
        new Response("{}", {
          status: 200,
          headers: { "X-Koi-Handler-Outcome": "transient" },
        }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(503);
    expect(e.doCalls.map((c) => c.path)).toEqual(["/claim", "/release"]);
  });

  it("handler outcome=failed-permanent (200) → DO fail (cached), 200 failed-permanent", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      ({ path }) => {
        if (path === "/claim") return { status: "fresh" };
        if (path === "/fail") return { committed: true };
        throw new Error("unexpected " + path);
      },
      () =>
        new Response(JSON.stringify({ code: "NOPE" }), {
          status: 200,
          headers: { "X-Koi-Handler-Outcome": "failed-permanent" },
        }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Koi-Result-Kind")).toBe("failed-permanent");
    expect(e.doCalls.map((c) => c.path)).toEqual(["/claim", "/fail"]);
  });

  it("DO complete reports !committed → 503 DEDUPE_PERSISTENCE_FAILED", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      ({ path }) => {
        if (path === "/claim") return { status: "fresh" };
        if (path === "/complete") return { committed: false };
        throw new Error("unexpected " + path);
      },
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "X-Koi-Handler-Outcome": "success" },
        }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(503);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("DEDUPE_PERSISTENCE_FAILED");
  });

  it("waiter: in-progress → completed → 200 success", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      ({ path }) => {
        if (path === "/claim") return { status: "in-progress" };
        if (path === "/waitForTerminal") return { kind: "completed", result: { v: 42 } };
        throw new Error("unexpected " + path);
      },
      () => new Response("should-not-call", { status: 500 }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ v: 42 });
    expect(e.handlerCalls).toBe(0);
  });

  it("waiter: claim-expired takeover (1 hop) → re-claim fresh → handler runs", async () => {
    const fetchHandler = buildGateway();
    let claimCount = 0;
    let waitCount = 0;
    const e = buildEnv(
      ({ path }) => {
        if (path === "/claim") {
          claimCount++;
          // First claim: in-progress (current owner). Second (post-takeover): fresh.
          return claimCount === 1 ? { status: "in-progress" } : { status: "fresh" };
        }
        if (path === "/waitForTerminal") {
          waitCount++;
          return { kind: "claim-expired" };
        }
        if (path === "/complete") return { committed: true };
        throw new Error("unexpected " + path);
      },
      () =>
        new Response(JSON.stringify({ took: "over" }), {
          status: 200,
          headers: { "X-Koi-Handler-Outcome": "success" },
        }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ took: "over" });
    expect(claimCount).toBe(2);
    expect(waitCount).toBe(1);
    expect(e.handlerCalls).toBe(1);
  });

  it("waiter: 4 consecutive claim-expired → WAITER_PROTOCOL_BUG (3-hop bound)", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      ({ path }) => {
        if (path === "/claim") return { status: "in-progress" };
        if (path === "/waitForTerminal") return { kind: "claim-expired" };
        throw new Error("unexpected " + path);
      },
      () => new Response("nope", { status: 500 }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(503);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("WAITER_PROTOCOL_BUG");
  });

  it("waiter: timeout → 504 TIMEOUT", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      ({ path }) => {
        if (path === "/claim") return { status: "in-progress" };
        if (path === "/waitForTerminal") return { kind: "timeout" };
        throw new Error("unexpected " + path);
      },
      () => new Response("{}", { status: 200 }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(504);
    expect(resp.headers.get("X-Koi-Result-Kind")).toBe("timeout");
  });

  it("waiter: operation-id-conflict mid-wait → 409 propagated", async () => {
    const fetchHandler = buildGateway();
    const e = buildEnv(
      ({ path }) => {
        if (path === "/claim") return { status: "in-progress" };
        if (path === "/waitForTerminal")
          return { kind: "operation-id-conflict", storedFingerprint: "fp-other" };
        throw new Error("unexpected " + path);
      },
      () => new Response("{}", { status: 200 }),
    );
    const resp = await fetchHandler(buildInvokeRequest(), e.env, {});
    expect(resp.status).toBe(409);
    expect(await resp.json()).toMatchObject({ storedFingerprint: "fp-other" });
  });

  it("handler binding throws (HANDLER_RUNNER unavailable) → 503 HANDLER_UNREACHABLE", async () => {
    const fetchHandler = buildGateway();
    const doCalls: DoCall[] = [];
    const stub = {
      fetch: async (url: string, init: { method: string; body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const path = new URL(url).pathname;
        doCalls.push({ path, body });
        return new Response(JSON.stringify({ status: "fresh" }), { status: 200 });
      },
    };
    const env = {
      KOI_INSTANCE_TOKEN: "tok",
      KOI_OWNER_ID: "owner-1",
      KOI_DEDUPE_DO: {
        idFromName: (_n: string) => ({ name: _n }),
        get: (_id: unknown) => stub,
      },
      HANDLER_RUNNER: {
        fetch: async () => {
          throw new Error("binding gone");
        },
      },
    };
    const resp = await fetchHandler(buildInvokeRequest(), env, {});
    expect(resp.status).toBe(503);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("HANDLER_UNREACHABLE");
  });
});
