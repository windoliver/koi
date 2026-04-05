import { describe, expect, test } from "bun:test";

import type { SandboxProfile } from "@koi/core";

import { validateProfile } from "./validate.js";

const BASE_PROFILE: SandboxProfile = {
  filesystem: {
    defaultReadAccess: "open",
  },
  network: {
    allow: true,
  },
  resources: {},
};

function withFilesystem(filesystem: SandboxProfile["filesystem"]): SandboxProfile {
  return {
    ...BASE_PROFILE,
    filesystem,
  };
}

describe("validateProfile", () => {
  test("rejects relative allowRead paths", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        allowRead: ["relative/path"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects explicit relative denyRead paths", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        denyRead: ["./explicit-relative"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("accepts absolute paths", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        allowRead: ["/absolute/path"],
      }),
      "bwrap",
    );

    expect(result).toEqual({
      ok: true,
      value: withFilesystem({
        defaultReadAccess: "open",
        allowRead: ["/absolute/path"],
      }),
    });
  });

  test("accepts tilde-prefixed paths", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        allowRead: ["~/home/path"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });

  test("rejects closed defaultReadAccess on seatbelt", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "closed",
      }),
      "seatbelt",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("dyld");
    }
  });

  test("accepts closed defaultReadAccess on bwrap", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "closed",
      }),
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });

  test("accepts open defaultReadAccess on seatbelt", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
      }),
      "seatbelt",
    );

    expect(result.ok).toBe(true);
  });

  test("accepts open defaultReadAccess on bwrap", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
      }),
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });
});
