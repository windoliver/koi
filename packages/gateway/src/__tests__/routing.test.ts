import { describe, expect, test } from "bun:test";
import { computeDispatchKey, resolveBinding, resolveRoute, validateBindingPattern } from "../routing.js";
import type { RouteBinding, RoutingConfig, RoutingContext } from "../types.js";

// ---------------------------------------------------------------------------
// computeDispatchKey
// ---------------------------------------------------------------------------

describe("computeDispatchKey", () => {
  test("main mode always returns 'main'", () => {
    expect(computeDispatchKey("main")).toBe("main");
    expect(computeDispatchKey("main", { peer: "p1" })).toBe("main");
    expect(computeDispatchKey("main", { channel: "c1", peer: "p1" })).toBe("main");
  });

  test("per-peer returns peer", () => {
    expect(computeDispatchKey("per-peer", { peer: "user-42" })).toBe("user-42");
  });

  test("per-peer defaults missing peer to '_'", () => {
    expect(computeDispatchKey("per-peer")).toBe("_");
    expect(computeDispatchKey("per-peer", {})).toBe("_");
  });

  test("per-channel-peer returns channel:peer", () => {
    expect(computeDispatchKey("per-channel-peer", { channel: "slack", peer: "u1" })).toBe("slack:u1");
  });

  test("per-channel-peer defaults missing segments to '_'", () => {
    expect(computeDispatchKey("per-channel-peer", { peer: "u1" })).toBe("_:u1");
    expect(computeDispatchKey("per-channel-peer", { channel: "slack" })).toBe("slack:_");
    expect(computeDispatchKey("per-channel-peer")).toBe("_:_");
  });

  test("per-account-channel-peer returns account:channel:peer", () => {
    expect(
      computeDispatchKey("per-account-channel-peer", {
        account: "acme",
        channel: "slack",
        peer: "u1",
      }),
    ).toBe("acme:slack:u1");
  });

  test("per-account-channel-peer defaults missing segments to '_'", () => {
    expect(computeDispatchKey("per-account-channel-peer")).toBe("_:_:_");
    expect(computeDispatchKey("per-account-channel-peer", { peer: "u1" })).toBe("_:_:u1");
    expect(
      computeDispatchKey("per-account-channel-peer", { account: "acme" }),
    ).toBe("acme:_:_");
  });
});

// ---------------------------------------------------------------------------
// resolveBinding
// ---------------------------------------------------------------------------

describe("resolveBinding", () => {
  const bindings: readonly RouteBinding[] = [
    { pattern: "slack:support", agentId: "support-bot" },
    { pattern: "slack:*", agentId: "slack-general" },
    { pattern: "discord:**", agentId: "discord-handler" },
    { pattern: "*:billing", agentId: "billing-bot" },
  ];

  test("exact match returns agentId", () => {
    expect(resolveBinding("slack:support", bindings)).toBe("support-bot");
  });

  test("* wildcard matches any single segment", () => {
    expect(resolveBinding("slack:random", bindings)).toBe("slack-general");
    expect(resolveBinding("slack:eng", bindings)).toBe("slack-general");
  });

  test("** glob matches remaining segments", () => {
    expect(resolveBinding("discord:gaming", bindings)).toBe("discord-handler");
    expect(resolveBinding("discord:gaming:voice", bindings)).toBe("discord-handler");
  });

  test("* matches single segment in any position", () => {
    expect(resolveBinding("teams:billing", bindings)).toBe("billing-bot");
    expect(resolveBinding("irc:billing", bindings)).toBe("billing-bot");
  });

  test("first match wins", () => {
    // "slack:support" matches both exact and "slack:*", but exact comes first
    expect(resolveBinding("slack:support", bindings)).toBe("support-bot");
  });

  test("no match returns undefined", () => {
    expect(resolveBinding("telegram:general", bindings)).toBeUndefined();
    expect(resolveBinding("main", bindings)).toBeUndefined();
  });

  test("empty bindings returns undefined", () => {
    expect(resolveBinding("slack:support", [])).toBeUndefined();
  });

  test("single segment exact match", () => {
    const singleBindings: readonly RouteBinding[] = [
      { pattern: "user-42", agentId: "personal-agent" },
    ];
    expect(resolveBinding("user-42", singleBindings)).toBe("personal-agent");
    expect(resolveBinding("user-99", singleBindings)).toBeUndefined();
  });

  test("** at start matches everything", () => {
    const catchAll: readonly RouteBinding[] = [
      { pattern: "**", agentId: "catch-all" },
    ];
    expect(resolveBinding("anything", catchAll)).toBe("catch-all");
    expect(resolveBinding("a:b:c", catchAll)).toBe("catch-all");
  });

  test("pattern longer than key does not match", () => {
    const longPattern: readonly RouteBinding[] = [
      { pattern: "a:b:c", agentId: "long" },
    ];
    expect(resolveBinding("a:b", longPattern)).toBeUndefined();
    expect(resolveBinding("a", longPattern)).toBeUndefined();
  });

  test("key longer than pattern without ** does not match", () => {
    const shortPattern: readonly RouteBinding[] = [
      { pattern: "a:b", agentId: "short" },
    ];
    expect(resolveBinding("a:b:c", shortPattern)).toBeUndefined();
  });

  test("** in non-terminal position throws", () => {
    const badBindings: readonly RouteBinding[] = [
      { pattern: "**:billing", agentId: "bad" },
    ];
    expect(() => resolveBinding("a:billing", badBindings)).toThrow(
      /must be the last segment/,
    );
  });
});

// ---------------------------------------------------------------------------
// validateBindingPattern
// ---------------------------------------------------------------------------

describe("validateBindingPattern", () => {
  test("valid patterns return undefined", () => {
    expect(validateBindingPattern("slack:*")).toBeUndefined();
    expect(validateBindingPattern("**")).toBeUndefined();
    expect(validateBindingPattern("discord:**")).toBeUndefined();
    expect(validateBindingPattern("a:b:c")).toBeUndefined();
    expect(validateBindingPattern("main")).toBeUndefined();
  });

  test("** in non-terminal position returns error", () => {
    expect(validateBindingPattern("**:billing")).toContain("must be the last segment");
    expect(validateBindingPattern("a:**:c")).toContain("must be the last segment");
  });
});

// ---------------------------------------------------------------------------
// resolveRoute
// ---------------------------------------------------------------------------

describe("resolveRoute", () => {
  test("undefined config returns fallback agentId with 'main' dispatch key", () => {
    const result = resolveRoute(undefined, { peer: "u1" }, "fallback-agent");
    expect(result.agentId).toBe("fallback-agent");
    expect(result.dispatchKey).toBe("main");
  });

  test("binding match overrides fallback agentId", () => {
    const config: RoutingConfig = {
      scopingMode: "per-channel-peer",
      bindings: [
        { pattern: "slack:*", agentId: "slack-agent" },
      ],
    };
    const routing: RoutingContext = { channel: "slack", peer: "u1" };
    const result = resolveRoute(config, routing, "fallback-agent");
    expect(result.agentId).toBe("slack-agent");
    expect(result.dispatchKey).toBe("slack:u1");
  });

  test("no binding match falls back to fallback agentId", () => {
    const config: RoutingConfig = {
      scopingMode: "per-channel-peer",
      bindings: [
        { pattern: "slack:*", agentId: "slack-agent" },
      ],
    };
    const routing: RoutingContext = { channel: "discord", peer: "u1" };
    const result = resolveRoute(config, routing, "fallback-agent");
    expect(result.agentId).toBe("fallback-agent");
    expect(result.dispatchKey).toBe("discord:u1");
  });

  test("config with no bindings uses fallback", () => {
    const config: RoutingConfig = { scopingMode: "per-peer" };
    const routing: RoutingContext = { peer: "u1" };
    const result = resolveRoute(config, routing, "fallback-agent");
    expect(result.agentId).toBe("fallback-agent");
    expect(result.dispatchKey).toBe("u1");
  });

  test("config with empty bindings array uses fallback", () => {
    const config: RoutingConfig = { scopingMode: "per-peer", bindings: [] };
    const routing: RoutingContext = { peer: "u1" };
    const result = resolveRoute(config, routing, "fallback-agent");
    expect(result.agentId).toBe("fallback-agent");
    expect(result.dispatchKey).toBe("u1");
  });

  test("main scoping mode with bindings still matches against 'main' key", () => {
    const config: RoutingConfig = {
      scopingMode: "main",
      bindings: [
        { pattern: "main", agentId: "main-agent" },
      ],
    };
    const result = resolveRoute(config, { peer: "u1" }, "fallback-agent");
    expect(result.agentId).toBe("main-agent");
    expect(result.dispatchKey).toBe("main");
  });

  test("undefined routing uses default segments", () => {
    const config: RoutingConfig = {
      scopingMode: "per-account-channel-peer",
      bindings: [
        { pattern: "_:_:_", agentId: "default-agent" },
      ],
    };
    const result = resolveRoute(config, undefined, "fallback-agent");
    expect(result.agentId).toBe("default-agent");
    expect(result.dispatchKey).toBe("_:_:_");
  });
});
