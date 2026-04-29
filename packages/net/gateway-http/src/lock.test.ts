import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock } from "./lock.js";

describe("PID lock", () => {
  test("first acquisition succeeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-lock-"));
    const lockPath = join(dir, "lock");
    const r = acquireLock(lockPath);
    expect(r.ok).toBe(true);
    if (r.ok) releaseLock(lockPath, r.value);
  });

  test("second acquisition with live PID fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-lock-"));
    const lockPath = join(dir, "lock");
    const r1 = acquireLock(lockPath);
    expect(r1.ok).toBe(true);
    const r2 = acquireLock(lockPath);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe("ALREADY_RUNNING");
    if (r1.ok) releaseLock(lockPath, r1.value);
  });

  test("stale lock (dead PID) is reclaimed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-lock-"));
    const lockPath = join(dir, "lock");
    await Bun.write(lockPath, "999999");
    const r = acquireLock(lockPath);
    expect(r.ok).toBe(true);
    if (r.ok) releaseLock(lockPath, r.value);
  });
});
