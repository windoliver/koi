import { describe, expect, it } from "bun:test";
import type { PermissionQuery } from "@koi/core";
import { matchesZone } from "./zone-match.js";
import type { ApprovalZone } from "./zone-types.js";

const baseQuery: PermissionQuery = {
  principal: "agent:main",
  action: "read",
  resource: "/proj/src/foo.ts",
};

describe("matchesZone", () => {
  it("matches when no match fields are set (catch-all zone)", () => {
    const zone: ApprovalZone = { name: "all", match: {}, action: "auto" };
    expect(matchesZone(baseQuery, zone)).toBe(true);
  });

  it("matches tool glob", () => {
    const zone: ApprovalZone = { name: "z", match: { tools: ["read", "glob"] }, action: "auto" };
    expect(matchesZone(baseQuery, zone)).toBe(true);
    expect(matchesZone({ ...baseQuery, action: "write" }, zone)).toBe(false);
  });

  it("matches path glob with **", () => {
    const zone: ApprovalZone = { name: "z", match: { paths: ["**/*.test.ts"] }, action: "auto" };
    expect(matchesZone({ ...baseQuery, resource: "/a/b/x.test.ts" }, zone)).toBe(true);
    expect(matchesZone({ ...baseQuery, resource: "/a/b/x.ts" }, zone)).toBe(false);
  });

  it("requires ALL match fields to pass (AND across fields)", () => {
    const zone: ApprovalZone = {
      name: "z",
      match: { tools: ["read"], paths: ["**/*.ts"] },
      action: "auto",
    };
    expect(matchesZone(baseQuery, zone)).toBe(true);
    expect(matchesZone({ ...baseQuery, action: "write" }, zone)).toBe(false);
    expect(matchesZone({ ...baseQuery, resource: "/x.py" }, zone)).toBe(false);
  });

  it("matches args predicate via context", () => {
    const zone: ApprovalZone = {
      name: "z",
      match: { args: { branch: "feature/*" } },
      action: "auto",
    };
    const q: PermissionQuery = { ...baseQuery, context: { branch: "feature/x" } };
    expect(matchesZone(q, zone)).toBe(true);
    expect(matchesZone({ ...baseQuery, context: { branch: "main" } }, zone)).toBe(false);
    expect(matchesZone(baseQuery, zone)).toBe(false); // missing context key
  });

  it("returns false when context is non-string for an args predicate", () => {
    const zone: ApprovalZone = {
      name: "z",
      match: { args: { count: "5" } },
      action: "auto",
    };
    const q: PermissionQuery = { ...baseQuery, context: { count: 5 } };
    expect(matchesZone(q, zone)).toBe(false);
  });

  it("requires ALL extraPaths to match when paths is set (no single-path bypass)", () => {
    const zone: ApprovalZone = {
      name: "tmp-only",
      match: { paths: ["/tmp/**"] },
      action: "auto",
    };
    expect(
      matchesZone(
        { ...baseQuery, resource: "/tmp/ok", context: { extraPaths: ["/tmp/also"] } },
        zone,
      ),
    ).toBe(true);
    expect(
      matchesZone(
        { ...baseQuery, resource: "/tmp/ok", context: { extraPaths: ["/etc/passwd"] } },
        zone,
      ),
    ).toBe(false);
    expect(
      matchesZone(
        {
          ...baseQuery,
          resource: "/tmp/ok",
          context: { extraPaths: ["/tmp/x", "/outside/root"] },
        },
        zone,
      ),
    ).toBe(false);
  });
});
