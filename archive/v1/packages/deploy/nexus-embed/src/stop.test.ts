import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConnectionState, writeConnectionState } from "./connection-store.js";
import { readPid, writePid } from "./pid-manager.js";
import { stopEmbedNexus } from "./stop.js";
import type { ConnectionState } from "./types.js";

describe("stopEmbedNexus", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexus-embed-stop-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns NOT_FOUND when no PID file exists", async () => {
    const result = await stopEmbedNexus({ dataDir: tempDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("No Nexus embed PID file found");
    }
  });

  test("cleans up state files when process is already dead", async () => {
    // Write a PID that's almost certainly dead
    writePid(tempDir, 999999);
    const state: ConnectionState = {
      port: 2026,
      pid: 999999,
      host: "127.0.0.1",
      profile: "lite",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeConnectionState(tempDir, state);

    const result = await stopEmbedNexus({ dataDir: tempDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pid).toBe(999999);
      expect(result.value.wasRunning).toBe(false);
    }

    // PID file should be cleaned up
    expect(readPid(tempDir)).toBeUndefined();
  });

  test("returns ok with wasRunning=false for dead process", async () => {
    // Use a PID that we know is dead to avoid killing anything.
    writePid(tempDir, 999999);

    const result = await stopEmbedNexus({ dataDir: tempDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pid).toBe(999999);
      // Process 999999 is (almost certainly) dead, so wasRunning=false
      expect(result.value.wasRunning).toBe(false);
    }
  });

  test("cleans up both PID and connection state files", async () => {
    writePid(tempDir, 999999);
    const state: ConnectionState = {
      port: 2026,
      pid: 999999,
      host: "127.0.0.1",
      profile: "lite",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeConnectionState(tempDir, state);

    await stopEmbedNexus({ dataDir: tempDir });

    // Both files should be removed
    expect(readPid(tempDir)).toBeUndefined();
    // embed.json should also be gone
    expect(readConnectionState(tempDir)).toBeUndefined();
  });
});
