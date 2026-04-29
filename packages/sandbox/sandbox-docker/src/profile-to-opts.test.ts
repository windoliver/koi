import { describe, expect, test } from "bun:test";
import { mapProfileToDockerOpts } from "./profile-to-opts.js";

describe("mapProfileToDockerOpts", () => {
  test("denies network and applies pids/memory limits", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: { maxPids: 64, maxMemoryMb: 256 },
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.opts.networkMode).toBe("none");
    expect(r.value.opts.pidsLimit).toBe(64);
    expect(r.value.opts.memoryMb).toBe(256);
    expect(r.value.opts.image).toBe("ubuntu:22.04");
  });

  test("allows bridge network when profile permits", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: true },
        resources: {},
      },
      "alpine:3.19",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.opts.networkMode).toBe("bridge");
  });

  // Fix 4: filesystem allowRead/allowWrite → bind mounts
  test("maps allowWrite paths to rw bind mounts", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: {
          defaultReadAccess: "open",
          allowRead: ["/usr/local/share"],
          allowWrite: ["/tmp/sandbox-out"],
        },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.opts.binds).toContain("/usr/local/share:/usr/local/share:ro");
    expect(r.value.opts.binds).toContain("/tmp/sandbox-out:/tmp/sandbox-out:rw");
  });

  // Fix 4: nexusMounts → bind mounts
  test("maps nexusMounts to rw bind mounts", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
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
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.opts.binds).toContain("/mnt/nexus:/mnt/nexus:rw");
  });

  test("produces no binds when filesystem has no allow lists and no nexusMounts", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.opts.binds === undefined || r.value.opts.binds.length === 0).toBe(true);
  });

  // Fix 2: denyRead → VALIDATION (fail-closed, not silently dropped)
  test("returns ok:false VALIDATION when profile has denyRead", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open", denyRead: ["/etc"] },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("VALIDATION");
  });

  // Fix 2: denyWrite → VALIDATION (fail-closed, not silently dropped)
  test("returns ok:false VALIDATION when profile has denyWrite", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open", denyWrite: ["/home"] },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("VALIDATION");
  });

  // Fix 2: defaultReadAccess:"deny" → VALIDATION (Docker cannot enforce deny-by-default)
  test("returns ok:false VALIDATION when defaultReadAccess is not open", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "closed" },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("VALIDATION");
  });

  // Fix 2 (read-only rootfs): profile with allowWrite → opts has readOnlyRoot + tmpfsMounts
  test("profile with allowWrite sets readOnlyRoot:true and tmpfsMounts:[/tmp] on opts", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: {
          defaultReadAccess: "open",
          allowWrite: ["/work"],
        },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.opts.readOnlyRoot).toBe(true);
    expect(r.value.opts.tmpfsMounts).toEqual(["/tmp"]);
  });

  // Fix 2 (read-only rootfs): profile with allowRead only → opts has readOnlyRoot + tmpfsMounts
  test("profile with allowRead only sets readOnlyRoot:true and tmpfsMounts:[/tmp] on opts", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: {
          defaultReadAccess: "open",
          allowRead: ["/usr/local/share"],
        },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.opts.readOnlyRoot).toBe(true);
    expect(r.value.opts.tmpfsMounts).toEqual(["/tmp"]);
  });

  // Fix 2 (read-only rootfs): profile with no allow lists → readOnlyRoot is undefined
  test("profile with no allow lists leaves readOnlyRoot undefined (caller did not opt in)", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.opts.readOnlyRoot).toBeUndefined();
    expect(r.value.opts.tmpfsMounts).toBeUndefined();
  });
});
