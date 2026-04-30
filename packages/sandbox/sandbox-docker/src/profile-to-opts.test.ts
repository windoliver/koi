import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
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

  // Fix 4: filesystem allowRead/allowWrite → bind mounts (paths must exist on host)
  test("maps allowWrite paths to rw bind mounts", () => {
    // Create a real temp dir on the host so bind source validation passes.
    const readDir = mkdtempSync(`${tmpdir()}/koi-test-read-`);
    const writeDir = mkdtempSync(`${tmpdir()}/koi-test-write-`);
    try {
      const r = mapProfileToDockerOpts(
        {
          filesystem: {
            defaultReadAccess: "open",
            allowRead: [readDir],
            allowWrite: [writeDir],
          },
          network: { allow: false },
          resources: {},
        },
        "ubuntu:22.04",
      );
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("Expected ok");
      expect(r.value.opts.binds).toContain(`${readDir}:${readDir}:ro`);
      expect(r.value.opts.binds).toContain(`${writeDir}:${writeDir}:rw`);
    } finally {
      rmdirSync(readDir);
      rmdirSync(writeDir);
    }
  });

  // Fix 4: nexusMounts → bind mounts (mountPath must exist on host)
  test("maps nexusMounts to rw bind mounts", () => {
    const mountDir = mkdtempSync(`${tmpdir()}/koi-test-nexus-`);
    try {
      const r = mapProfileToDockerOpts(
        {
          filesystem: { defaultReadAccess: "open" },
          network: { allow: false },
          resources: {},
          nexusMounts: [
            {
              nexusUrl: "http://nexus.internal",
              apiKey: "secret",
              mountPath: mountDir,
            },
          ],
        },
        "ubuntu:22.04",
      );
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("Expected ok");
      expect(r.value.opts.binds).toContain(`${mountDir}:${mountDir}:rw`);
    } finally {
      rmdirSync(mountDir);
    }
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
    const writeDir = mkdtempSync(`${tmpdir()}/koi-test-rw-`);
    try {
      const r = mapProfileToDockerOpts(
        {
          filesystem: {
            defaultReadAccess: "open",
            allowWrite: [writeDir],
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
    } finally {
      rmdirSync(writeDir);
    }
  });

  // Fix 2 (read-only rootfs): profile with allowRead only → opts has readOnlyRoot + tmpfsMounts
  test("profile with allowRead only sets readOnlyRoot:true and tmpfsMounts:[/tmp] on opts", () => {
    const readDir = mkdtempSync(`${tmpdir()}/koi-test-ro-`);
    try {
      const r = mapProfileToDockerOpts(
        {
          filesystem: {
            defaultReadAccess: "open",
            allowRead: [readDir],
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
    } finally {
      rmdirSync(readDir);
    }
  });

  // Fix 1: unsupported resources field → VALIDATION (fail-closed)
  test("returns ok:false VALIDATION when resources contains unsupported field timeoutMs", () => {
    // ResourceLimits has timeoutMs which Docker cannot enforce — must be rejected.
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: { maxPids: 64, timeoutMs: 5000 },
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toContain("resources.timeoutMs");
  });

  // Fix 1: unsupported resources field maxOpenFiles → VALIDATION
  test("returns ok:false VALIDATION when resources contains unsupported field maxOpenFiles", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: { maxOpenFiles: 256 },
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toContain("resources.maxOpenFiles");
  });

  // Fix 1: only supported fields (maxPids + maxMemoryMb) → ok
  test("accepts resources with only supported fields maxPids and maxMemoryMb", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: { maxPids: 32, maxMemoryMb: 128 },
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.opts.pidsLimit).toBe(32);
    expect(r.value.opts.memoryMb).toBe(128);
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

  // Fix 2 (bind source validation): non-existent allowRead path → ok:false VALIDATION
  test("returns ok:false VALIDATION when allowRead path does not exist on host", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open", allowRead: ["/nonexistent/koi-test-path"] },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toContain("/nonexistent/koi-test-path");
  });

  // Fix 2 (bind source validation): relative allowRead path → ok:false VALIDATION
  test("returns ok:false VALIDATION when allowRead path is relative", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open", allowRead: ["./relative/path"] },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toContain("absolute");
  });

  // Fix 2 (bind source validation): existing allowRead path → ok
  test("accepts allowRead with existing absolute path", () => {
    // /tmp always exists; safe to use for validation test
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open", allowRead: [tmpdir()] },
        network: { allow: false },
        resources: {},
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(true);
  });

  // Fix 2 (bind source validation): non-existent nexusMount mountPath → ok:false VALIDATION
  test("returns ok:false VALIDATION when nexusMount mountPath does not exist on host", () => {
    const r = mapProfileToDockerOpts(
      {
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: {},
        nexusMounts: [
          {
            nexusUrl: "http://nexus.internal",
            apiKey: "secret",
            mountPath: "/nonexistent/koi-nexus-mount",
          },
        ],
      },
      "ubuntu:22.04",
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toContain("/nonexistent/koi-nexus-mount");
  });
});
