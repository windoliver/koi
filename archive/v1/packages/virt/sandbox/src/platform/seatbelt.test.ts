import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "../types.js";
import { buildSeatbeltArgs, generateSeatbeltProfile } from "./seatbelt.js";

const MINIMAL_PROFILE: SandboxProfile = {
  filesystem: {},
  network: { allow: false },
  resources: {},
};

describe("generateSeatbeltProfile", () => {
  test("starts with (version 1) and (deny default)", () => {
    const profile = generateSeatbeltProfile(MINIMAL_PROFILE, "/bin/echo");
    expect(profile.startsWith("(version 1)\n(deny default)")).toBe(true);
  });

  test("contains (deny network*) when network disallowed", () => {
    const profile = generateSeatbeltProfile(MINIMAL_PROFILE, "/bin/echo");
    expect(profile).toContain("(deny network*)");
  });

  test("contains (allow network*) when network allowed", () => {
    const profile = generateSeatbeltProfile(
      { ...MINIMAL_PROFILE, network: { allow: true } },
      "/bin/echo",
    );
    expect(profile).toContain("(allow network*)");
    expect(profile).not.toContain("(deny network*)");
  });

  test("includes broad file-read permissions for dyld compatibility", () => {
    const profile = generateSeatbeltProfile(MINIMAL_PROFILE, "/bin/echo");
    expect(profile).toContain("(allow file-read-data)");
    expect(profile).toContain("(allow file-read-metadata)");
  });

  test("denies file-write by default", () => {
    const profile = generateSeatbeltProfile(MINIMAL_PROFILE, "/bin/echo");
    expect(profile).toContain("(deny file-write*)");
  });

  test("allows writing to /dev/null", () => {
    const profile = generateSeatbeltProfile(MINIMAL_PROFILE, "/bin/echo");
    expect(profile).toContain('(allow file-write* (literal "/dev/null"))');
  });

  test("contains deny rules for denied read paths with tilde resolution", () => {
    const home = process.env.HOME;
    if (home === undefined) return;
    const profile = generateSeatbeltProfile(
      { ...MINIMAL_PROFILE, filesystem: { denyRead: ["~/.ssh", "~/.aws"] } },
      "/bin/echo",
    );
    expect(profile).toContain(`(deny file-read* (subpath "${home}/.ssh"))`);
    expect(profile).toContain(`(deny file-read* (subpath "${home}/.aws"))`);
  });

  test("contains (allow file-write*) for allowed write paths", () => {
    const profile = generateSeatbeltProfile(
      { ...MINIMAL_PROFILE, filesystem: { allowWrite: ["/tmp/koi-sandbox-*"] } },
      "/bin/echo",
    );
    expect(profile).toContain('(allow file-write* (subpath "/tmp/koi-sandbox-"))');
  });

  test("resolves relative paths in deny rules against cwd", () => {
    const cwd = process.cwd();
    const profile = generateSeatbeltProfile(
      { ...MINIMAL_PROFILE, filesystem: { denyRead: [".env", ".env.local"] } },
      "/bin/echo",
    );
    // Relative paths should be resolved to absolute paths using cwd
    expect(profile).toContain(`(deny file-read* (subpath "${cwd}/.env"))`);
    expect(profile).toContain(`(deny file-read* (subpath "${cwd}/.env.local"))`);
  });

  test("includes process-exec permission", () => {
    const profile = generateSeatbeltProfile(MINIMAL_PROFILE, "/bin/echo");
    expect(profile).toContain("(allow process*)");
  });

  test("empty overrides produce valid profile", () => {
    const profile = generateSeatbeltProfile(MINIMAL_PROFILE, "/bin/echo");
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(deny default)");
    expect(profile.split("\n").length).toBeGreaterThan(5);
  });
});

describe("buildSeatbeltArgs", () => {
  test("returns sandbox-exec as first arg", () => {
    const args = buildSeatbeltArgs(MINIMAL_PROFILE, "/bin/echo", ["hello"]);
    expect(args[0]).toBe("sandbox-exec");
  });

  test("includes -p flag with profile string", () => {
    const args = buildSeatbeltArgs(MINIMAL_PROFILE, "/bin/echo", ["hello"]);
    expect(args[1]).toBe("-p");
    expect(typeof args[2]).toBe("string");
    expect((args[2] as string).startsWith("(version 1)")).toBe(true);
  });

  test("appends command and args after profile", () => {
    const args = buildSeatbeltArgs(MINIMAL_PROFILE, "/bin/echo", ["hello", "world"]);
    expect(args[3]).toBe("/bin/echo");
    expect(args[4]).toBe("hello");
    expect(args[5]).toBe("world");
  });
});
