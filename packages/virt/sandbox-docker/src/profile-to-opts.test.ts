import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@koi/core";
import { profileToDockerOpts } from "./profile-to-opts.js";

function createProfile(overrides?: Partial<SandboxProfile>): SandboxProfile {
  return {
    filesystem: {},
    network: { allow: false },
    resources: {},
    ...overrides,
  };
}

describe("profileToDockerOpts", () => {
  test("uses provided image", () => {
    const { opts } = profileToDockerOpts(createProfile(), "node:20");
    expect(opts.image).toBe("node:20");
  });

  test("sets network=none when allow is false", () => {
    const { opts } = profileToDockerOpts(
      createProfile({ network: { allow: false } }),
      "ubuntu:22.04",
    );
    expect(opts.networkMode).toBe("none");
  });

  test("sets network=bridge when allow is true", () => {
    const { opts } = profileToDockerOpts(
      createProfile({ network: { allow: true } }),
      "ubuntu:22.04",
    );
    expect(opts.networkMode).toBe("bridge");
  });

  test("converts maxMemoryMb to bytes", () => {
    const { opts } = profileToDockerOpts(
      createProfile({ resources: { maxMemoryMb: 256 } }),
      "ubuntu:22.04",
    );
    expect(opts.memory).toBe(256 * 1024 * 1024);
  });

  test("passes maxPids through", () => {
    const { opts } = profileToDockerOpts(
      createProfile({ resources: { maxPids: 100 } }),
      "ubuntu:22.04",
    );
    expect(opts.pidsLimit).toBe(100);
  });

  test("passes env through", () => {
    const { opts } = profileToDockerOpts(
      createProfile({ env: { FOO: "bar", BAZ: "qux" } }),
      "ubuntu:22.04",
    );
    expect(opts.env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("creates read-only bind mounts from allowRead", () => {
    const { opts } = profileToDockerOpts(
      createProfile({
        filesystem: { allowRead: ["/data", "/config"] },
      }),
      "ubuntu:22.04",
    );
    expect(opts.binds).toContain("/data:/data:ro");
    expect(opts.binds).toContain("/config:/config:ro");
  });

  test("creates read-write bind mounts from allowWrite", () => {
    const { opts } = profileToDockerOpts(
      createProfile({
        filesystem: { allowWrite: ["/output"] },
      }),
      "ubuntu:22.04",
    );
    expect(opts.binds).toContain("/output:/output:rw");
  });

  test("deduplicates write paths from read paths", () => {
    const { opts } = profileToDockerOpts(
      createProfile({
        filesystem: {
          allowRead: ["/shared", "/readonly"],
          allowWrite: ["/shared"],
        },
      }),
      "ubuntu:22.04",
    );
    // /shared should appear only as rw, not as ro
    const sharedMounts = opts.binds?.filter((b) => b.startsWith("/shared:")) ?? [];
    expect(sharedMounts).toEqual(["/shared:/shared:rw"]);
    expect(opts.binds).toContain("/readonly:/readonly:ro");
  });

  test("strips glob patterns from paths", () => {
    const { opts } = profileToDockerOpts(
      createProfile({
        filesystem: { allowWrite: ["/tmp/*"] },
      }),
      "ubuntu:22.04",
    );
    expect(opts.binds).toContain("/tmp/:/tmp/:rw");
  });

  test("adds CAP_NET_ADMIN when allowedHosts specified", () => {
    const { opts } = profileToDockerOpts(
      createProfile({
        network: { allow: true, allowedHosts: ["api.example.com"] },
      }),
      "ubuntu:22.04",
    );
    expect(opts.capAdd).toContain("NET_ADMIN");
  });

  test("returns network config with iptables script", () => {
    const { networkConfig } = profileToDockerOpts(
      createProfile({
        network: { allow: true, allowedHosts: ["api.example.com"] },
      }),
      "ubuntu:22.04",
    );
    expect(networkConfig.iptablesSetupScript).toBeDefined();
    expect(networkConfig.iptablesSetupScript).toContain("iptables");
  });

  test("omits optional fields when not provided", () => {
    const { opts } = profileToDockerOpts(createProfile(), "ubuntu:22.04");
    expect(opts.memory).toBeUndefined();
    expect(opts.pidsLimit).toBeUndefined();
    expect(opts.env).toBeUndefined();
    expect(opts.binds).toBeUndefined();
    expect(opts.capAdd).toBeUndefined();
  });
});
