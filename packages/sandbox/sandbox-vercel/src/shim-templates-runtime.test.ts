/**
 * Runtime corner-case tests for the Vercel handler-runner shim template.
 *
 * Strategy: evaluate the template string via `new Function`, with
 *   - `import("./handler.js")` rewritten to a mocked default export, and
 *   - `export default` rewritten to assign onto an injected exports object.
 *
 * This drives every signature / replay / skew / failure branch end-to-end
 * without needing a real Vercel deploy or filesystem layout.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { buildCanonicalSigningString, generatePairKeypair, signRequest } from "./pair-keys.js";
import { HANDLER_RUNNER_SHIM_SOURCE } from "./shim-templates.js";

type FetchHandler = (req: Request) => Promise<Response>;
type MockHandler = (ctx: {
  payload: unknown;
  operationId: string;
  requestId: string;
  koi: { success: (v: unknown) => Response; failPermanent: (e: unknown) => Response };
}) => Promise<unknown> | unknown;

const buildRunner = (mockHandler: MockHandler): FetchHandler => {
  const src = HANDLER_RUNNER_SHIM_SOURCE.replace(
    'import("./handler.js")',
    "Promise.resolve({ default: __mockHandler })",
  ).replace("export default", "__exports.default = ");
  const fn = new Function("__exports", "__mockHandler", src);
  const exports: { default?: { fetch: FetchHandler } } = {};
  fn(exports, mockHandler);
  if (exports.default === undefined) throw new Error("template eval failed");
  return exports.default.fetch.bind(exports.default);
};

interface TestCtx {
  readonly verifyKeyPem: string;
  readonly signingKeyPem: string;
  readonly fetchHandler: FetchHandler;
  readonly buildSignedRequest: (overrides?: {
    readonly bodyOverride?: string;
    readonly tsOverride?: number;
    readonly nonceOverride?: string;
    readonly sigOverride?: string;
    readonly omitHeader?: string;
    readonly opIdOverride?: string;
  }) => Promise<Request>;
}

const URL_BASE = "https://handler.example.test/invoke";

const setup = async (mockHandler: MockHandler): Promise<TestCtx> => {
  const { verifyKeyPem, signingKeyPem } = await generatePairKeypair();
  (globalThis as unknown as { KOI_PAIR_VERIFY_KEY_PEM: string }).KOI_PAIR_VERIFY_KEY_PEM =
    verifyKeyPem;
  const fetchHandler = buildRunner(mockHandler);
  const buildSignedRequest = async (
    overrides: Parameters<TestCtx["buildSignedRequest"]>[0] = {},
  ) => {
    const bodyText =
      overrides.bodyOverride ??
      JSON.stringify({ payload: { x: 1 }, operationId: "op-1", requestId: "req-1" });
    const bodyBytes = new TextEncoder().encode(bodyText);
    const operationId = overrides.opIdOverride ?? "op-1";
    const requestId = "req-1";
    const nonce = overrides.nonceOverride ?? "nonce-1";
    const timestampSec = overrides.tsOverride ?? Math.floor(Date.now() / 1000);
    const canonical = await buildCanonicalSigningString({
      method: "POST",
      path: "/invoke",
      operationId,
      requestId,
      nonce,
      timestampSec,
      bodyBytes,
    });
    const sig = overrides.sigOverride ?? (await signRequest(signingKeyPem, canonical));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "X-Koi-Signature": sig,
      "X-Koi-Request-Id": requestId,
      "X-Koi-Nonce": nonce,
      "X-Koi-Timestamp": String(timestampSec),
      "X-Koi-Operation-Id": operationId,
    };
    if (overrides.omitHeader) delete headers[overrides.omitHeader];
    return new Request(URL_BASE, { method: "POST", headers, body: bodyText });
  };
  return { verifyKeyPem, signingKeyPem, fetchHandler, buildSignedRequest };
};

const echoHandler: MockHandler = async ({ payload }) => ({ echo: payload });

describe("vercel handler-runner shim — runtime corner cases", () => {
  let savedFetch: typeof fetch;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
    delete (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_URL;
    delete (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_TOKEN;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    delete (globalThis as Record<string, unknown>).KOI_PAIR_VERIFY_KEY_PEM;
    delete (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_URL;
    delete (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_TOKEN;
  });

  it("happy path: valid sig + no nonce KV configured → handler invoked, 200 success", async () => {
    const ctx = await setup(echoHandler);
    const resp = await ctx.fetchHandler(await ctx.buildSignedRequest());
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ echo: { x: 1 } });
  });

  it("missing X-Koi-Signature → 401 MISSING_SIGNATURE_HEADERS", async () => {
    const ctx = await setup(echoHandler);
    const resp = await ctx.fetchHandler(
      await ctx.buildSignedRequest({ omitHeader: "X-Koi-Signature" }),
    );
    expect(resp.status).toBe(401);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("MISSING_SIGNATURE_HEADERS");
  });

  it("missing X-Koi-Operation-Id → 401 MISSING_SIGNATURE_HEADERS", async () => {
    const ctx = await setup(echoHandler);
    const resp = await ctx.fetchHandler(
      await ctx.buildSignedRequest({ omitHeader: "X-Koi-Operation-Id" }),
    );
    expect(resp.status).toBe(401);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("MISSING_SIGNATURE_HEADERS");
  });

  it("stale timestamp (> 300s in past) → 401 STALE_REQUEST", async () => {
    const ctx = await setup(echoHandler);
    const ancient = Math.floor(Date.now() / 1000) - 301;
    const resp = await ctx.fetchHandler(await ctx.buildSignedRequest({ tsOverride: ancient }));
    expect(resp.status).toBe(401);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("STALE_REQUEST");
  });

  it("future timestamp (> 300s ahead) → 401 STALE_REQUEST", async () => {
    const ctx = await setup(echoHandler);
    const future = Math.floor(Date.now() / 1000) + 301;
    const resp = await ctx.fetchHandler(await ctx.buildSignedRequest({ tsOverride: future }));
    expect(resp.status).toBe(401);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("STALE_REQUEST");
  });

  it("invalid signature → 401 SIGNATURE_INVALID", async () => {
    const ctx = await setup(echoHandler);
    // Real-shaped sig (64 bytes, valid base64) but wrong: from a different keypair.
    const { signingKeyPem: otherSigning } = await generatePairKeypair();
    const otherSig = await signRequest(otherSigning, "totally-different-canonical");
    const resp = await ctx.fetchHandler(await ctx.buildSignedRequest({ sigOverride: otherSig }));
    expect(resp.status).toBe(401);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("SIGNATURE_INVALID");
  });

  it("opId mismatch (sig over a different opId) → 401 SIGNATURE_INVALID", async () => {
    const ctx = await setup(echoHandler);
    // Sign over opId "op-1" but send header opId "op-EVIL" — canonical drift.
    const sig = await signRequest(
      ctx.signingKeyPem,
      await buildCanonicalSigningString({
        method: "POST",
        path: "/invoke",
        operationId: "op-1",
        requestId: "req-1",
        nonce: "nonce-1",
        timestampSec: Math.floor(Date.now() / 1000),
        bodyBytes: new TextEncoder().encode(
          JSON.stringify({ payload: { x: 1 }, operationId: "op-1", requestId: "req-1" }),
        ),
      }),
    );
    const resp = await ctx.fetchHandler(
      await ctx.buildSignedRequest({ sigOverride: sig, opIdOverride: "op-EVIL" }),
    );
    expect(resp.status).toBe(401);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("SIGNATURE_INVALID");
  });

  it("nonce KV burn succeeds → handler invoked", async () => {
    const ctx = await setup(echoHandler);
    (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_URL = "https://kv.example.test";
    (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_TOKEN = "tok";
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, _init: unknown) => {
      calls.push(url);
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }) as unknown as typeof fetch;
    const resp = await ctx.fetchHandler(await ctx.buildSignedRequest());
    expect(resp.status).toBe(200);
    expect(calls.some((u) => u.includes("/set/koi%3Anonce%3Anonce-1/1?NX&EX=600"))).toBe(true);
  });

  it("nonce already burned (KV returns null result) → 401 NONCE_REPLAY", async () => {
    const ctx = await setup(echoHandler);
    (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_URL = "https://kv.example.test";
    (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_TOKEN = "tok";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: null }), { status: 200 })) as unknown as typeof fetch;
    const resp = await ctx.fetchHandler(await ctx.buildSignedRequest());
    expect(resp.status).toBe(401);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("NONCE_REPLAY");
  });

  it("nonce KV transport error → 401 NONCE_REPLAY (fail-closed)", async () => {
    const ctx = await setup(echoHandler);
    (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_URL = "https://kv.example.test";
    (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_TOKEN = "tok";
    globalThis.fetch = (async () => {
      throw new Error("kv unreachable");
    }) as unknown as typeof fetch;
    const resp = await ctx.fetchHandler(await ctx.buildSignedRequest());
    expect(resp.status).toBe(401);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("NONCE_REPLAY");
  });

  it("nonce KV non-2xx → 401 NONCE_REPLAY (fail-closed)", async () => {
    const ctx = await setup(echoHandler);
    (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_URL = "https://kv.example.test";
    (globalThis as Record<string, unknown>).KOI_PAIR_NONCE_KV_TOKEN = "tok";
    globalThis.fetch = (async () =>
      new Response("kv 500", { status: 500 })) as unknown as typeof fetch;
    const resp = await ctx.fetchHandler(await ctx.buildSignedRequest());
    expect(resp.status).toBe(401);
    expect(resp.headers.get("X-Koi-Shim-Error-Code")).toBe("NONCE_REPLAY");
  });

  it("handler throws → 503 transient (handler error surface)", async () => {
    const ctx = await setup(async () => {
      throw new Error("operator boom");
    });
    const resp = await ctx.fetchHandler(await ctx.buildSignedRequest());
    expect(resp.status).toBe(503);
    expect(resp.headers.get("X-Koi-Handler-Outcome")).toBe("transient");
    expect(await resp.json()).toEqual({ error: "operator boom" });
  });

  it("handler returns Response (e.g. via koi.failPermanent) → forwarded verbatim", async () => {
    const ctx = await setup(async ({ koi }) => koi.failPermanent("operator says no"));
    const resp = await ctx.fetchHandler(await ctx.buildSignedRequest());
    expect(resp.status).toBe(200);
    expect(resp.headers.get("X-Koi-Handler-Outcome")).toBe("failed-permanent");
    expect(await resp.json()).toEqual({ error: "operator says no" });
  });
});
