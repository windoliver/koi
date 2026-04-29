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
});
