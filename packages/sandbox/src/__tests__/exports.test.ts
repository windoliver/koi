import { describe, expect, test } from "bun:test";

/**
 * Export inventory — compile-time regression guard.
 * If any export is removed, this file will fail to compile.
 */

import type { ExecuteOptions, PlatformInfo, SandboxProcess, SpawnOptions } from "../index.js";

import {
  checkAvailability,
  createOsAdapter,
  execute,
  permissiveProfile,
  profileForTier,
  restrictiveProfile,
  spawn,
} from "../index.js";

// Prevent type imports from being optimized away
type AssertDefined<T> = T extends undefined ? never : T;
type _TypeGuard =
  | AssertDefined<ExecuteOptions>
  | AssertDefined<PlatformInfo>
  | AssertDefined<SandboxProcess>
  | AssertDefined<SpawnOptions>;

describe("export inventory", () => {
  test("all runtime values are defined", () => {
    expect(createOsAdapter).toBeDefined();
    expect(checkAvailability).toBeDefined();
    expect(execute).toBeDefined();
    expect(spawn).toBeDefined();
    expect(restrictiveProfile).toBeDefined();
    expect(permissiveProfile).toBeDefined();
    expect(profileForTier).toBeDefined();
  });

  test("runtime values are functions", () => {
    expect(typeof createOsAdapter).toBe("function");
    expect(typeof checkAvailability).toBe("function");
    expect(typeof execute).toBe("function");
    expect(typeof spawn).toBe("function");
    expect(typeof restrictiveProfile).toBe("function");
    expect(typeof permissiveProfile).toBe("function");
    expect(typeof profileForTier).toBe("function");
  });
});
