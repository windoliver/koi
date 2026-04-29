import { describe, expect, test } from "bun:test";
import { mapProfileToDockerOpts } from "./profile-to-opts.js";

describe("mapProfileToDockerOpts", () => {
  test("denies network and applies pids/memory limits", () => {
    const { opts } = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: { maxPids: 64, maxMemoryMb: 256 },
      },
      "ubuntu:22.04",
    );
    expect(opts.networkMode).toBe("none");
    expect(opts.pidsLimit).toBe(64);
    expect(opts.memoryMb).toBe(256);
    expect(opts.image).toBe("ubuntu:22.04");
  });

  test("allows bridge network when profile permits", () => {
    const { opts } = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: true },
        resources: {},
      },
      "alpine:3.19",
    );
    expect(opts.networkMode).toBe("bridge");
  });

  // Fix 4: filesystem allowRead/allowWrite → bind mounts
  test("maps allowWrite paths to rw bind mounts", () => {
    const { opts } = mapProfileToDockerOpts(
      {
        filesystem: {
          defaultReadAccess: "closed",
          allowRead: ["/usr/local/share"],
          allowWrite: ["/tmp/sandbox-out"],
        },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(opts.binds).toContain("/usr/local/share:/usr/local/share:ro");
    expect(opts.binds).toContain("/tmp/sandbox-out:/tmp/sandbox-out:rw");
  });

  // Fix 4: nexusMounts → bind mounts
  test("maps nexusMounts to rw bind mounts", () => {
    const { opts } = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "closed" },
        network: { allow: false },
        resources: {},
        nexusMounts: [
          {
            nexusUrl: "http://nexus.internal",
            apiKey: "secret",
            mountPath: "/mnt/nexus",
          },
        ],
      },
      "ubuntu:22.04",
    );
    expect(opts.binds).toContain("/mnt/nexus:/mnt/nexus:rw");
  });

  test("produces no binds when filesystem has no allow lists and no nexusMounts", () => {
    const { opts } = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(opts.binds === undefined || opts.binds.length === 0).toBe(true);
  });
});
