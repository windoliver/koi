import { describe, expect, it } from "bun:test";
import type { CommandHookConfig, HookConfig } from "@koi/core";
import type { RegisteredHook } from "./policy.js";
import {
  applyPolicy,
  createRegisteredHooks,
  groupByTier,
  tierOrder,
  validateNoDuplicateNames,
} from "./policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHook(name: string): CommandHookConfig {
  return { kind: "command", name, cmd: ["echo", name] };
}

function makeRegistered(name: string, tier: "managed" | "user" | "session"): RegisteredHook {
  return { id: `${tier}:${name}`, tier, hook: makeHook(name) };
}

// ---------------------------------------------------------------------------
// createRegisteredHooks
// ---------------------------------------------------------------------------

describe("createRegisteredHooks", () => {
  it("tags hooks with the given tier and generates stable IDs", () => {
    const hooks: readonly HookConfig[] = [makeHook("audit"), makeHook("log")];
    const result = createRegisteredHooks(hooks, "managed");

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("managed:audit");
    expect(result[0]?.tier).toBe("managed");
    expect(result[0]?.hook.name).toBe("audit");
    expect(result[1]?.id).toBe("managed:log");
    expect(result[1]?.tier).toBe("managed");
  });

  it("returns empty array for empty input", () => {
    expect(createRegisteredHooks([], "user")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyPolicy
// ---------------------------------------------------------------------------

describe("applyPolicy", () => {
  const managed = makeRegistered("audit", "managed");
  const user = makeRegistered("format", "user");
  const session = makeRegistered("temp", "session");
  const all = [managed, user, session];

  describe("disableAllHooks", () => {
    it("kills everything when actor is managed", () => {
      const result = applyPolicy(all, { disableAllHooks: true }, "managed");
      expect(result).toEqual([]);
    });

    it("preserves managed hooks when actor is user", () => {
      const result = applyPolicy(all, { disableAllHooks: true }, "user");
      expect(result).toEqual([managed]);
    });
  });

  describe("managedOnly", () => {
    it("returns only managed-tier hooks", () => {
      const result = applyPolicy(all, { managedOnly: true }, "user");
      expect(result).toEqual([managed]);
    });

    it("returns empty when no managed hooks exist", () => {
      const result = applyPolicy([user, session], { managedOnly: true }, "user");
      expect(result).toEqual([]);
    });
  });

  describe("allowUserHooks", () => {
    it("filters user hooks when false", () => {
      const result = applyPolicy(all, { allowUserHooks: false }, "user");
      expect(result).toEqual([managed, session]);
    });

    it("keeps user hooks when true (explicit)", () => {
      const result = applyPolicy(all, { allowUserHooks: true }, "user");
      expect(result).toEqual(all);
    });

    it("keeps user hooks when undefined (default true)", () => {
      const result = applyPolicy(all, {}, "user");
      expect(result).toEqual(all);
    });
  });

  describe("allowSessionHooks", () => {
    it("filters session hooks when false", () => {
      const result = applyPolicy(all, { allowSessionHooks: false }, "user");
      expect(result).toEqual([managed, user]);
    });
  });

  describe("combined flags", () => {
    it("filters both user and session when both disallowed", () => {
      const result = applyPolicy(all, { allowUserHooks: false, allowSessionHooks: false }, "user");
      expect(result).toEqual([managed]);
    });

    it("disableAllHooks takes precedence over allowUserHooks", () => {
      const result = applyPolicy(all, { disableAllHooks: true, allowUserHooks: true }, "managed");
      expect(result).toEqual([]);
    });

    it("managedOnly takes precedence over allow flags", () => {
      const result = applyPolicy(
        all,
        { managedOnly: true, allowUserHooks: true, allowSessionHooks: true },
        "user",
      );
      expect(result).toEqual([managed]);
    });
  });

  describe("empty input", () => {
    it("returns empty array for empty hooks", () => {
      expect(applyPolicy([], {}, "user")).toEqual([]);
    });
  });

  describe("default policy (no flags)", () => {
    it("returns all hooks unchanged", () => {
      const result = applyPolicy(all, {}, "user");
      expect(result).toEqual(all);
    });
  });
});

// ---------------------------------------------------------------------------
// groupByTier
// ---------------------------------------------------------------------------

describe("groupByTier", () => {
  it("groups hooks by tier preserving declaration order", () => {
    const hooks = [
      makeRegistered("a", "user"),
      makeRegistered("b", "managed"),
      makeRegistered("c", "session"),
      makeRegistered("d", "user"),
      makeRegistered("e", "managed"),
    ];

    const groups = groupByTier(hooks);

    expect(groups.managed.map((rh) => rh.hook.name)).toEqual(["b", "e"]);
    expect(groups.user.map((rh) => rh.hook.name)).toEqual(["a", "d"]);
    expect(groups.session.map((rh) => rh.hook.name)).toEqual(["c"]);
  });

  it("returns empty arrays for missing tiers", () => {
    const hooks = [makeRegistered("x", "managed")];
    const groups = groupByTier(hooks);

    expect(groups.managed).toHaveLength(1);
    expect(groups.user).toEqual([]);
    expect(groups.session).toEqual([]);
  });

  it("handles empty input", () => {
    const groups = groupByTier([]);
    expect(groups.managed).toEqual([]);
    expect(groups.user).toEqual([]);
    expect(groups.session).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tierOrder
// ---------------------------------------------------------------------------

describe("tierOrder", () => {
  it("returns managed, user, session in priority order", () => {
    expect(tierOrder()).toEqual(["managed", "user", "session"]);
  });
});

// ---------------------------------------------------------------------------
// validateNoDuplicateNames
// ---------------------------------------------------------------------------

describe("validateNoDuplicateNames", () => {
  it("succeeds when all names are unique", () => {
    const hooks = [
      makeRegistered("audit", "managed"),
      makeRegistered("format", "user"),
      makeRegistered("temp", "session"),
    ];
    const result = validateNoDuplicateNames(hooks);
    expect(result.ok).toBe(true);
  });

  it("fails when same name appears in different tiers", () => {
    const hooks = [makeRegistered("audit", "managed"), makeRegistered("audit", "user")];
    const result = validateNoDuplicateNames(hooks);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain('"audit"');
      expect(result.error.message).toContain("managed");
      expect(result.error.message).toContain("user");
    }
  });

  it("succeeds with empty array", () => {
    const result = validateNoDuplicateNames([]);
    expect(result.ok).toBe(true);
  });

  it("succeeds with single hook", () => {
    const result = validateNoDuplicateNames([makeRegistered("x", "managed")]);
    expect(result.ok).toBe(true);
  });

  it("allows same name within same tier (backward-compatible)", () => {
    const hooks = [makeRegistered("x", "managed"), makeRegistered("x", "managed")];
    const result = validateNoDuplicateNames(hooks);
    expect(result.ok).toBe(true);
  });
});
