import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "../types.js";
import { buildBwrapArgs } from "./bwrap.js";

const MINIMAL_PROFILE: SandboxProfile = {
  tier: "sandbox",
  filesystem: {},
  network: { allow: false },
  resources: {},
};

function argsContainSequence(args: readonly string[], ...sequence: readonly string[]): boolean {
  const str = args.join(" ");
  return str.includes(sequence.join(" "));
}

describe("buildBwrapArgs", () => {
  test("starts with bwrap", () => {
    const args = buildBwrapArgs(MINIMAL_PROFILE, "/bin/echo", ["hello"]);
    expect(args[0]).toBe("bwrap");
  });

  test("includes --unshare-all", () => {
    const args = buildBwrapArgs(MINIMAL_PROFILE, "/bin/echo", []);
    expect(args).toContain("--unshare-all");
  });

  test("includes --new-session", () => {
    const args = buildBwrapArgs(MINIMAL_PROFILE, "/bin/echo", []);
    expect(args).toContain("--new-session");
  });

  test("includes --die-with-parent", () => {
    const args = buildBwrapArgs(MINIMAL_PROFILE, "/bin/echo", []);
    expect(args).toContain("--die-with-parent");
  });

  test("includes --unshare-net when network disallowed", () => {
    const args = buildBwrapArgs(MINIMAL_PROFILE, "/bin/echo", []);
    expect(args).toContain("--unshare-net");
  });

  test("does NOT include --unshare-net when network allowed", () => {
    const profile: SandboxProfile = {
      ...MINIMAL_PROFILE,
      network: { allow: true },
    };
    const args = buildBwrapArgs(profile, "/bin/echo", []);
    expect(args).not.toContain("--unshare-net");
  });

  test("includes standard system mounts", () => {
    const args = buildBwrapArgs(MINIMAL_PROFILE, "/bin/echo", []);
    expect(argsContainSequence(args, "--ro-bind", "/usr", "/usr")).toBe(true);
    expect(argsContainSequence(args, "--ro-bind", "/etc", "/etc")).toBe(true);
  });

  test("includes symlinks for standard paths", () => {
    const args = buildBwrapArgs(MINIMAL_PROFILE, "/bin/echo", []);
    expect(argsContainSequence(args, "--symlink", "/usr/lib", "/lib")).toBe(true);
    expect(argsContainSequence(args, "--symlink", "/usr/bin", "/bin")).toBe(true);
  });

  test("includes virtual filesystem mounts", () => {
    const args = buildBwrapArgs(MINIMAL_PROFILE, "/bin/echo", []);
    expect(argsContainSequence(args, "--proc", "/proc")).toBe(true);
    expect(argsContainSequence(args, "--dev", "/dev")).toBe(true);
    expect(argsContainSequence(args, "--tmpfs", "/tmp")).toBe(true);
  });

  test("includes --clearenv", () => {
    const args = buildBwrapArgs(MINIMAL_PROFILE, "/bin/echo", []);
    expect(args).toContain("--clearenv");
  });

  test("includes --setenv for PATH", () => {
    const args = buildBwrapArgs(MINIMAL_PROFILE, "/bin/echo", []);
    expect(argsContainSequence(args, "--setenv", "PATH")).toBe(true);
  });

  test("includes --setenv for profile env vars", () => {
    const profile: SandboxProfile = {
      ...MINIMAL_PROFILE,
      env: { NODE_ENV: "test", FOO: "bar" },
    };
    const args = buildBwrapArgs(profile, "/bin/echo", []);
    expect(argsContainSequence(args, "--setenv", "NODE_ENV", "test")).toBe(true);
    expect(argsContainSequence(args, "--setenv", "FOO", "bar")).toBe(true);
  });

  test("includes --bind for allowed write paths", () => {
    const profile: SandboxProfile = {
      ...MINIMAL_PROFILE,
      filesystem: { allowWrite: ["/home/user/project"] },
    };
    const args = buildBwrapArgs(profile, "/bin/echo", []);
    expect(argsContainSequence(args, "--bind", "/home/user/project", "/home/user/project")).toBe(
      true,
    );
  });

  test("includes --ro-bind for non-system read paths", () => {
    const profile: SandboxProfile = {
      ...MINIMAL_PROFILE,
      filesystem: { allowRead: ["/home/user/data"] },
    };
    const args = buildBwrapArgs(profile, "/bin/echo", []);
    expect(argsContainSequence(args, "--ro-bind", "/home/user/data", "/home/user/data")).toBe(true);
  });

  test("skips system paths from allowRead", () => {
    const profile: SandboxProfile = {
      ...MINIMAL_PROFILE,
      filesystem: { allowRead: ["/usr", "/etc", "/home/user"] },
    };
    const args = buildBwrapArgs(profile, "/bin/echo", []);
    // /usr and /etc are already mounted as system paths
    // /home/user should get an extra ro-bind
    expect(argsContainSequence(args, "--ro-bind", "/home/user", "/home/user")).toBe(true);
  });

  test("command and args are appended at the end", () => {
    const profile: SandboxProfile = {
      ...MINIMAL_PROFILE,
      resources: {}, // no maxOpenFiles to avoid ulimit wrapper
    };
    const args = buildBwrapArgs(profile, "/bin/echo", ["hello", "world"]);
    const lastThree = args.slice(-3);
    expect(lastThree).toEqual(["/bin/echo", "hello", "world"]);
  });

  test("uses ulimit wrapper when maxOpenFiles set", () => {
    const profile: SandboxProfile = {
      ...MINIMAL_PROFILE,
      resources: { maxOpenFiles: 256 },
    };
    const args = buildBwrapArgs(profile, "/bin/echo", ["hello"]);
    // Should end with -- sh -c "ulimit ... && exec ..."
    expect(args).toContain("--");
    expect(args).toContain("sh");
    expect(args).toContain("-c");
    const lastArg = args[args.length - 1];
    expect(lastArg).toContain("ulimit -n 256");
    expect(lastArg).toContain("exec");
  });
});
