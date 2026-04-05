import { describe, expect, test } from "bun:test";

import type { SandboxProfile } from "@koi/core";

import { buildBwrapPrefix, buildBwrapSuffix } from "./bwrap.js";

const BASE_PROFILE: SandboxProfile = {
  filesystem: {
    defaultReadAccess: "open",
  },
  network: {
    allow: false,
  },
  resources: {},
};

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
          denyRead: ["/home/user/.ssh"],
        },
      });

      const rootBindIndex = args.findIndex(
        (value, index) =>
          value === "--ro-bind" && args[index + 1] === "/" && args[index + 2] === "/",
      );
      const tmpfsIndex = args.findIndex(
        (value, index) => value === "--tmpfs" && args[index + 1] === "/home/user/.ssh",
      );

      expect(rootBindIndex).toBeGreaterThanOrEqual(0);
      expect(tmpfsIndex).toBeGreaterThan(rootBindIndex);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "closed mode: places deny tmpfs after parent ro-bind",
    () => {
      const args = buildBwrapPrefix({
        ...BASE_PROFILE,
        filesystem: {
          defaultReadAccess: "closed",
          allowRead: ["/home/user"],
          denyRead: ["/home/user/.ssh"],
        },
      });

      const roBindIndex = args.findIndex(
        (value, index) =>
          value === "--ro-bind" &&
          args[index + 1] === "/home/user" &&
          args[index + 2] === "/home/user",
      );
      const tmpfsIndex = args.findIndex(
        (value, index) => value === "--tmpfs" && args[index + 1] === "/home/user/.ssh",
      );

      expect(roBindIndex).toBeGreaterThanOrEqual(0);
      expect(tmpfsIndex).toBeGreaterThan(roBindIndex);
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

    expect(args.slice(0, 3)).toEqual(["sh", "-c", expect.any(String)]);
    expect(args[2]).toContain("ulimit -u 32");
  });

  test.skipIf(process.platform !== "linux")(
    "does not use sh wrapper when there are no limits",
    () => {
      expect(buildBwrapSuffix(BASE_PROFILE, "node", ["script.js"])).toEqual(["node", "script.js"]);
    },
  );
});
