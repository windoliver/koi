import { describe, expect, it } from "bun:test";

import { GATEWAY_SHIM_SOURCE, HANDLER_RUNNER_SHIM_SOURCE } from "./shim-templates.js";

describe("GATEWAY_SHIM_SOURCE", () => {
  it("verifies KOI_INSTANCE_TOKEN before processing the request", () => {
    expect(GATEWAY_SHIM_SOURCE).toContain("env.KOI_INSTANCE_TOKEN");
  });

  it("namespaces the dedupe key with KOI_OWNER_ID", () => {
    expect(GATEWAY_SHIM_SOURCE).toContain("env.KOI_OWNER_ID");
    expect(GATEWAY_SHIM_SOURCE).toContain('":" + operationId');
  });

  it("forwards to the handler runner via Service Binding", () => {
    expect(GATEWAY_SHIM_SOURCE).toContain("env.HANDLER_RUNNER.fetch");
  });

  it("emits operation-id-conflict / operation-expired / completed paths", () => {
    expect(GATEWAY_SHIM_SOURCE).toContain('"fingerprint-conflict"');
    expect(GATEWAY_SHIM_SOURCE).toContain('"operation-expired"');
    expect(GATEWAY_SHIM_SOURCE).toContain('"completed"');
    expect(GATEWAY_SHIM_SOURCE).toContain('"failed-permanent"');
  });

  it("parses as ESM via Bun.Transpiler without throwing", () => {
    expect(() =>
      new Bun.Transpiler({ loader: "js" }).transformSync(GATEWAY_SHIM_SOURCE),
    ).not.toThrow();
  });
});

describe("HANDLER_RUNNER_SHIM_SOURCE", () => {
  it("loads the operator handler via dynamic import (deferred until after fence install)", () => {
    expect(HANDLER_RUNNER_SHIM_SOURCE).not.toContain('import handler from "./handler.js"');
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain('import("./handler.js")');
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("loadHandler");
  });

  it("exposes a `koi.failPermanent` helper that sets the outcome header", () => {
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("koi");
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain('"failed-permanent"');
    expect(HANDLER_RUNNER_SHIM_SOURCE).toContain("X-Koi-Handler-Outcome");
  });

  it("contains NO direct reference to dedupe credentials or DO bindings", () => {
    expect(HANDLER_RUNNER_SHIM_SOURCE).not.toContain("KOI_INSTANCE_TOKEN");
    expect(HANDLER_RUNNER_SHIM_SOURCE).not.toContain("KOI_DEDUPE_DO");
    expect(HANDLER_RUNNER_SHIM_SOURCE).not.toContain("KOI_DEDUPE_KV_TOKEN");
  });
});
