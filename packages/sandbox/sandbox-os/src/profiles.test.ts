import { describe, expect, test } from "bun:test";

import { mergeProfile, restrictiveProfile, SENSITIVE_CREDENTIAL_PATHS } from "./profiles.js";

describe("SENSITIVE_CREDENTIAL_PATHS", () => {
  test("is a non-empty readonly array", () => {
    expect(Array.isArray(SENSITIVE_CREDENTIAL_PATHS)).toBe(true);
    expect(SENSITIVE_CREDENTIAL_PATHS.length).toBeGreaterThan(0);
  });
});

describe("restrictiveProfile", () => {
  test("denyRead includes all sensitive credential paths", () => {
    const profile = restrictiveProfile();
    const denyRead = profile.filesystem.denyRead ?? [];

    for (const path of SENSITIVE_CREDENTIAL_PATHS) {
      expect(denyRead.some((entry) => entry.endsWith(path.slice(1)))).toBe(true);
    }
  });

  test("appends extraDenyRead without replacing defaults", () => {
    const profile = restrictiveProfile({ extraDenyRead: ["/extra"] });
    const denyRead = profile.filesystem.denyRead ?? [];

    expect(denyRead).toContain("/extra");
    for (const path of SENSITIVE_CREDENTIAL_PATHS) {
      expect(denyRead.some((entry) => entry.endsWith(path.slice(1)))).toBe(true);
    }
  });
});

describe("mergeProfile", () => {
  test("deep-merges nested objects", () => {
    const base = restrictiveProfile();
    const merged = mergeProfile(base, {
      filesystem: {
        allowWrite: ["/var/tmp"],
      },
    });

    expect(merged.filesystem.defaultReadAccess).toBe(base.filesystem.defaultReadAccess);
    expect(merged.filesystem.denyRead).toEqual(base.filesystem.denyRead);
    expect(merged.filesystem.allowWrite).toEqual(["/var/tmp"]);
    expect(merged.network).toEqual(base.network);
  });

  test("returns a copy when there are no overrides", () => {
    const base = restrictiveProfile();
    const merged = mergeProfile(base, {});

    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
    expect(merged.filesystem).not.toBe(base.filesystem);
  });
});
