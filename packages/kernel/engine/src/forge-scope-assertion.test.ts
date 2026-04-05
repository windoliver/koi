/**
 * Tests for assertProviderScopeConsistency — Issue 8 / Issue #1240.
 *
 * Verifies the dev-time assertion that prevents ComponentProviders from
 * registering tools with a ForgeScope inconsistent with their priority.
 */

import { describe, expect, test } from "bun:test";
import { COMPONENT_PRIORITY } from "@koi/core";
import { assertProviderScopeConsistency } from "./forge-scope-assertion.js";

describe("assertProviderScopeConsistency", () => {
  // AGENT_FORGED (0) — only "agent" scope allowed
  test("AGENT_FORGED provider with agent-scoped tool passes", () => {
    expect(() =>
      assertProviderScopeConsistency("my-provider", COMPONENT_PRIORITY.AGENT_FORGED, {
        "my-tool": "agent",
      }),
    ).not.toThrow();
  });

  test("AGENT_FORGED provider with zone-scoped tool throws", () => {
    expect(() =>
      assertProviderScopeConsistency("my-provider", COMPONENT_PRIORITY.AGENT_FORGED, {
        "my-tool": "zone",
      }),
    ).toThrow(/zone.*not allowed/);
  });

  test("AGENT_FORGED provider with global-scoped tool throws", () => {
    expect(() =>
      assertProviderScopeConsistency("my-provider", COMPONENT_PRIORITY.AGENT_FORGED, {
        "my-tool": "global",
      }),
    ).toThrow(/global.*not allowed/);
  });

  // ZONE_FORGED (10) — "agent" and "zone" allowed
  test("ZONE_FORGED provider with zone-scoped tool passes", () => {
    expect(() =>
      assertProviderScopeConsistency("my-provider", COMPONENT_PRIORITY.ZONE_FORGED, {
        "my-tool": "zone",
      }),
    ).not.toThrow();
  });

  test("ZONE_FORGED provider with agent-scoped tool passes (agent ⊆ zone)", () => {
    expect(() =>
      assertProviderScopeConsistency("my-provider", COMPONENT_PRIORITY.ZONE_FORGED, {
        "my-tool": "agent",
      }),
    ).not.toThrow();
  });

  test("ZONE_FORGED provider with global-scoped tool throws", () => {
    expect(() =>
      assertProviderScopeConsistency("my-provider", COMPONENT_PRIORITY.ZONE_FORGED, {
        "my-tool": "global",
      }),
    ).toThrow(/global.*not allowed/);
  });

  // GLOBAL_FORGED (50) — all scopes allowed
  test("GLOBAL_FORGED provider accepts any scope", () => {
    expect(() =>
      assertProviderScopeConsistency("my-provider", COMPONENT_PRIORITY.GLOBAL_FORGED, {
        "tool-a": "agent",
        "tool-b": "zone",
        "tool-c": "global",
      }),
    ).not.toThrow();
  });

  // BUNDLED (100) — no restriction
  test("BUNDLED provider accepts any scope (primordial)", () => {
    expect(() =>
      assertProviderScopeConsistency("my-provider", COMPONENT_PRIORITY.BUNDLED, {
        "tool-a": "agent",
        "tool-b": "global",
      }),
    ).not.toThrow();
  });

  // Error message quality
  test("error message includes provider name, priority label, and violating tool name", () => {
    let caught: Error | undefined;
    try {
      assertProviderScopeConsistency("bad-forge-provider", COMPONENT_PRIORITY.AGENT_FORGED, {
        "secret-tool": "global",
      });
    } catch (e: unknown) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain("bad-forge-provider");
    expect(caught?.message).toContain("AGENT_FORGED");
    expect(caught?.message).toContain("secret-tool");
  });

  // Multiple violations reported together
  test("reports all violating tools in one error (not just the first)", () => {
    expect(() =>
      assertProviderScopeConsistency("multi-bad-provider", COMPONENT_PRIORITY.AGENT_FORGED, {
        "tool-ok": "agent",
        "tool-bad-1": "zone",
        "tool-bad-2": "global",
      }),
    ).toThrow(/tool-bad-1.*tool-bad-2|tool-bad-2.*tool-bad-1/);
  });

  // Empty toolScopes is always valid
  test("empty toolScopes never throws", () => {
    expect(() =>
      assertProviderScopeConsistency("empty-provider", COMPONENT_PRIORITY.AGENT_FORGED, {}),
    ).not.toThrow();
  });
});
