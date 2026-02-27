import { describe, expect, test } from "bun:test";
import type { BrickRequires } from "@koi/core";
import type { NetworkPolicy } from "./requires-check.js";
import { checkBrickRequires } from "./requires-check.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A binary guaranteed to exist on any Unix-like system. */
const PRESENT_BIN = "sh";
/** A binary that will never exist. */
const MISSING_BIN = "__nonexistent_binary_xyz_123__";

/** An env var guaranteed to be set. */
const PRESENT_ENV = "PATH";
/** An env var that will never be set. */
const MISSING_ENV = "__KOI_NONEXISTENT_ENV_VAR_XYZ__";

const EMPTY_TOOLS: ReadonlySet<string> = new Set();
const TOOLS_WITH_FOO: ReadonlySet<string> = new Set(["foo"]);

// ---------------------------------------------------------------------------
// Satisfied (no-op) cases
// ---------------------------------------------------------------------------

describe("checkBrickRequires", () => {
  describe("satisfied when nothing to check", () => {
    test.each([
      { label: "undefined requires", requires: undefined },
      { label: "empty requires object", requires: {} },
    ])("$label", ({ requires }) => {
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(true);
      expect(result.violation).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // bins
  // -------------------------------------------------------------------------

  describe("bins", () => {
    test("satisfied when binary is present", () => {
      const requires: BrickRequires = { bins: [PRESENT_BIN] };
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(true);
    });

    test("violation when binary is missing", () => {
      const requires: BrickRequires = { bins: [MISSING_BIN] };
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(false);
      expect(result.violation).toEqual({ kind: "bin", name: MISSING_BIN });
    });

    test("reports first missing binary when multiple are absent", () => {
      const requires: BrickRequires = { bins: [MISSING_BIN, "__also_missing__"] };
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(false);
      expect(result.violation).toEqual({ kind: "bin", name: MISSING_BIN });
    });
  });

  // -------------------------------------------------------------------------
  // env
  // -------------------------------------------------------------------------

  describe("env", () => {
    test("satisfied when env var is set", () => {
      const requires: BrickRequires = { env: [PRESENT_ENV] };
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(true);
    });

    test("violation when env var is missing", () => {
      const requires: BrickRequires = { env: [MISSING_ENV] };
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(false);
      expect(result.violation).toEqual({ kind: "env", name: MISSING_ENV });
    });

    test("reports first missing env var", () => {
      const requires: BrickRequires = { env: [MISSING_ENV, "__ALSO_MISSING__"] };
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(false);
      expect(result.violation).toEqual({ kind: "env", name: MISSING_ENV });
    });
  });

  // -------------------------------------------------------------------------
  // tools
  // -------------------------------------------------------------------------

  describe("tools", () => {
    test("satisfied when tool is available", () => {
      const requires: BrickRequires = { tools: ["foo"] };
      const result = checkBrickRequires(requires, TOOLS_WITH_FOO);
      expect(result.satisfied).toBe(true);
    });

    test("violation when tool is missing", () => {
      const requires: BrickRequires = { tools: ["bar"] };
      const result = checkBrickRequires(requires, TOOLS_WITH_FOO);
      expect(result.satisfied).toBe(false);
      expect(result.violation).toEqual({ kind: "tool", name: "bar" });
    });
  });

  // -------------------------------------------------------------------------
  // packages
  // -------------------------------------------------------------------------

  describe("packages", () => {
    test("satisfied when package is resolvable", () => {
      // "bun:test" is always resolvable in a Bun environment
      const requires: BrickRequires = { packages: { "bun:test": "0.0.0" } };
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(true);
    });

    test("violation when package is not resolvable", () => {
      const requires: BrickRequires = {
        packages: { __koi_nonexistent_pkg_xyz_999__: "1.0.0" },
      };
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(false);
      expect(result.violation).toEqual({
        kind: "package",
        name: "__koi_nonexistent_pkg_xyz_999__",
      });
    });

    test("reports first unresolvable package", () => {
      const requires: BrickRequires = {
        packages: {
          __koi_missing_a__: "1.0.0",
          __koi_missing_b__: "2.0.0",
        },
      };
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(false);
      expect(result.violation?.kind).toBe("package");
      expect(result.violation?.name).toBe("__koi_missing_a__");
    });
  });

  // -------------------------------------------------------------------------
  // network
  // -------------------------------------------------------------------------

  describe("network", () => {
    test("satisfied when brick does not require network", () => {
      const requires: BrickRequires = { network: false };
      const policy: NetworkPolicy = { allowed: false };
      const result = checkBrickRequires(requires, EMPTY_TOOLS, policy);
      expect(result.satisfied).toBe(true);
    });

    test("satisfied when brick requires network and policy allows", () => {
      const requires: BrickRequires = { network: true };
      const policy: NetworkPolicy = { allowed: true };
      const result = checkBrickRequires(requires, EMPTY_TOOLS, policy);
      expect(result.satisfied).toBe(true);
    });

    test("violation when brick requires network but policy disallows", () => {
      const requires: BrickRequires = { network: true };
      const policy: NetworkPolicy = { allowed: false };
      const result = checkBrickRequires(requires, EMPTY_TOOLS, policy);
      expect(result.satisfied).toBe(false);
      expect(result.violation).toEqual({ kind: "network", name: "network" });
    });

    test("satisfied when brick requires network and no policy provided", () => {
      const requires: BrickRequires = { network: true };
      const result = checkBrickRequires(requires, EMPTY_TOOLS);
      expect(result.satisfied).toBe(true);
    });

    test("satisfied when network field is undefined regardless of policy", () => {
      const requires: BrickRequires = {};
      const policy: NetworkPolicy = { allowed: false };
      const result = checkBrickRequires(requires, EMPTY_TOOLS, policy);
      expect(result.satisfied).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // All fields satisfied together
  // -------------------------------------------------------------------------

  describe("combined requirements", () => {
    test("satisfied when all five requirement kinds pass", () => {
      const requires: BrickRequires = {
        bins: [PRESENT_BIN],
        env: [PRESENT_ENV],
        tools: ["foo"],
        packages: { "bun:test": "0.0.0" },
        network: true,
      };
      const policy: NetworkPolicy = { allowed: true };
      const result = checkBrickRequires(requires, TOOLS_WITH_FOO, policy);
      expect(result.satisfied).toBe(true);
      expect(result.violation).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Fail-fast ordering
  // -------------------------------------------------------------------------

  describe("fail-fast ordering", () => {
    test("bins fails before env", () => {
      const requires: BrickRequires = {
        bins: [MISSING_BIN],
        env: [MISSING_ENV],
        tools: ["missing"],
        packages: { __koi_missing__: "1.0.0" },
        network: true,
      };
      const policy: NetworkPolicy = { allowed: false };
      const result = checkBrickRequires(requires, EMPTY_TOOLS, policy);
      expect(result.satisfied).toBe(false);
      expect(result.violation?.kind).toBe("bin");
    });

    test("env fails before tools when bins pass", () => {
      const requires: BrickRequires = {
        bins: [PRESENT_BIN],
        env: [MISSING_ENV],
        tools: ["missing"],
        packages: { __koi_missing__: "1.0.0" },
        network: true,
      };
      const policy: NetworkPolicy = { allowed: false };
      const result = checkBrickRequires(requires, EMPTY_TOOLS, policy);
      expect(result.satisfied).toBe(false);
      expect(result.violation?.kind).toBe("env");
    });

    test("tools fails before packages when bins and env pass", () => {
      const requires: BrickRequires = {
        bins: [PRESENT_BIN],
        env: [PRESENT_ENV],
        tools: ["missing"],
        packages: { __koi_missing__: "1.0.0" },
        network: true,
      };
      const policy: NetworkPolicy = { allowed: false };
      const result = checkBrickRequires(requires, EMPTY_TOOLS, policy);
      expect(result.satisfied).toBe(false);
      expect(result.violation?.kind).toBe("tool");
    });

    test("packages fails before network when bins, env, and tools pass", () => {
      const requires: BrickRequires = {
        bins: [PRESENT_BIN],
        env: [PRESENT_ENV],
        tools: ["foo"],
        packages: { __koi_missing__: "1.0.0" },
        network: true,
      };
      const policy: NetworkPolicy = { allowed: false };
      const result = checkBrickRequires(requires, TOOLS_WITH_FOO, policy);
      expect(result.satisfied).toBe(false);
      expect(result.violation?.kind).toBe("package");
    });

    test("network fails last when all other checks pass", () => {
      const requires: BrickRequires = {
        bins: [PRESENT_BIN],
        env: [PRESENT_ENV],
        tools: ["foo"],
        packages: { "bun:test": "0.0.0" },
        network: true,
      };
      const policy: NetworkPolicy = { allowed: false };
      const result = checkBrickRequires(requires, TOOLS_WITH_FOO, policy);
      expect(result.satisfied).toBe(false);
      expect(result.violation?.kind).toBe("network");
    });
  });
});
