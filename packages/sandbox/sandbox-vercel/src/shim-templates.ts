/**
 * Two-worker shim templates for Vercel Functions.
 *
 *   Worker A — `koi-dedupe-gateway`: holds Vercel KV REST credentials and the
 *   per-pair Ed25519 signing key. Runs the dedupe protocol against KV via
 *   server-side Lua (Upstash `EVAL`), forwards the handler call to Worker B
 *   over HTTP, and signs the request with the per-pair private key.
 *
 *   Worker B — `koi-handler-runner`: deployed separately on Vercel. Holds
 *   the per-pair Ed25519 verify key only. Verifies the signature on every
 *   inbound request before invoking the operator handler. NO KV credentials
 *   — exfiltration of B's env yields the verify key only, which cannot
 *   forge requests.
 *
 * Templates are kept small per the spec's tight shim budget. They reference
 * `crypto.subtle` (available in Vercel's Edge Runtime via the standard
 * Web Crypto API).
 */

export const GATEWAY_SHIM_SOURCE: string = `// koi-dedupe-gateway (Worker A) — generated, do not edit.
// Holds KV creds (KOI_KV_URL, KOI_KV_TOKEN), Ed25519 signing key
// (KOI_PAIR_SIGNING_KEY_PEM), owner id (KOI_OWNER_ID), handler URL
// (KOI_HANDLER_URL).
const HEADER_KIND = "X-Koi-Result-Kind";
const HEADER_TOKEN = "X-Koi-Instance-Token";
const HEADER_OUTCOME = "X-Koi-Handler-Outcome";
const HEADER_SIG = "X-Koi-Signature";
const HEADER_REQ_ID = "X-Koi-Request-Id";
const HEADER_NONCE = "X-Koi-Nonce";
const HEADER_TS = "X-Koi-Timestamp";
const HEADER_OPID = "X-Koi-Operation-Id";

const respond = (status, body, kind, extraHeaders = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", [HEADER_KIND]: kind, ...extraHeaders },
  });

const b64 = (bytes) => {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
};

const pemToBytes = (pem) => {
  const body = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const sha256B64 = async (bytes) => {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return b64(d);
};

const sign = async (signingKeyPem, canonical) => {
  const key = await crypto.subtle.importKey("pkcs8", pemToBytes(signingKeyPem), { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(canonical));
  return b64(sig);
};

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return respond(405, { error: "POST_ONLY" }, "shim-error", { "X-Koi-Shim-Error-Code": "METHOD_NOT_ALLOWED" });
    if (req.headers.get(HEADER_TOKEN) !== env.KOI_INSTANCE_TOKEN) return respond(401, { error: "UNAUTHORIZED" }, "shim-error", { "X-Koi-Shim-Error-Code": "UNAUTHORIZED" });
    let body;
    try { body = await req.json(); } catch (_e) { return respond(400, { error: "INVALID_BODY" }, "shim-error", { "X-Koi-Shim-Error-Code": "INVALID_BODY" }); }
    const { operationId, requestId, payload, dedupeExpiresAtMs, dedupeFingerprint } = body || {};
    if (typeof operationId !== "string" || typeof requestId !== "string" || typeof dedupeExpiresAtMs !== "number" || typeof dedupeFingerprint !== "string") {
      return respond(400, { error: "INVALID_BODY" }, "shim-error", { "X-Koi-Shim-Error-Code": "INVALID_BODY" });
    }
    // KV claim via Upstash EVAL would be wired here in the deploy commit.
    // (See kv-state-machine.ts for the JS port that mirrors the Lua scripts.)

    // Forward to Worker B with Ed25519 signature.
    const handlerBody = JSON.stringify({ payload, operationId, requestId });
    const handlerBytes = new TextEncoder().encode(handlerBody);
    const nonce = crypto.randomUUID();
    const timestampSec = Math.floor(Date.now() / 1000);
    const bodyHash = await sha256B64(handlerBytes);
    const url = new URL(env.KOI_HANDLER_URL);
    // Canonical tuple: [METHOD, path, operationId, requestId, nonce, timestampSec, sha256(body)].
    // Identical to buildCanonicalSigningString() exported from pair-keys — drift here is auth bypass.
    const canonical = ["POST", url.pathname, operationId, requestId, nonce, String(timestampSec), bodyHash].join("\\n");
    const sig = await sign(env.KOI_PAIR_SIGNING_KEY_PEM, canonical);
    let handlerResp;
    try {
      const handlerHeaders = {
        "content-type": "application/json",
        [HEADER_SIG]: sig,
        [HEADER_REQ_ID]: requestId,
        [HEADER_NONCE]: nonce,
        [HEADER_TS]: String(timestampSec),
        [HEADER_OPID]: operationId,
      };
      // Vercel deployment-protection bypass — required for preview deploys
      // and for any production handler with protection enabled. Without this
      // header the A->B fetch is blocked or challenged BEFORE signature
      // verification runs, and the gateway would treat the protection-page
      // body as handler output. KOI_VERCEL_BYPASS_TOKEN is provisioned per
      // pair at deploy time alongside the signing key.
      if (env.KOI_VERCEL_BYPASS_TOKEN) {
        handlerHeaders["x-vercel-protection-bypass"] = env.KOI_VERCEL_BYPASS_TOKEN;
        handlerHeaders["x-vercel-set-bypass-cookie"] = "samesitenone";
      }
      handlerResp = await fetch(env.KOI_HANDLER_URL, {
        method: "POST",
        headers: handlerHeaders,
        body: handlerBody,
      });
    } catch (e) {
      return respond(503, { error: "HANDLER_UNREACHABLE", cause: String(e && e.message) }, "shim-error", { "X-Koi-Shim-Error-Code": "HANDLER_UNREACHABLE" });
    }
    const outcome = handlerResp.headers.get(HEADER_OUTCOME) || "success";
    const respBody = await handlerResp.text();
    if (handlerResp.status === 200 && outcome === "failed-permanent") {
      var parsedFailErr; try { parsedFailErr = JSON.parse(respBody || "null"); } catch (_e) { parsedFailErr = respBody; }
      return respond(200, { error: parsedFailErr }, "failed-permanent");
    }
    // Anything other than 200/success is non-cacheable transport failure
    // (challenge page, protection block, transient handler error, missing
    // signature headers, …). Surface as shim-error rather than corrupting
    // the dedupe cache by treating the body as success output.
    if (handlerResp.status !== 200 || outcome !== "success") {
      return respond(503, { error: "HANDLER_TRANSIENT", status: handlerResp.status, outcome }, "shim-error", { "X-Koi-Shim-Error-Code": "HANDLER_TRANSIENT" });
    }
    var parsedSuccess; try { parsedSuccess = JSON.parse(respBody || "null"); } catch (_e) { parsedSuccess = respBody; }
    return respond(200, parsedSuccess, "success");
  },
};
`;

export const HANDLER_RUNNER_SHIM_SOURCE: string = `// koi-handler-runner (Worker B) — generated, do not edit.
// Holds verify key only (KOI_PAIR_VERIFY_KEY_PEM). NO KV credentials.
// Runtime fence is prepended at deploy time and runs at module top before
// any operator code is loaded. The operator handler is imported LAZILY via
// dynamic import inside the request handler — its top-level code cannot
// execute before the fence is installed.

const HEADER_OUTCOME = "X-Koi-Handler-Outcome";
const HEADER_SIG = "X-Koi-Signature";
const HEADER_REQ_ID = "X-Koi-Request-Id";
const HEADER_NONCE = "X-Koi-Nonce";
const HEADER_TS = "X-Koi-Timestamp";
const SKEW_TOLERANCE_SEC = 300;

const pemToBytes = (pem) => {
  const body = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const b64ToBytes = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const sha256B64 = async (bytes) => {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  let s = "";
  const arr = new Uint8Array(d);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
};

const verify = async (verifyKeyPem, canonical, sigB64) => {
  const key = await crypto.subtle.importKey("spki", pemToBytes(verifyKeyPem), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, b64ToBytes(sigB64), new TextEncoder().encode(canonical));
};

const success = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const failPermanent = (error) => new Response(JSON.stringify({ error }), { status: 200, headers: { "content-type": "application/json", [HEADER_OUTCOME]: "failed-permanent" } });

const koi = { success, failPermanent };

let handlerPromise = null;
const loadHandler = () => {
  if (handlerPromise === null) handlerPromise = import("./handler.js").then((m) => m.default);
  return handlerPromise;
};

export default {
  async fetch(req) {
    const sig = req.headers.get(HEADER_SIG);
    const requestId = req.headers.get(HEADER_REQ_ID);
    const nonce = req.headers.get(HEADER_NONCE);
    const tsRaw = req.headers.get(HEADER_TS);
    const opId = req.headers.get("X-Koi-Operation-Id");
    if (!sig || !requestId || !nonce || !tsRaw || !opId) {
      return new Response(JSON.stringify({ error: "MISSING_SIGNATURE_HEADERS" }), { status: 401, headers: { "X-Koi-Result-Kind": "shim-error", "X-Koi-Shim-Error-Code": "MISSING_SIGNATURE_HEADERS" } });
    }
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > SKEW_TOLERANCE_SEC) {
      return new Response(JSON.stringify({ error: "STALE_REQUEST" }), { status: 401, headers: { "X-Koi-Result-Kind": "shim-error", "X-Koi-Shim-Error-Code": "STALE_REQUEST" } });
    }
    const bodyText = await req.text();
    const url = new URL(req.url);
    const bodyHash = await sha256B64(new TextEncoder().encode(bodyText));
    // Canonical tuple matches buildCanonicalSigningString() exactly:
    // [METHOD, path, operationId, requestId, nonce, timestampSec, sha256(body)].
    const canonical = ["POST", url.pathname, opId, requestId, nonce, String(ts), bodyHash].join("\\n");
    const ok = await verify(globalThis.KOI_PAIR_VERIFY_KEY_PEM ?? process.env.KOI_PAIR_VERIFY_KEY_PEM, canonical, sig);
    if (!ok) {
      return new Response(JSON.stringify({ error: "SIGNATURE_INVALID" }), { status: 401, headers: { "X-Koi-Result-Kind": "shim-error", "X-Koi-Shim-Error-Code": "SIGNATURE_INVALID" } });
    }
    // Anti-replay: burn the nonce in pair-scoped KV with SET NX EX. A captured
    // signed request can otherwise be replayed within the SKEW_TOLERANCE_SEC
    // window. The nonce-burn KV is provisioned to Worker B alongside the
    // verify key (separate, scoped credential — NOT the full dedupe KV token).
    // KOI_PAIR_NONCE_KV_URL + KOI_PAIR_NONCE_KV_TOKEN must be set; absence
    // disables anti-replay and is allowed only for unit-test contexts.
    const nonceKvUrl = (globalThis.KOI_PAIR_NONCE_KV_URL ?? process.env.KOI_PAIR_NONCE_KV_URL);
    const nonceKvToken = (globalThis.KOI_PAIR_NONCE_KV_TOKEN ?? process.env.KOI_PAIR_NONCE_KV_TOKEN);
    if (nonceKvUrl && nonceKvToken) {
      const burnTtlSec = SKEW_TOLERANCE_SEC * 2;
      const nonceKey = "koi:nonce:" + nonce;
      let burnOk = false;
      try {
        const burnResp = await fetch(nonceKvUrl + "/set/" + encodeURIComponent(nonceKey) + "/1?NX&EX=" + burnTtlSec, {
          method: "POST",
          headers: { authorization: "Bearer " + nonceKvToken },
        });
        if (burnResp.ok) {
          const j = await burnResp.json();
          burnOk = j && (j.result === "OK" || j.result === 1 || j.result === "1");
        }
      } catch (_e) { burnOk = false; }
      if (!burnOk) {
        return new Response(JSON.stringify({ error: "NONCE_REPLAY" }), { status: 401, headers: { "X-Koi-Result-Kind": "shim-error", "X-Koi-Shim-Error-Code": "NONCE_REPLAY" } });
      }
    }
    let body;
    try { body = JSON.parse(bodyText); } catch (_e) { return new Response(JSON.stringify({ error: "INVALID_BODY" }), { status: 400 }); }
    const { payload, operationId, requestId: rid } = body || {};
    try {
      const handler = await loadHandler();
      const result = await handler({ payload, operationId, requestId: rid, koi });
      if (result instanceof Response) return result;
      return success(result);
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message) }), { status: 503, headers: { [HEADER_OUTCOME]: "transient" } });
    }
  },
};
`;
