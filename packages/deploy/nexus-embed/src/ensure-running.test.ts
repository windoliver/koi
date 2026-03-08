import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConnectionState } from "./connection-store.js";
import { ensureNexusRunning } from "./ensure-running.js";
import { writePid } from "./pid-manager.js";
import type { ConnectionState, FetchFn, SpawnFn } from "./types.js";

/** Create a mock fetch that always returns 200. */
function createOkFetch(): FetchFn {
  return async () => new Response(null, { status: 200 });
}

/** Create a mock fetch that rejects (connection refused). */
function createRejectingFetch(): FetchFn {
  return async () => {
    throw new Error("Connection refused");
  };
}

/**
 * Create a mock fetch that fails N times then succeeds.
 */
function createEventualFetch(failCount: number): FetchFn {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failCount) {
      throw new Error("Connection refused");
    }
    return new Response(null, { status: 200 });
  };
}

/** Create a mock spawn that records calls and returns a fake PID. */
function createMockSpawn(pid = 42): {
  readonly spawn: SpawnFn;
  readonly calls: Array<{ readonly cmd: readonly string[] }>;
} {
  const calls: Array<{ readonly cmd: readonly string[] }> = [];
  const spawn: SpawnFn = (cmd) => {
    calls.push({ cmd });
    return { pid, unref: () => {} };
  };
  return { spawn, calls };
}

describe("ensureNexusRunning", () => {
  let tempDir: string;
  let savedNexusCommand: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexus-embed-ensure-"));
    savedNexusCommand = process.env.NEXUS_COMMAND;
    // Set NEXUS_COMMAND to something we control so checkBinaryAvailable succeeds
    process.env.NEXUS_COMMAND = "echo";
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (savedNexusCommand !== undefined) {
      process.env.NEXUS_COMMAND = savedNexusCommand;
    } else {
      delete process.env.NEXUS_COMMAND;
    }
  });

  test("reuses existing Nexus when health check passes", async () => {
    // Set up saved connection state
    const state: ConnectionState = {
      port: 2026,
      pid: 12345,
      host: "127.0.0.1",
      profile: "lite",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeConnectionState(tempDir, state);

    const result = await ensureNexusRunning({
      dataDir: tempDir,
      fetch: createOkFetch(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.spawned).toBe(false);
      expect(result.value.pid).toBe(12345);
      expect(result.value.baseUrl).toBe("http://127.0.0.1:2026");
    }
  });

  test("spawns new Nexus when nothing is running", async () => {
    const { spawn, calls } = createMockSpawn(7777);
    // First few calls fail (probeHealth), then succeed (pollHealth after spawn)
    // probeHealth for saved state: no saved state, skipped
    // probeHealth for existing on port: fail (call 1)
    // pollHealth after spawn: succeed (call 2)
    const mockFetch = createEventualFetch(1);

    const result = await ensureNexusRunning({
      dataDir: tempDir,
      port: 3000,
      host: "127.0.0.1",
      profile: "test",
      fetch: mockFetch,
      spawn,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.spawned).toBe(true);
      expect(result.value.pid).toBe(7777);
      expect(result.value.baseUrl).toBe("http://127.0.0.1:3000");
    }

    // Spawn should have been called once
    expect(calls.length).toBe(1);
    // The command should include serve, host, port, profile
    const cmd = calls[0]!.cmd;
    expect(cmd).toContain("serve");
    expect(cmd).toContain("--port");
    expect(cmd).toContain("3000");
    expect(cmd).toContain("--profile");
    expect(cmd).toContain("test");
  });

  test("returns NOT_FOUND error when binary not available", async () => {
    // Set NEXUS_COMMAND to something that doesn't exist
    process.env.NEXUS_COMMAND = "nonexistent-binary-abc123";

    const result = await ensureNexusRunning({
      dataDir: tempDir,
      fetch: createRejectingFetch(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("nonexistent-binary-abc123");
    }
  });

  test("cleans stale state before respawning", async () => {
    // Write stale connection state (process is dead)
    const state: ConnectionState = {
      port: 2026,
      pid: 999999,
      host: "127.0.0.1",
      profile: "lite",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeConnectionState(tempDir, state);
    writePid(tempDir, 999999);

    const { spawn } = createMockSpawn(8888);
    // First call: probeHealth for saved state fails
    // Second call: probeHealth for port check fails
    // Third call: pollHealth after spawn succeeds
    const mockFetch = createEventualFetch(2);

    const result = await ensureNexusRunning({
      dataDir: tempDir,
      fetch: mockFetch,
      spawn,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.spawned).toBe(true);
      expect(result.value.pid).toBe(8888);
    }
  });

  test("does not reuse saved state when config mismatches", async () => {
    // Saved state with port 2026, but caller wants port 3000
    const state: ConnectionState = {
      port: 2026,
      pid: 12345,
      host: "127.0.0.1",
      profile: "lite",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeConnectionState(tempDir, state);

    const { spawn } = createMockSpawn(9999);
    // Call 1: probeHealth for port 3000 fails (config mismatch skips saved state probe)
    // Call 2: pollHealth after spawn succeeds
    const mockFetch = createEventualFetch(1);

    const result = await ensureNexusRunning({
      dataDir: tempDir,
      port: 3000,
      host: "127.0.0.1",
      profile: "lite",
      fetch: mockFetch,
      spawn,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should spawn fresh — not reuse the saved state
      expect(result.value.spawned).toBe(true);
      expect(result.value.pid).toBe(9999);
      expect(result.value.baseUrl).toBe("http://127.0.0.1:3000");
    }
  });

  test(
    "cleans PID file on health poll failure",
    async () => {
      const { spawn } = createMockSpawn(5555);
      // All health checks fail — spawn succeeds but health poll times out
      const mockFetch = createRejectingFetch();

      const result = await ensureNexusRunning({
        dataDir: tempDir,
        fetch: mockFetch,
        spawn,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
      }

      // PID file should be cleaned up after failure
      const { readPid: readPidFn } = await import("./pid-manager.js");
      expect(readPidFn(tempDir)).toBeUndefined();
    },
    { timeout: 20_000 },
  );

  test("reuses Nexus running on port even without saved state", async () => {
    // No saved state, but probeHealth on the port succeeds
    const result = await ensureNexusRunning({
      dataDir: tempDir,
      fetch: createOkFetch(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.spawned).toBe(false);
    }
  });
});
