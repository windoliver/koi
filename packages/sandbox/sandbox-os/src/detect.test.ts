import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ARCH = process.arch;
const ORIGINAL_WHICH = Bun.which;
const ORIGINAL_SPAWN_SYNC = Bun.spawnSync;

function setProcessValue(key: "platform" | "arch", value: string): void {
  Object.defineProperty(process, key, {
    configurable: true,
    value,
  });
}

async function importDetect() {
  return import(`./detect.js?ts=${Date.now()}-${Math.random()}`);
}

/**
 * Build a readFileSync mock that returns different content per path.
 * Throws ENOENT for paths not in the map.
 */
function mockReadFileSync(paths: Record<string, string>): (path: string) => string {
  return (path: string): string => {
    const val = paths[path];
    if (val !== undefined) return val;
    throw Object.assign(new Error(`ENOENT: no such file: ${path}`), { code: "ENOENT" });
  };
}

describe("detectPlatform", () => {
  beforeEach(() => {
    mock.restore();
    Bun.which = ORIGINAL_WHICH;
    Bun.spawnSync = ORIGINAL_SPAWN_SYNC;
    setProcessValue("platform", ORIGINAL_PLATFORM);
    setProcessValue("arch", ORIGINAL_ARCH);
  });

  afterEach(() => {
    mock.restore();
    Bun.which = ORIGINAL_WHICH;
    Bun.spawnSync = ORIGINAL_SPAWN_SYNC;
    setProcessValue("platform", ORIGINAL_PLATFORM);
    setProcessValue("arch", ORIGINAL_ARCH);
  });

  test("returns seatbelt on darwin", async () => {
    setProcessValue("platform", "darwin");
    const { detectPlatform } = await importDetect();

    expect(detectPlatform()).toEqual({ ok: true, value: "seatbelt" });
  });

  test("returns bwrap on linux", async () => {
    setProcessValue("platform", "linux");
    setProcessValue("arch", "x64");
    mock.module("node:fs", () => ({
      readFileSync: mock(
        mockReadFileSync({
          "/proc/version": "Linux version 6.0.0",
          "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0",
        }),
      ),
    }));
    const { detectPlatform } = await importDetect();

    expect(detectPlatform()).toEqual({ ok: true, value: "bwrap" });
  });

  test("returns validation error on win32", async () => {
    setProcessValue("platform", "win32");
    const { detectPlatform } = await importDetect();

    const result = detectPlatform();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context?.sandboxCode).toBe("UNSUPPORTED_PLATFORM");
    }
  });

  test("returns validation error on WSL1 with WSL1 sandboxCode", async () => {
    setProcessValue("platform", "linux");
    setProcessValue("arch", "x64");
    mock.module("node:fs", () => ({
      readFileSync: mock(
        mockReadFileSync({
          "/proc/version": "Linux version 4.4.0 Microsoft",
        }),
      ),
    }));
    const { detectPlatform } = await importDetect();

    const result = detectPlatform();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("WSL1");
      expect(result.error.context?.sandboxCode).toBe("WSL1");
    }
  });

  test("returns validation error on ia32 with ARCH_UNSUPPORTED sandboxCode", async () => {
    setProcessValue("platform", "linux");
    setProcessValue("arch", "ia32");
    const { detectPlatform } = await importDetect();

    const result = detectPlatform();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("32-bit x86");
      expect(result.error.context?.sandboxCode).toBe("ARCH_UNSUPPORTED");
    }
  });

  // ---------------------------------------------------------------------------
  // AppArmor user-namespace restriction (Ubuntu 23.10+ / 24.04+)
  // ---------------------------------------------------------------------------

  test("returns APPARMOR_RESTRICTED when sysctl=1 AND bwrap probe fails", async () => {
    setProcessValue("platform", "linux");
    setProcessValue("arch", "x64");
    mock.module("node:fs", () => ({
      readFileSync: mock(
        mockReadFileSync({
          "/proc/version": "Linux version 6.8.0-ubuntu",
          "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1",
        }),
      ),
    }));
    // Simulate bwrap unable to create user namespace (probe fails)
    Bun.spawnSync = mock(() => ({ exitCode: 1 })) as unknown as typeof Bun.spawnSync;
    const { detectPlatform } = await importDetect();

    const result = detectPlatform();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context?.sandboxCode).toBe("APPARMOR_RESTRICTED");
      expect(result.error.message).toContain("AppArmor");
      expect(result.error.message).toContain("apparmor_restrict_unprivileged_userns");
    }
  });

  test("returns bwrap when sysctl=1 but AppArmor profile allows bwrap (probe succeeds)", async () => {
    setProcessValue("platform", "linux");
    setProcessValue("arch", "x64");
    mock.module("node:fs", () => ({
      readFileSync: mock(
        mockReadFileSync({
          "/proc/version": "Linux version 6.8.0-ubuntu",
          "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1",
        }),
      ),
    }));
    // Simulate bwrap usable despite sysctl (AppArmor profile installed)
    Bun.spawnSync = mock(() => ({ exitCode: 0 })) as unknown as typeof Bun.spawnSync;
    const { detectPlatform } = await importDetect();

    expect(detectPlatform()).toEqual({ ok: true, value: "bwrap" });
  });

  test("returns bwrap when AppArmor sysctl is 0 (restriction disabled)", async () => {
    setProcessValue("platform", "linux");
    setProcessValue("arch", "x64");
    mock.module("node:fs", () => ({
      readFileSync: mock(
        mockReadFileSync({
          "/proc/version": "Linux version 6.8.0-ubuntu",
          "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0",
        }),
      ),
    }));
    const { detectPlatform } = await importDetect();

    expect(detectPlatform()).toEqual({ ok: true, value: "bwrap" });
  });

  test("returns bwrap when AppArmor sysctl file is absent (non-Ubuntu)", async () => {
    setProcessValue("platform", "linux");
    setProcessValue("arch", "x64");
    mock.module("node:fs", () => ({
      readFileSync: mock(
        // AppArmor sysctl file absent — only /proc/version is readable
        mockReadFileSync({ "/proc/version": "Linux version 6.1.0-arch" }),
      ),
    }));
    const { detectPlatform } = await importDetect();

    expect(detectPlatform()).toEqual({ ok: true, value: "bwrap" });
  });
});

describe("checkAvailability", () => {
  beforeEach(() => {
    Bun.which = ORIGINAL_WHICH;
  });

  afterEach(() => {
    Bun.which = ORIGINAL_WHICH;
  });

  test("reports available when binary is found", async () => {
    Bun.which = mock(() => "/usr/bin/bwrap");
    const { checkAvailability } = await importDetect();

    await expect(checkAvailability("bwrap")).resolves.toEqual({ available: true });
  });

  test("reports unavailable with reason when binary is missing", async () => {
    Bun.which = mock(() => null);
    const { checkAvailability } = await importDetect();

    const result = await checkAvailability("seatbelt");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("sandbox-exec");
  });
});
