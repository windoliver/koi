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

  it("handler runner enforces a timestamp skew tolerance", () => {
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("SKEW_TOLERANCE_SEC");
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("STALE_REQUEST");
  });
});
