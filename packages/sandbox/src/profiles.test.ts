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

  test("denies cloud provider config paths", () => {
    const profile = restrictiveProfile();
    const denied = profile.filesystem.denyRead;
    expect(denied).toContain("~/.config/gcloud");
    expect(denied).toContain("~/.azure");
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

  test("allows read access to system directories", () => {
    const profile = restrictiveProfile();
    const allowed = profile.filesystem.allowRead;
    expect(allowed).toBeDefined();
    expect(allowed).toContain("/usr");
    expect(allowed).toContain("/bin");
    expect(allowed).toContain("/lib");
    expect(allowed).toContain("/etc");
    expect(allowed).toContain("/tmp");
  });

  test("does not have env by default", () => {
    const profile = restrictiveProfile();
    expect(profile.env).toBeUndefined();
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

  test("has higher resource limits than restrictive", () => {
    const permissive = permissiveProfile();
    const restrictive = restrictiveProfile();

    // Permissive profile should have higher limits
    expect(permissive.resources.maxMemoryMb).toBe(2048);
    expect(restrictive.resources.maxMemoryMb).toBe(512);
    expect(permissive.resources.maxMemoryMb!).toBeGreaterThan(restrictive.resources.maxMemoryMb!);

    expect(permissive.resources.timeoutMs).toBe(120_000);
    expect(permissive.resources.timeoutMs!).toBeGreaterThan(restrictive.resources.timeoutMs!);

    expect(permissive.resources.maxPids).toBe(256);
    expect(permissive.resources.maxPids!).toBeGreaterThan(restrictive.resources.maxPids!);

    expect(permissive.resources.maxOpenFiles).toBe(1024);
    expect(permissive.resources.maxOpenFiles!).toBeGreaterThan(restrictive.resources.maxOpenFiles!);
  });

  test("denies cloud config but not .env patterns", () => {
    const profile = permissiveProfile();
    const denied = profile.filesystem.denyRead;
    // Permissive uses SENSITIVE_PATHS but not SENSITIVE_PATTERNS
    expect(denied).toContain("~/.ssh");
    expect(denied).toContain("~/.gnupg");
    expect(denied).toContain("~/.aws");
    expect(denied).toContain("~/.config/gcloud");
    expect(denied).toContain("~/.azure");
  });

  test("does not have env by default", () => {
    const profile = permissiveProfile();
    expect(profile.env).toBeUndefined();
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

  test("each tier has the correct tier field", () => {
    const tiers = ["sandbox", "verified", "promoted"] as const;
    for (const tier of tiers) {
      const profile = profileForTier(tier);
      expect(profile.tier).toBe(tier);
    }
  });

  test("promoted tier has no resource limits", () => {
    const profile = profileForTier("promoted");
    expect(profile.resources.maxMemoryMb).toBeUndefined();
    expect(profile.resources.timeoutMs).toBeUndefined();
    expect(profile.resources.maxPids).toBeUndefined();
    expect(profile.resources.maxOpenFiles).toBeUndefined();
  });

  test("promoted tier has no filesystem restrictions", () => {
    const profile = profileForTier("promoted");
    expect(profile.filesystem.allowRead).toBeUndefined();
    expect(profile.filesystem.denyRead).toBeUndefined();
    expect(profile.filesystem.allowWrite).toBeUndefined();
    expect(profile.filesystem.denyWrite).toBeUndefined();
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

  test("tier override replaces tier", () => {
    const profile = restrictiveProfile({ tier: "verified" });
    expect(profile.tier).toBe("verified");
    // Filesystem stays restrictive
    expect(profile.filesystem.allowWrite).toEqual(["/tmp/koi-sandbox-*"]);
  });

  test("resources override replaces entire resources block", () => {
    const profile = restrictiveProfile({
      resources: { maxMemoryMb: 1024 },
    });
    // Override replaces the entire resources block
    expect(profile.resources.maxMemoryMb).toBe(1024);
    // Other resource fields are undefined because override replaces, not deep merges
    expect(profile.resources.timeoutMs).toBeUndefined();
  });

  test("filesystem override replaces entire filesystem block", () => {
    const profile = restrictiveProfile({
      filesystem: { allowRead: ["/custom"] },
    });
    expect(profile.filesystem.allowRead).toEqual(["/custom"]);
    // denyRead is undefined because override replaces
    expect(profile.filesystem.denyRead).toBeUndefined();
  });

  test("permissive profile also accepts overrides", () => {
    const profile = permissiveProfile({
      network: { allow: false },
    });
    expect(profile.network.allow).toBe(false);
    expect(profile.tier).toBe("verified");
  });

  test("multiple overrides applied together", () => {
    const profile = restrictiveProfile({
      tier: "verified",
      network: { allow: true },
      env: { HOME: "/tmp" },
    });
    expect(profile.tier).toBe("verified");
    expect(profile.network.allow).toBe(true);
    expect(profile.env).toEqual({ HOME: "/tmp" });
    // filesystem and resources come from base
    expect(profile.filesystem.denyRead).toContain("~/.ssh");
    expect(profile.resources.maxMemoryMb).toBe(512);
  });

  test("calling without overrides returns a copy, not the original", () => {
    const a = restrictiveProfile();
    const b = restrictiveProfile();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
