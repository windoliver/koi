import { afterAll, describe, expect, test } from "bun:test";

import type { SandboxProfile } from "@koi/core";

import { createOsAdapterForTest } from "../adapter.js";
import { generateSeatbeltProfile } from "./seatbelt.js";

const BASE_PROFILE: SandboxProfile = {
  filesystem: {
    defaultReadAccess: "open",
  },
  network: {
    allow: true,
  },
  resources: {},
};

describe("generateSeatbeltProfile", () => {
  test.skipIf(process.platform !== "darwin")("starts with version and deny default", () => {
    const profile = generateSeatbeltProfile(BASE_PROFILE);

    expect(profile.startsWith("(version 1)\n(deny default)\n")).toBe(true);
  });

  test.skipIf(process.platform !== "darwin")("allows network when enabled", () => {
    expect(generateSeatbeltProfile(BASE_PROFILE)).toContain("(allow network*)");
  });

  test.skipIf(process.platform !== "darwin")("denies network when disabled", () => {
    expect(generateSeatbeltProfile({ ...BASE_PROFILE, network: { allow: false } })).toContain(
      "(deny network*)",
    );
  });

  test.skipIf(process.platform !== "darwin")(
    "renders denyRead rules as explicit file-read-data + file-read-metadata",
    () => {
      const profile = generateSeatbeltProfile({
        ...BASE_PROFILE,
        filesystem: { defaultReadAccess: "open", denyRead: ["/foo"] },
      });
      // Must use explicit operation names — NOT file-read* wildcard (silent no-op in seatbelt)
      expect(profile).toContain('(deny file-read-data (subpath "/foo"))');
      expect(profile).toContain('(deny file-read-metadata (subpath "/foo"))');
      expect(profile).not.toContain("file-read*");
    },
  );

  test.skipIf(process.platform !== "darwin")("renders allowWrite rules", () => {
    expect(
      generateSeatbeltProfile({
        ...BASE_PROFILE,
        filesystem: {
          defaultReadAccess: "open",
          allowWrite: ["/bar"],
        },
      }),
    ).toContain('(allow file-write* (subpath "/bar"))');
  });

  // -------------------------------------------------------------------------
  // macOS path canonicalization (/var, /tmp, /etc → /private/*)
  // -------------------------------------------------------------------------

  test.skipIf(process.platform !== "darwin")(
    "/tmp allowWrite path is canonicalized to /private/tmp",
    () => {
      const profile = generateSeatbeltProfile({
        ...BASE_PROFILE,
        filesystem: { defaultReadAccess: "open", allowWrite: ["/tmp/koi-test"] },
      });
      expect(profile).toContain('(allow file-write* (subpath "/private/tmp/koi-test"))');
      expect(profile).not.toContain('(allow file-write* (subpath "/tmp/koi-test"))');
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "/var denyRead path is canonicalized to /private/var",
    () => {
      const profile = generateSeatbeltProfile({
        ...BASE_PROFILE,
        filesystem: { defaultReadAccess: "open", denyRead: ["/var/db/sudo"] },
      });
      expect(profile).toContain('(deny file-read-data (subpath "/private/var/db/sudo"))');
      expect(profile).toContain('(deny file-read-metadata (subpath "/private/var/db/sudo"))');
      expect(profile).not.toContain('(subpath "/var/db/sudo")');
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "/etc denyWrite path is canonicalized to /private/etc",
    () => {
      const profile = generateSeatbeltProfile({
        ...BASE_PROFILE,
        filesystem: { defaultReadAccess: "open", denyWrite: ["/etc/hosts"] },
      });
      expect(profile).toContain('(deny file-write* (subpath "/private/etc/hosts"))');
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "non-symlink paths are passed through unchanged",
    () => {
      const profile = generateSeatbeltProfile({
        ...BASE_PROFILE,
        filesystem: { defaultReadAccess: "open", allowWrite: ["/Users/runner/work"] },
      });
      expect(profile).toContain('(allow file-write* (subpath "/Users/runner/work"))');
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "opts.home overrides process.env.HOME for tilde expansion",
    () => {
      const profile = generateSeatbeltProfile(
        { ...BASE_PROFILE, filesystem: { defaultReadAccess: "open", denyRead: ["~/.ssh"] } },
        { home: "/custom/home" },
      );
      expect(profile).toContain('(deny file-read-data (subpath "/custom/home/.ssh"))');
      expect(profile).toContain('(deny file-read-metadata (subpath "/custom/home/.ssh"))');
      expect(profile).not.toContain(process.env.HOME ?? "__no_home__");
    },
  );
});

// ---------------------------------------------------------------------------
// Enforcement integration tests — require SANDBOX_INTEGRATION=1 on macOS
// ---------------------------------------------------------------------------

const SKIP_ENFORCEMENT = !process.env.SANDBOX_INTEGRATION || process.platform !== "darwin";

describe.skipIf(SKIP_ENFORCEMENT)("seatbelt enforcement", () => {
  const id = Date.now().toString(16);
  const allowedFile = `/tmp/koi-enforce-${id}-allowed.txt`;

  afterAll(async () => {
    const f = Bun.file(allowedFile);
    if (await f.exists()) {
      await Bun.write(allowedFile, "");
    }
  });

  test("write to explicitly allowed /tmp path succeeds", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    const instance = await adapter.create({
      filesystem: { defaultReadAccess: "open", allowWrite: ["/tmp"] },
      network: { allow: false },
      resources: {},
    });
    const result = await instance.exec("/bin/sh", ["-c", `echo ok > ${allowedFile}`]);
    expect(result.exitCode).toBe(0);
  });

  test("write to non-allowed sibling /tmp path is denied", async () => {
    const deniedFile = `/tmp/koi-enforce-${id}-denied.txt`;
    // allowWrite covers only a specific subpath, not the sibling deniedFile
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    const instance = await adapter.create({
      filesystem: {
        defaultReadAccess: "open",
        allowWrite: [`/tmp/koi-enforce-${id}-allowed-subdir`],
      },
      network: { allow: false },
      resources: {},
    });
    const result = await instance.exec("/bin/sh", ["-c", `echo bad > ${deniedFile}`]);
    expect(result.exitCode).not.toBe(0);
  });

  test("sandboxed process runs and returns stdout", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    const instance = await adapter.create({
      filesystem: { defaultReadAccess: "open" },
      network: { allow: false },
      resources: {},
    });
    const result = await instance.exec("/bin/echo", ["hello sandbox"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello sandbox");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
  });

  test("timeout kills the sandboxed process", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    const instance = await adapter.create({
      filesystem: { defaultReadAccess: "open" },
      network: { allow: false },
      resources: {},
    });
    const result = await instance.exec("/bin/sleep", ["60"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(5000);
  });

  test("network access is denied when policy is false", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    const instance = await adapter.create({
      filesystem: { defaultReadAccess: "open" },
      network: { allow: false },
      resources: {},
    });
    // bash's /dev/tcp triggers a connect() syscall — Seatbelt denies it with EPERM,
    // producing "not permitted" in stderr. A normal connection refusal (port closed,
    // network allowed) produces "Connection refused" instead.
    const result = await instance.exec("/bin/bash", [
      "-c",
      "(exec 3>/dev/tcp/127.0.0.1/65000) 2>&1 | grep -qc 'not permitted'",
    ]);
    // grep exits 0 when "not permitted" is found → Seatbelt correctly denied the socket
    expect(result.exitCode).toBe(0);
  });
});
