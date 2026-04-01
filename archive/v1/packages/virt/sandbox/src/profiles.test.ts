import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import {
  createProfileFromPolicy,
  permissiveProfile,
  profileForTier,
  restrictiveProfile,
} from "./profiles.js";

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

  test("has higher resource limits than restrictive", () => {
    const permissive = permissiveProfile();
    const restrictive = restrictiveProfile();

    expect(permissive.resources.maxMemoryMb).toBe(2048);
    expect(restrictive.resources.maxMemoryMb).toBe(512);

    expect(permissive.resources.timeoutMs).toBe(120_000);
    expect(permissive.resources.maxPids).toBe(256);
    expect(permissive.resources.maxOpenFiles).toBe(1024);
  });

  test("denies cloud config paths", () => {
    const profile = permissiveProfile();
    const denied = profile.filesystem.denyRead;
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

describe("createProfileFromPolicy", () => {
  test("sandboxed policy returns restrictive profile", () => {
    const profile = createProfileFromPolicy(DEFAULT_SANDBOXED_POLICY);
    expect(profile.network.allow).toBe(false);
  });

  test("unsandboxed policy returns pass-through profile", () => {
    const profile = createProfileFromPolicy(DEFAULT_UNSANDBOXED_POLICY);
    expect(profile.network.allow).toBe(true);
    expect(profile.filesystem).toEqual({});
    expect(profile.resources).toEqual({});
  });

  test("custom sandboxed policy returns restrictive profile", () => {
    const profile = createProfileFromPolicy({
      sandbox: true,
      capabilities: { network: { allow: true } },
    });
    expect(profile.network.allow).toBe(false); // Profile is restrictive regardless of capabilities
  });

  test("custom unsandboxed policy returns pass-through", () => {
    const profile = createProfileFromPolicy({ sandbox: false, capabilities: {} });
    expect(profile.network.allow).toBe(true);
  });

  test("profileForTier is alias for createProfileFromPolicy", () => {
    expect(profileForTier).toBe(createProfileFromPolicy);
  });
});

describe("profile overrides", () => {
  test("overrides merge correctly", () => {
    const profile = restrictiveProfile({
      network: { allow: true },
    });
    expect(profile.network.allow).toBe(true);
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

  test("resources override replaces entire resources block", () => {
    const profile = restrictiveProfile({
      resources: { maxMemoryMb: 1024 },
    });
    expect(profile.resources.maxMemoryMb).toBe(1024);
    expect(profile.resources.timeoutMs).toBeUndefined();
  });

  test("filesystem override replaces entire filesystem block", () => {
    const profile = restrictiveProfile({
      filesystem: { allowRead: ["/custom"] },
    });
    expect(profile.filesystem.allowRead).toEqual(["/custom"]);
    expect(profile.filesystem.denyRead).toBeUndefined();
  });

  test("permissive profile also accepts overrides", () => {
    const profile = permissiveProfile({
      network: { allow: false },
    });
    expect(profile.network.allow).toBe(false);
  });

  test("calling without overrides returns a copy, not the original", () => {
    const a = restrictiveProfile();
    const b = restrictiveProfile();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
