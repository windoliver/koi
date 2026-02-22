import { describe, expect, test } from "bun:test";
import { permissiveProfile, profileForTier, restrictiveProfile } from "./profiles.js";

describe("restrictiveProfile", () => {
  test("has network disallowed", () => {
    const profile = restrictiveProfile();
    expect(profile.network.allow).toBe(false);
  });

  test("denies sensitive paths", () => {
    const profile = restrictiveProfile();
    const denied = profile.filesystem.denyRead;
    expect(denied).toBeDefined();
    expect(denied).toContain("~/.ssh");
    expect(denied).toContain("~/.gnupg");
    expect(denied).toContain("~/.aws");
  });

  test("denies .env patterns", () => {
    const profile = restrictiveProfile();
    const denied = profile.filesystem.denyRead;
    expect(denied).toContain(".env");
    expect(denied).toContain(".env.*");
  });

  test("allows write only to /tmp/koi-sandbox-*", () => {
    const profile = restrictiveProfile();
    expect(profile.filesystem.allowWrite).toEqual(["/tmp/koi-sandbox-*"]);
  });

  test("has tier sandbox", () => {
    const profile = restrictiveProfile();
    expect(profile.tier).toBe("sandbox");
  });

  test("has resource limits set", () => {
    const profile = restrictiveProfile();
    expect(profile.resources.maxMemoryMb).toBe(512);
    expect(profile.resources.timeoutMs).toBe(30_000);
    expect(profile.resources.maxPids).toBe(64);
    expect(profile.resources.maxOpenFiles).toBe(256);
  });
});

describe("permissiveProfile", () => {
  test("has network allowed", () => {
    const profile = permissiveProfile();
    expect(profile.network.allow).toBe(true);
  });

  test("allows broader filesystem access", () => {
    const profile = permissiveProfile();
    expect(profile.filesystem.allowRead).toContain(".");
    expect(profile.filesystem.allowWrite).toContain(".");
  });

  test("still denies sensitive paths", () => {
    const profile = permissiveProfile();
    expect(profile.filesystem.denyRead).toContain("~/.ssh");
  });

  test("has tier verified", () => {
    const profile = permissiveProfile();
    expect(profile.tier).toBe("verified");
  });
});

describe("profileForTier", () => {
  test("sandbox tier returns restrictive profile", () => {
    const profile = profileForTier("sandbox");
    expect(profile.tier).toBe("sandbox");
    expect(profile.network.allow).toBe(false);
  });

  test("verified tier returns permissive profile", () => {
    const profile = profileForTier("verified");
    expect(profile.tier).toBe("verified");
    expect(profile.network.allow).toBe(true);
  });

  test("promoted tier returns pass-through profile", () => {
    const profile = profileForTier("promoted");
    expect(profile.tier).toBe("promoted");
    expect(profile.network.allow).toBe(true);
    expect(profile.filesystem).toEqual({});
    expect(profile.resources).toEqual({});
  });
});

describe("profile overrides", () => {
  test("overrides merge correctly", () => {
    const profile = restrictiveProfile({
      network: { allow: true },
    });
    expect(profile.network.allow).toBe(true);
    // Other fields should remain from base
    expect(profile.tier).toBe("sandbox");
    expect(profile.filesystem.denyRead).toContain("~/.ssh");
  });

  test("overrides do not mutate original", () => {
    const original = restrictiveProfile();
    const modified = restrictiveProfile({ network: { allow: true } });
    expect(original.network.allow).toBe(false);
    expect(modified.network.allow).toBe(true);
  });

  test("env override is included", () => {
    const profile = restrictiveProfile({
      env: { NODE_ENV: "test" },
    });
    expect(profile.env).toEqual({ NODE_ENV: "test" });
  });
});
