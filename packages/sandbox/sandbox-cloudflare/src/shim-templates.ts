/**
 * Two-worker shim source templates (string constants).
 *
 *   Worker A — `koi-dedupe-gateway`: koi-owned, holds the DO binding and
 *   `KOI_INSTANCE_TOKEN`. Receives the operator's invoke, runs the dedupe
 *   protocol against the DO, and forwards the actual handler call to Worker B
 *   via a Service Binding (`env.HANDLER_RUNNER.fetch`). Operator code never
 *   sees Worker A.
 *
 *   Worker B — `koi-handler-runner`: runs the operator's class-A handler.
 *   No dedupe credentials, no DO binding — it cannot tamper with the
 *   `claim`/`result` records even if compromised. The runtime fence is
 *   prepended to its bundle (see `runtime-fence.ts`).
 *
 * Templates are exported as JS source strings. The deploy pipeline
 * (NOT in this commit) wraps them in a Cloudflare Workers ESM bundle and
 * uploads via the Workers API. They are content-addressable: each template's
 * sha256 is part of the attestation fingerprint.
 *
 * Templates are kept as small as possible per the spec's `<= 80 LOC` shim
 * budget. Anything that isn't strictly required for the dedupe + auth
 * protocol lives outside the template.
 */

export const GATEWAY_SHIM_SOURCE: string = `// koi-dedupe-gateway (Worker A) — generated, do not edit.
// Holds DO binding (KOI_DEDUPE_DO), instance token (KOI_INSTANCE_TOKEN),
// owner id (KOI_OWNER_ID). Forwards to handler runner via Service Binding.
const HEADER_KIND = "X-Koi-Result-Kind";
const HEADER_TOKEN = "X-Koi-Instance-Token";
const HEADER_OUTCOME = "X-Koi-Handler-Outcome";
const SHIM_POLL_DEADLINE_MS = 25_000;

const respond = (status, body, kind, extraHeaders = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", [HEADER_KIND]: kind, ...extraHeaders },
  });

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "POST") return respond(405, { error: "POST_ONLY" }, "shim-error", { "X-Koi-Shim-Error-Code": "METHOD_NOT_ALLOWED" });
    if (req.headers.get(HEADER_TOKEN) !== env.KOI_INSTANCE_TOKEN) return respond(401, { error: "UNAUTHORIZED" }, "shim-error", { "X-Koi-Shim-Error-Code": "UNAUTHORIZED" });
    let body;
    try { body = await req.json(); } catch (_e) { return respond(400, { error: "INVALID_BODY" }, "shim-error", { "X-Koi-Shim-Error-Code": "INVALID_BODY" }); }
    const { operationId, requestId, payload, dedupeExpiresAtMs, dedupeFingerprint } = body || {};
    if (typeof operationId !== "string" || typeof requestId !== "string" || typeof dedupeExpiresAtMs !== "number" || typeof dedupeFingerprint !== "string") {
      return respond(400, { error: "INVALID_BODY" }, "shim-error", { "X-Koi-Shim-Error-Code": "INVALID_BODY" });
    }
    const dedupeKey = env.KOI_OWNER_ID + ":" + operationId;
    const stub = env.KOI_DEDUPE_DO.get(env.KOI_DEDUPE_DO.idFromName(dedupeKey));
    const claim = await stub.fetch("https://do/claim", { method: "POST", body: JSON.stringify({ operationId, requestId, dedupeFingerprint, dedupeExpiresAtMs }) }).then((r) => r.json());
    if (claim.status === "fingerprint-conflict") return respond(409, { error: "OPERATION_ID_CONFLICT", storedFingerprint: claim.storedFingerprint }, "operation-id-conflict");
    if (claim.status === "operation-expired") return respond(410, { error: "OPERATION_EXPIRED", dedupeExpiresAtMs }, "operation-expired");
    if (claim.status === "completed") return respond(200, claim.result, "success");
    if (claim.status === "failed-permanent") return respond(200, { error: claim.error }, "failed-permanent");
    if (claim.status === "in-progress") {
      const wait = await stub.fetch("https://do/waitForTerminal", { method: "POST", body: JSON.stringify({ operationId, requestId, dedupeExpiresAtMs, timeoutMs: SHIM_POLL_DEADLINE_MS }) }).then((r) => r.json());
      if (wait.kind === "completed") return respond(200, wait.result, "success");
      if (wait.kind === "failed-permanent") return respond(200, { error: wait.error }, "failed-permanent");
      if (wait.kind === "operation-expired") return respond(410, { error: "OPERATION_EXPIRED", dedupeExpiresAtMs }, "operation-expired");
      if (wait.kind === "timeout") return respond(504, { error: "TIMEOUT" }, "timeout");
      return respond(503, { error: "WAITER_PROTOCOL_BUG" }, "shim-error", { "X-Koi-Shim-Error-Code": "WAITER_PROTOCOL_BUG" });
    }
    // claim.status === "fresh" — invoke handler runner via Service Binding.
    const handlerReq = new Request("https://handler/invoke", { method: "POST", body: JSON.stringify({ payload, operationId, requestId }) });
    let handlerResp;
    try { handlerResp = await env.HANDLER_RUNNER.fetch(handlerReq); } catch (e) { return respond(503, { error: "HANDLER_UNREACHABLE", cause: String(e && e.message) }, "shim-error", { "X-Koi-Shim-Error-Code": "HANDLER_UNREACHABLE" }); }
    const outcome = handlerResp.headers.get(HEADER_OUTCOME) || "success";
    const respBody = await handlerResp.text();
    const ttlExpiresAtMs = dedupeExpiresAtMs + 3_600_000;
    if (outcome === "failed-permanent") {
      const failOk = await stub.fetch("https://do/fail", { method: "POST", body: JSON.stringify({ operationId, requestId, dedupeFingerprint, error: respBody, ttlExpiresAtMs }) }).then((r) => r.json());
      if (!failOk.committed) return respond(503, { error: "OWNERSHIP_LOST" }, "shim-error", { "X-Koi-Shim-Error-Code": "OWNERSHIP_LOST" });
      return respond(200, { error: respBody }, "failed-permanent");
    }
    const completeOk = await stub.fetch("https://do/complete", { method: "POST", body: JSON.stringify({ operationId, requestId, dedupeFingerprint, result: respBody, statusCode: 200, ttlExpiresAtMs }) }).then((r) => r.json());
    if (!completeOk.committed) return respond(503, { error: "DEDUPE_PERSISTENCE_FAILED" }, "shim-error", { "X-Koi-Shim-Error-Code": "DEDUPE_PERSISTENCE_FAILED" });
    return respond(200, JSON.parse(respBody || "null"), "success");
  },
};
`;

export const HANDLER_RUNNER_SHIM_SOURCE: string = `// koi-handler-runner (Worker B) — generated, do not edit.
// Receives invoke from Worker A via Service Binding. NO dedupe credentials.
// Runtime fence is prepended at deploy time (see runtime-fence.ts) and runs
// at module top before any operator code is loaded. The operator handler is
// imported LAZILY via dynamic import inside the request handler so its
// top-level code cannot execute before the fence is installed.
const HEADER_OUTCOME = "X-Koi-Handler-Outcome";

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
    let body;
    try { body = await req.json(); } catch (_e) { return new Response(JSON.stringify({ error: "INVALID_BODY" }), { status: 400 }); }
    const { payload, operationId, requestId } = body || {};
    try {
      const handler = await loadHandler();
      const result = await handler({ payload, operationId, requestId, koi });
      // If the handler itself constructed a Response (e.g. via koi.failPermanent), forward it verbatim.
      if (result instanceof Response) return result;
      return success(result);
    } catch (e) {
      // Non-200 handler responses are forbidden; surface as transient (handler error).
      return new Response(JSON.stringify({ error: String(e && e.message) }), { status: 503, headers: { [HEADER_OUTCOME]: "transient" } });
    }
  },
};
`;
