import { describe, expect, test } from "bun:test";

import type { SandboxProfile } from "@koi/core";

import { generateSeatbeltProfile } from "./seatbelt.js";

const BASE_PROFILE: SandboxProfile = {
  filesystem: {
    defaultReadAccess: "open",
  },
  network: {
    allow: true,
  },
  resources: {},
};

describe("generateSeatbeltProfile", () => {
  test.skipIf(process.platform !== "darwin")("starts with version and deny default", () => {
    const profile = generateSeatbeltProfile(BASE_PROFILE);

    expect(profile.startsWith("(version 1)\n(deny default)\n")).toBe(true);
  });

  test.skipIf(process.platform !== "darwin")("allows network when enabled", () => {
    expect(generateSeatbeltProfile(BASE_PROFILE)).toContain("(allow network*)");
  });

  test.skipIf(process.platform !== "darwin")("denies network when disabled", () => {
    expect(generateSeatbeltProfile({ ...BASE_PROFILE, network: { allow: false } })).toContain(
      "(deny network*)",
    );
  });

  test.skipIf(process.platform !== "darwin")("renders denyRead rules", () => {
    expect(
      generateSeatbeltProfile({
        ...BASE_PROFILE,
        filesystem: {
          defaultReadAccess: "open",
          denyRead: ["/foo"],
        },
      }),
    ).toContain("(deny file-read*");
  });

  test.skipIf(process.platform !== "darwin")("renders allowWrite rules", () => {
    expect(
      generateSeatbeltProfile({
        ...BASE_PROFILE,
        filesystem: {
          defaultReadAccess: "open",
          allowWrite: ["/bar"],
        },
      }),
    ).toContain('(allow file-write* (subpath "/bar"))');
  });
});
