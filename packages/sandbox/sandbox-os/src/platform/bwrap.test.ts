import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";

import type { SandboxProfile } from "@koi/core";

import { buildBwrapPrefix, buildBwrapSuffix, buildSystemdRunArgs } from "./bwrap.js";

const BASE_PROFILE: SandboxProfile = {
  filesystem: {
    defaultReadAccess: "open",
  },
  network: {
    allow: false,
  },
  resources: {},
};

// ---------------------------------------------------------------------------
// Temp directories — buildBwrapPrefix only emits --tmpfs for paths that exist,
// so tests that check for --tmpfs output must ensure the paths exist on disk.
// ---------------------------------------------------------------------------
const TMPDIR = "/tmp/koi-bwrap-test";
const DENY_PATH = `${TMPDIR}/home/user/.ssh`; // simulates ~/.ssh

beforeAll(() => {
  if (process.platform !== "linux") return;
  mkdirSync(DENY_PATH, { recursive: true });
  // parent dirs used in closed-mode tests
  mkdirSync(`${TMPDIR}/home/user/projects`, { recursive: true });
});

afterAll(() => {
  if (process.platform !== "linux") return;
  rmSync(TMPDIR, { recursive: true, force: true });
});

describe("buildBwrapPrefix", () => {
  test.skipIf(process.platform !== "linux")("includes --unshare-all", () => {
    expect(buildBwrapPrefix(BASE_PROFILE)).toContain("--unshare-all");
  });

  test.skipIf(process.platform !== "linux")("adds --unshare-net when network is denied", () => {
    expect(buildBwrapPrefix(BASE_PROFILE)).toContain("--unshare-net");
  });

  test.skipIf(process.platform !== "linux")("omits --unshare-net when network is allowed", () => {
    const profile: SandboxProfile = {
      ...BASE_PROFILE,
      network: { allow: true },
    };

    expect(buildBwrapPrefix(profile)).not.toContain("--unshare-net");
  });

  test.skipIf(process.platform !== "linux")(
    "open mode: binds root read-only and places deny tmpfs after it",
    () => {
      const args = buildBwrapPrefix({
        ...BASE_PROFILE,
        filesystem: {
          defaultReadAccess: "open",
          denyRead: [DENY_PATH],
        },
      });

      const rootBindIndex = args.findIndex(
        (value, index) =>
          value === "--ro-bind" && args[index + 1] === "/" && args[index + 2] === "/",
      );
      const tmpfsIndex = args.findIndex(
        (value, index) => value === "--tmpfs" && args[index + 1] === DENY_PATH,
      );

      expect(rootBindIndex).toBeGreaterThanOrEqual(0);
      expect(tmpfsIndex).toBeGreaterThan(rootBindIndex);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "closed mode: places deny tmpfs after parent ro-bind",
    () => {
      const parentPath = `${TMPDIR}/home/user`;
      const args = buildBwrapPrefix({
        ...BASE_PROFILE,
        filesystem: {
          defaultReadAccess: "closed",
          allowRead: [parentPath],
          denyRead: [DENY_PATH],
        },
      });

      const roBindIndex = args.findIndex(
        (value, index) =>
          value === "--ro-bind" && args[index + 1] === parentPath && args[index + 2] === parentPath,
      );
      const tmpfsIndex = args.findIndex(
        (value, index) => value === "--tmpfs" && args[index + 1] === DENY_PATH,
      );

      expect(roBindIndex).toBeGreaterThanOrEqual(0);
      expect(tmpfsIndex).toBeGreaterThan(roBindIndex);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "deny overlay applied exactly once when path is child of multiple allowRead parents",
    () => {
      const parentPath = `${TMPDIR}/home/user`;
      const projectsPath = `${TMPDIR}/home/user/projects`;
      // DENY_PATH is a child of parentPath only.
      // The deny overlay should appear exactly once (not duplicated).
      const args = buildBwrapPrefix({
        ...BASE_PROFILE,
        filesystem: {
          defaultReadAccess: "closed",
          allowRead: [parentPath, projectsPath],
          denyRead: [DENY_PATH],
        },
      });

      const tmpfsCount = args.reduce((count, value, index) => {
        return value === "--tmpfs" && args[index + 1] === DENY_PATH ? count + 1 : count;
      }, 0);

      expect(tmpfsCount).toBe(1);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "non-existent denyRead paths are skipped (bwrap cannot --tmpfs non-existent mount points)",
    () => {
      const nonExistentPath = "/tmp/koi-bwrap-test-does-not-exist-9f3a2c";
      const args = buildBwrapPrefix({
        ...BASE_PROFILE,
        filesystem: {
          defaultReadAccess: "open",
          denyRead: [nonExistentPath],
        },
      });

      // No --tmpfs should be emitted for a path that doesn't exist.
      const tmpfsIndex = args.findIndex(
        (value, index) => value === "--tmpfs" && args[index + 1] === nonExistentPath,
      );
      expect(tmpfsIndex).toBe(-1);
    },
  );
});

describe("buildBwrapSuffix", () => {
  test.skipIf(process.platform !== "linux")("uses sh wrapper when maxPids is set", () => {
    const args = buildBwrapSuffix(
      {
        ...BASE_PROFILE,
        resources: { maxPids: 32 },
      },
      "node",
      ["script.js"],
    );

    expect(args.slice(0, 3)).toEqual(["/bin/bash", "-c", expect.any(String)]);
    expect(args[2]).toContain("ulimit -u 32");
  });

  test.skipIf(process.platform !== "linux")(
    "does not use sh wrapper when there are no limits",
    () => {
      expect(buildBwrapSuffix(BASE_PROFILE, "node", ["script.js"])).toEqual(["node", "script.js"]);
    },
  );
});

describe("buildSystemdRunArgs", () => {
  test("returns null when maxMemoryMb is not set", () => {
    expect(buildSystemdRunArgs(BASE_PROFILE)).toBeNull();
  });

  test("returns systemd-run prefix with MemoryMax when maxMemoryMb is set", () => {
    const args = buildSystemdRunArgs({
      ...BASE_PROFILE,
      resources: { maxMemoryMb: 256 },
    });

    expect(args).not.toBeNull();
    expect(args).toContain("systemd-run");
    expect(args).toContain("--user");
    expect(args).toContain("--scope");
    expect(args).toContain("MemoryMax=256M");
    // Must end with "--" separator before bwrap args
    expect(args?.at(-1)).toBe("--");
  });

  test("MemoryMax value matches profile maxMemoryMb", () => {
    const args = buildSystemdRunArgs({
      ...BASE_PROFILE,
      resources: { maxMemoryMb: 512 },
    });
    expect(args).toContain("MemoryMax=512M");
  });

  test("includes --unit=<name> when unitName is provided", () => {
    const args = buildSystemdRunArgs(
      { ...BASE_PROFILE, resources: { maxMemoryMb: 256 } },
      "koi-sb-test-unit",
    );
    expect(args).toContain("--unit=koi-sb-test-unit");
    // --unit must appear before --
    const unitIndex = args?.indexOf("--unit=koi-sb-test-unit") ?? -1;
    const separatorIndex = args?.lastIndexOf("--") ?? -1;
    expect(unitIndex).toBeGreaterThanOrEqual(0);
    expect(unitIndex).toBeLessThan(separatorIndex);
  });

  test("omits --unit when unitName is not provided", () => {
    const args = buildSystemdRunArgs({ ...BASE_PROFILE, resources: { maxMemoryMb: 256 } });
    const hasUnit = args?.some((a) => a.startsWith("--unit=")) ?? false;
    expect(hasUnit).toBe(false);
  });
});
