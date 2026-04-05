import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ARCH = process.arch;
const ORIGINAL_WHICH = Bun.which;

function setProcessValue(key: "platform" | "arch", value: string): void {
  Object.defineProperty(process, key, {
    configurable: true,
    value,
  });
}

async function importDetect() {
  return import(`./detect.js?ts=${Date.now()}-${Math.random()}`);
}

describe("detectPlatform", () => {
  beforeEach(() => {
    mock.restore();
    Bun.which = ORIGINAL_WHICH;
    setProcessValue("platform", ORIGINAL_PLATFORM);
    setProcessValue("arch", ORIGINAL_ARCH);
  });

  afterEach(() => {
    mock.restore();
    Bun.which = ORIGINAL_WHICH;
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
      readFileSync: mock(() => "Linux version 6.0.0"),
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
    }
  });

  test("returns validation error on WSL1", async () => {
    setProcessValue("platform", "linux");
    setProcessValue("arch", "x64");
    mock.module("node:fs", () => ({
      readFileSync: mock(() => "Linux version 4.4.0 Microsoft"),
    }));
    const { detectPlatform } = await importDetect();

    const result = detectPlatform();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("WSL1");
    }
  });

  test("returns validation error on ia32", async () => {
    setProcessValue("platform", "linux");
    setProcessValue("arch", "ia32");
    const { detectPlatform } = await importDetect();

    const result = detectPlatform();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("32-bit x86");
    }
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
