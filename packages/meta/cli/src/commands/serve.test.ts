/**
 * guardConfig is a pure pre-flight policy gate that prevents `koi serve`
 * from booting in unsafe combinations. The unit tests pin its truth table
 * so that no future flag tweak silently weakens the auth posture.
 */

import { describe, expect, test } from "bun:test";
import type { ServeFlags } from "../args/serve.js";
import { guardConfig } from "./serve.js";

function flags(overrides: Partial<ServeFlags> = {}): ServeFlags {
  return {
    command: "serve" as const,
    help: false,
    version: false,
    manifest: undefined,
    port: undefined,
    verbose: false,
    logFormat: "text",
    nexusUrl: undefined,
    nexusApiKey: undefined,
    unsafeDevAuth: false,
    ...overrides,
  };
}

describe("guardConfig", () => {
  test("refuses to start without --unsafe-dev-auth (no production authenticator wired)", () => {
    const r = guardConfig(flags(), false);
    expect(r).toBeDefined();
    expect(r).toMatch(/no production authenticator/i);
  });

  test("refuses --unsafe-dev-auth combined with Nexus HA (would write unauthenticated sessions)", () => {
    const r = guardConfig(flags({ unsafeDevAuth: true }), true);
    expect(r).toBeDefined();
    expect(r).toMatch(/refusing --unsafe-dev-auth/i);
    expect(r).toMatch(/--nexus-url/);
  });

  test("permits --unsafe-dev-auth alone (loopback dev)", () => {
    const r = guardConfig(flags({ unsafeDevAuth: true }), false);
    expect(r).toBeUndefined();
  });

  test("auth gate fires before HA combo (unsafe-only error wins)", () => {
    // unsafeDevAuth=false, useNexus=true → still the auth-missing error;
    // the HA combo error is only reachable once unsafeDevAuth is true.
    const r = guardConfig(flags({ unsafeDevAuth: false }), true);
    expect(r).toBeDefined();
    expect(r).toMatch(/no production authenticator/i);
  });

  test("guard fires on --nexus-url even WITHOUT --nexus-api-key (intent, not wiring)", () => {
    // Caller passes wantsNexus=true derived solely from `nexusUrl !== undefined`.
    // The combo refusal must fire so a user cannot bypass the guard by omitting
    // the API key. Round-2 finding 5.
    const r = guardConfig(flags({ unsafeDevAuth: true }), true);
    expect(r).toBeDefined();
    expect(r).toMatch(/refusing --unsafe-dev-auth/i);
  });
});
