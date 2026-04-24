import { describe, expect, test } from "bun:test";
import {
  computeDispatchKey,
  resolveBinding,
  resolveRoute,
  validateBindingPattern,
} from "../routing.js";
import type { RouteBinding } from "../types.js";

describe("computeDispatchKey", () => {
  test("main mode always returns 'main'", () => {
    expect(computeDispatchKey("main")).toBe("main");
    expect(computeDispatchKey("main", { channel: "x", peer: "y" })).toBe("main");
  });

  test("per-peer uses peer or absent sentinel", () => {
    expect(computeDispatchKey("per-peer", { peer: "p1" })).toBe("p1");
    expect(computeDispatchKey("per-peer")).toBe("%7E"); // '~' encoded
  });

  test("per-channel-peer composes channel:peer", () => {
    expect(computeDispatchKey("per-channel-peer", { channel: "ch", peer: "p1" })).toBe("ch:p1");
    expect(computeDispatchKey("per-channel-peer", { peer: "p1" })).toBe("%7E:p1");
    expect(computeDispatchKey("per-channel-peer")).toBe("%7E:%7E");
  });

  test("per-account-channel-peer composes account:channel:peer", () => {
    expect(
      computeDispatchKey("per-account-channel-peer", { account: "a", channel: "c", peer: "p" }),
    ).toBe("a:c:p");
    expect(computeDispatchKey("per-account-channel-peer")).toBe("%7E:%7E:%7E");
  });

  test("literal underscore in field value is not treated as absent sentinel", () => {
    expect(computeDispatchKey("per-peer", { peer: "_" })).toBe("_");
    expect(computeDispatchKey("per-peer")).not.toBe("_");
  });
});

describe("validateBindingPattern", () => {
  test("valid patterns return undefined", () => {
    expect(validateBindingPattern("acme:*:p")).toBeUndefined();
    expect(validateBindingPattern("**")).toBeUndefined();
    expect(validateBindingPattern("acme:**")).toBeUndefined();
    expect(validateBindingPattern("a:b:c")).toBeUndefined();
  });

  test("** in non-terminal position returns error", () => {
    const msg = validateBindingPattern("**:suffix");
    expect(msg).toBeDefined();
    expect(msg).toContain("**");
  });
});

describe("resolveBinding", () => {
  const bindings: readonly RouteBinding[] = [
    { pattern: "acme:payments:*", agentId: "billing" },
    { pattern: "acme:**", agentId: "fallback-acme" },
    { pattern: "*:*:p99", agentId: "p99-agent" },
  ];

  test("exact wildcard match returns agentId", () => {
    expect(resolveBinding("acme:payments:u1", bindings)).toBe("billing");
  });

  test("tail wildcard ** matches remaining segments", () => {
    expect(resolveBinding("acme:other:anything", bindings)).toBe("fallback-acme");
  });

  test("first match wins", () => {
    // "acme:payments:u1" matches first binding — not the ** one
    expect(resolveBinding("acme:payments:u1", bindings)).toBe("billing");
  });

  test("returns undefined when nothing matches", () => {
    expect(resolveBinding("other:x:y", bindings)).toBeUndefined();
  });

  test("single-segment wildcard does not match across segments", () => {
    // pattern "acme:payments:*" needs exactly 3 segments — "acme:payments" only has 2
    // but "acme:**" also matches 2 segments (** at end is a tail wildcard), so falls through to fallback-acme
    expect(resolveBinding("acme:payments", bindings)).toBe("fallback-acme");
    // a key with no "acme" prefix matches nothing
    expect(resolveBinding("other:payments", bindings)).toBeUndefined();
  });
});

describe("resolveRoute", () => {
  const bindings: readonly RouteBinding[] = [{ pattern: "ch1:u1", agentId: "agent-a" }];
  const config = { scopingMode: "per-channel-peer" as const, bindings };

  test("no config → fallback with dispatchKey 'main'", () => {
    const r = resolveRoute(undefined, { channel: "ch1", peer: "u1" }, "fallback");
    expect(r.agentId).toBe("fallback");
    expect(r.dispatchKey).toBe("main");
  });

  test("matching binding returns bound agentId", () => {
    const r = resolveRoute(config, { channel: "ch1", peer: "u1" }, "fallback");
    expect(r.agentId).toBe("agent-a");
    expect(r.dispatchKey).toBe("ch1:u1");
  });

  test("no matching binding → fallback agentId", () => {
    const r = resolveRoute(config, { channel: "ch2", peer: "u1" }, "fallback");
    expect(r.agentId).toBe("fallback");
    expect(r.dispatchKey).toBe("ch2:u1");
  });
});
