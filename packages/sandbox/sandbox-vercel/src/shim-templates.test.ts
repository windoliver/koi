import { describe, expect, it } from "bun:test";

import { GATEWAY_SHIM_SOURCE, HANDLER_RUNNER_SHIM_SOURCE } from "./shim-templates.js";

describe("shim-templates", () => {
  it("gateway template references signing key + handler URL", () => {
    expect(GATEWAY_SHIM_SOURCE).toContain("KOI_PAIR_SIGNING_KEY_PEM");
    expect(GATEWAY_SHIM_SOURCE).toContain("KOI_HANDLER_URL");
    expect(GATEWAY_SHIM_SOURCE).toContain("Ed25519");
    expect(GATEWAY_SHIM_SOURCE).toContain("X-Koi-Signature");
  });

  it("gateway template does NOT embed verify key (asymmetric)", () => {
    expect(GATEWAY_SHIM_SOURCE).not.toContain("KOI_PAIR_VERIFY_KEY_PEM");
  });

  it("handler runner references verify key + signature header", () => {
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("KOI_PAIR_VERIFY_KEY_PEM");
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("X-Koi-Signature");
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("crypto.subtle.verify");
  });

  it("handler runner does NOT embed signing key or KV creds", () => {
    expect(HANDLER_RUNNER_SHIM_SOURCE).not.toContain("KOI_PAIR_SIGNING_KEY_PEM");
    expect(HANDLER_RUNNER_SHIM_SOURCE).not.toContain("KOI_KV_TOKEN");
    expect(HANDLER_RUNNER_SHIM_SOURCE).not.toContain("KOI_KV_URL");
  });

  it("handler runner loads the operator via dynamic import (deferred until after fence install)", () => {
    expect(HANDLER_RUNNER_SHIM_SOURCE).not.toContain('import handler from "./handler.js"');
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain('import("./handler.js")');
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("loadHandler");
  });

  it("gateway and handler runner bind the same canonical tuple as buildCanonicalSigningString", () => {
    // Both must use [METHOD, path, operationId, requestId, nonce, timestampSec, bodyHash].
    // The third slot is operationId (NOT a hardcoded literal like "invoke") — otherwise
    // helpers and verifier disagree and signatures fail at runtime.
    expect(GATEWAY_SHIM_SOURCE).toContain('["POST", url.pathname, operationId,');
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain('["POST", url.pathname, opId,');
    expect(GATEWAY_SHIM_SOURCE).not.toContain('"POST", url.pathname, "invoke",');
    expect(HANDLER_RUNNER_SHIM_SOURCE).not.toContain('"POST", url.pathname, "invoke",');
  });

  it("gateway sends x-vercel-protection-bypass header when token is configured", () => {
    expect(GATEWAY_SHIM_SOURCE).toContain("KOI_VERCEL_BYPASS_TOKEN");
    expect(GATEWAY_SHIM_SOURCE).toContain("x-vercel-protection-bypass");
  });

  it("gateway does NOT cache transient/non-200 handler responses as success", () => {
    expect(GATEWAY_SHIM_SOURCE).toContain('handlerResp.status !== 200 || outcome !== "success"');
    expect(GATEWAY_SHIM_SOURCE).toContain("HANDLER_TRANSIENT");
  });

  it("handler runner burns nonces in pair-scoped KV to prevent replay within the skew window", () => {
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("KOI_PAIR_NONCE_KV_URL");
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("KOI_PAIR_NONCE_KV_TOKEN");
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("NONCE_REPLAY");
    // SET-NX form ensures atomic burn semantics.
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("NX&EX=");
  });

  it("handler runner enforces a timestamp skew tolerance", () => {
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("SKEW_TOLERANCE_SEC");
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("STALE_REQUEST");
  });
});
