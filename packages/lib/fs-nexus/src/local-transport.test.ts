/**
 * Tests for local subprocess transport.
 *
 * Unit tests (notification protocol) — require Python 3 only.
 * Integration tests — require nexus-fs Python package installed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createLocalTransport } from "./local-transport.js";
import { createNexusFileSystem } from "./nexus-filesystem-backend.js";
import type { BridgeNotification, NexusTransport } from "./types.js";

/**
 * Remove nexus-fs CAS directories that leak into CWD during local mount tests.
 * nexus-fs creates `tmp<basename>/cas/` relative to the bridge's CWD when mounting
 * a `local://` URI. Even with graceful shutdown, these may survive if the bridge
 * doesn't clean them up in `fs.close()`. Call this after transport.close() returns.
 */
function cleanupNexusCasDirs(mountTmpDirs: readonly string[]): void {
  for (const tmpDir of mountTmpDirs) {
    const leaked = join(process.cwd(), `tmp${basename(tmpDir)}`);
    try {
      rmSync(leaked, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/** Brief delay so the bridge process can run `await fs.close()` after stdin EOF. */
function waitForBridgeCleanup(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 300));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a temp Python bridge script and return its path. */
function writeMockBridge(tmpDir: string, name: string, script: string): string {
  const path = join(tmpDir, `${name}.py`);
  writeFileSync(path, script, "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// Unit tests — notification protocol (Python 3 only, no nexus-fs)
// ---------------------------------------------------------------------------

describe("createLocalTransport notification protocol", () => {
  let tmpDir: string;
  let transport: NexusTransport;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "koi-transport-unit-"));
  });

  afterEach(() => {
    transport?.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // Test 9-A: notification arrives on stdout BEFORE the response to an in-flight call.
  // The background reader must dispatch the notification and still resolve the call.
  test("auth_required notification before response — call resolves correctly", async () => {
    const bridgePath = writeMockBridge(
      tmpDir,
      "mock-interleave",
      `
import sys, json

# Redirect print to stderr — stdout is the JSON-RPC channel
sys.stdout = sys.stderr

import sys as _sys
_stdout = open(1, "w", closefd=False)

def out(obj):
    _stdout.write(json.dumps(obj) + "\\n")
    _stdout.flush()

# Ready signal
out({"ready": True, "mounts": []})

# Read one request
line = sys.stdin.readline()
req = json.loads(line)

# Send auth_required notification (no id — this is the interleaving case)
out({"jsonrpc": "2.0", "method": "auth_required", "params": {
    "provider": "google-drive",
    "user_email": "test@example.com",
    "auth_url": "https://accounts.google.com/auth?test=1",
    "message": "Authorize Google Drive"
}})

# Then send the actual response for the request
out({"jsonrpc": "2.0", "id": req["id"], "result": {"content": "file content"}})
`,
    );

    transport = await createLocalTransport({
      mountUri: "local://./",
      _bridgePath: bridgePath,
      startupTimeoutMs: 5_000,
    });

    const notifications: BridgeNotification[] = [];
    transport.subscribe((n) => notifications.push(n));

    const result = await transport.call<{ readonly content: string }>("read", {
      path: "/file.txt",
    });

    // Call must succeed despite the notification arriving first
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("file content");

    // Notification must have been dispatched
    await new Promise<void>((r) => setTimeout(r, 10)); // microtask flush
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.method).toBe("auth_required");
  });

  // Test 11-B: pre-authed connector emits ZERO notifications (no regression).
  test("pre-authed connector — zero notifications emitted", async () => {
    const bridgePath = writeMockBridge(
      tmpDir,
      "mock-preauthed",
      `
import sys, json
sys.stdout = sys.stderr
_stdout = open(1, "w", closefd=False)

def out(obj):
    _stdout.write(json.dumps(obj) + "\\n")
    _stdout.flush()

out({"ready": True, "mounts": []})

line = sys.stdin.readline()
req = json.loads(line)
# Respond immediately — no auth_required sent
out({"jsonrpc": "2.0", "id": req["id"], "result": {"content": "already authed"}})
`,
    );

    transport = await createLocalTransport({
      mountUri: "local://./",
      _bridgePath: bridgePath,
      startupTimeoutMs: 5_000,
    });

    const notifications: BridgeNotification[] = [];
    transport.subscribe((n) => notifications.push(n));

    const result = await transport.call<{ readonly content: string }>("read", {
      path: "/file.txt",
    });

    expect(result.ok).toBe(true);
    await new Promise<void>((r) => setTimeout(r, 10));
    // Critical: no spurious auth notifications on pre-authed connectors
    expect(notifications).toHaveLength(0);
  });

  // Test 12-A: when bridge returns AUTH_TIMEOUT (-32007), transport returns AUTH_REQUIRED.
  // Uses a very small authTimeoutMs so the bridge-side poll expires quickly.
  test("auth timeout — call returns AUTH_REQUIRED with retryable:false", async () => {
    const bridgePath = writeMockBridge(
      tmpDir,
      "mock-auth-timeout",
      `
import sys, json, os, time
sys.stdout = sys.stderr
_stdout = open(1, "w", closefd=False)

def out(obj):
    _stdout.write(json.dumps(obj) + "\\n")
    _stdout.flush()

out({"ready": True, "mounts": []})

line = sys.stdin.readline()
req = json.loads(line)

# Send auth_required
out({"jsonrpc": "2.0", "method": "auth_required", "params": {
    "provider": "google-drive",
    "user_email": "test@example.com",
    "auth_url": "https://accounts.google.com/auth?test=1",
    "message": "Authorize Google Drive"
}})

# Simulate poll timeout — immediately return AUTH_TIMEOUT error
# (In production the bridge polls for NEXUS_AUTH_TIMEOUT_MS, then returns this)
out({"jsonrpc": "2.0", "id": req["id"], "error": {
    "code": -32007,
    "message": "OAuth authorization timed out. Complete the authorization and try again."
}})
`,
    );

    transport = await createLocalTransport({
      mountUri: "local://./",
      _bridgePath: bridgePath,
      startupTimeoutMs: 5_000,
      authTimeoutMs: 10_000, // extended so Koi doesn't time out before bridge responds
    });

    const result = await transport.call("read", { path: "/gdrive/file.txt" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_REQUIRED");
      expect(result.error.retryable).toBe(false); // user gave up — not auto-retryable
      expect(result.error.message).toMatch(/timed out/i);
    }
  });
});

// Check if nexus-fs is available
let nexusFsAvailable = false;
try {
  const proc = Bun.spawnSync(["python3", "-c", "import nexus.fs"]);
  nexusFsAvailable = proc.exitCode === 0;
} catch {
  nexusFsAvailable = false;
}

const describeIf = nexusFsAvailable ? describe : describe.skip;

describeIf("createLocalTransport (requires nexus-fs)", () => {
  let tmpDir: string;
  let transport: NexusTransport;
  /** Nexus mount point discovered from the bridge (e.g. "/local/koi-test-XXX"). */
  let mountPoint: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "koi-fs-nexus-test-"));
    transport = await createLocalTransport({
      mountUri: `local://${tmpDir}`,
      startupTimeoutMs: 15_000,
    });
    const firstMount = transport.mounts?.[0];
    expect(firstMount).toBeDefined();
    mountPoint = firstMount ?? "";
  });

  afterEach(async () => {
    transport.close();
    await waitForBridgeCleanup();
    cleanupNexusCasDirs([tmpDir]);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Cleanup best-effort
    }
  });

  test("write and read round-trip", async () => {
    const writeResult = await transport.call<{ readonly bytes_written: number }>("write", {
      path: `${mountPoint}/hello.txt`,
      content: "hello from koi",
    });
    expect(writeResult.ok).toBe(true);

    const readResult = await transport.call<{ readonly content: string }>("read", {
      path: `${mountPoint}/hello.txt`,
    });
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("hello from koi");
    }
  });

  test("list files", async () => {
    await transport.call("write", { path: `${mountPoint}/a.txt`, content: "a" });
    await transport.call("write", { path: `${mountPoint}/b.txt`, content: "b" });

    const result = await transport.call<{
      readonly files: readonly { readonly path: string }[];
    }>("list", {
      path: mountPoint,
      details: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("read non-existent file returns NOT_FOUND", async () => {
    const result = await transport.call("read", {
      path: `${mountPoint}/does-not-exist.txt`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("full backend: write → read round-trip", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    const writeResult = await backend.write("/e2e-test.txt", "hello nexus-fs");
    expect(writeResult.ok).toBe(true);

    const readResult = await backend.read("/e2e-test.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("hello nexus-fs");
      expect(readResult.value.path).toBe("/e2e-test.txt");
      expect(readResult.value.size).toBeGreaterThan(0);
    }
  });

  test("full backend: edit with native Nexus edit RPC", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-edit.txt", "hello world");
    const editResult = await backend.edit("/e2e-edit.txt", [
      { oldText: "hello", newText: "goodbye" },
    ]);
    expect(editResult.ok).toBe(true);
    if (editResult.ok) expect(editResult.value.hunksApplied).toBe(1);

    const readResult = await backend.read("/e2e-edit.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) expect(readResult.value.content).toBe("goodbye world");
  });

  test("full backend: list files", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-list/a.txt", "aaa");
    await backend.write("/e2e-list/b.txt", "bbb");
    const listResult = await backend.list("/e2e-list", { recursive: true });
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      const paths = listResult.value.entries.map((e) => e.path);
      expect(paths.some((p) => p.includes("a.txt"))).toBe(true);
      expect(paths.some((p) => p.includes("b.txt"))).toBe(true);
    }
  });

  test("full backend: search via client-side fallback", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-search/target.txt", "findme in this line\nother line");
    const searchResult = await backend.search("findme");
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      expect(searchResult.value.matches.length).toBeGreaterThanOrEqual(1);
      expect(searchResult.value.matches[0]?.text).toContain("findme");
    }
  });

  test("full backend: delete file", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-delete.txt", "bye");
    const del = backend.delete;
    expect(del).toBeDefined();
    if (del === undefined) return;

    const delResult = await del("/e2e-delete.txt");
    expect(delResult.ok).toBe(true);

    const readResult = await backend.read("/e2e-delete.txt");
    expect(readResult.ok).toBe(false);
  });

  test("full backend: rename file", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-rename-src.txt", "content");
    const rename = backend.rename;
    expect(rename).toBeDefined();
    if (rename === undefined) return;

    const renameResult = await rename("/e2e-rename-src.txt", "/e2e-rename-dst.txt");
    expect(renameResult.ok).toBe(true);

    const readResult = await backend.read("/e2e-rename-dst.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) expect(readResult.value.content).toBe("content");
  });

  test("full backend: edit dryRun does not modify file", async () => {
    const backend = createNexusFileSystem({
      url: "local://unused",
      mountPoint: mountPoint.slice(1),
      transport,
    });

    await backend.write("/e2e-dryrun.txt", "original content");
    const editResult = await backend.edit(
      "/e2e-dryrun.txt",
      [{ oldText: "original", newText: "modified" }],
      { dryRun: true },
    );
    expect(editResult.ok).toBe(true);
    if (editResult.ok) expect(editResult.value.hunksApplied).toBe(1);

    // File should be unchanged
    const readResult = await backend.read("/e2e-dryrun.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) expect(readResult.value.content).toBe("original content");
  });
});

// Test 10-A: multi-mount auth with serial transport.
// The bridge is serial — one auth challenge blocks all queued calls until it resolves.
// This test verifies that after a gdrive auth failure (-32007), the next queued call
// (local) still executes and succeeds. Uses a mock async bridge (no nexus-fs needed).
// Note: with a real serial bridge, the local call is QUEUED behind the gdrive call —
// it does not run concurrently. Both resolve in order: gdrive first, then local.
describe("createLocalTransport multi-mount serial auth", () => {
  let tmpDir: string;
  let transport: NexusTransport;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "koi-multi-auth-"));
  });

  afterEach(() => {
    transport?.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("local mount call succeeds after gdrive auth failure resolves (serial ordering)", async () => {
    const bridgePath = writeMockBridge(
      tmpDir,
      "mock-multi-mount-auth",
      `
import sys, json, asyncio
sys.stdout = sys.stderr
_stdout = open(1, "w", closefd=False)

def out(obj):
    _stdout.write(json.dumps(obj) + "\\n")
    _stdout.flush()

async def main():
    out({"ready": True, "mounts": ["/local/ws", "/gdrive"]})

    loop = asyncio.get_event_loop()

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        path = req.get("params", {}).get("path", "")

        if "gdrive" in path:
            # Simulate auth required for gdrive calls — send notification then error
            out({"jsonrpc": "2.0", "method": "auth_required", "params": {
                "provider": "google-drive",
                "user_email": "",
                "auth_url": "https://accounts.google.com/auth?test=1",
                "message": "Authorize Google Drive"
            }})
            out({"jsonrpc": "2.0", "id": req["id"], "error": {
                "code": -32007, "message": "Auth timed out"
            }})
        else:
            # Local paths succeed immediately
            out({"jsonrpc": "2.0", "id": req["id"], "result": {"content": "local file"}})

asyncio.run(main())
`,
    );

    transport = await createLocalTransport({
      mountUri: ["local:///ws", "gdrive://my-drive"],
      _bridgePath: bridgePath,
      startupTimeoutMs: 5_000,
    });

    // Queue both calls — the transport is serial, so gdrive runs first, then local.
    // Promise.all submits both to callQueue; gdrive acquires the slot first.
    const [gdriveResult, localResult] = await Promise.all([
      transport.call("read", { path: "/gdrive/secret.txt" }),
      transport.call<{ readonly content: string }>("read", { path: "/local/ws/readme.txt" }),
    ]);

    // gdrive fails with AUTH_REQUIRED (auth timed out)
    expect(gdriveResult.ok).toBe(false);
    if (!gdriveResult.ok) expect(gdriveResult.error.code).toBe("AUTH_REQUIRED");

    // local succeeds — it ran after gdrive resolved (serial ordering)
    expect(localResult.ok).toBe(true);
    if (localResult.ok) expect(localResult.value.content).toBe("local file");
  });
});

// ---------------------------------------------------------------------------
// Bridge startup failure tests — stderr collection (Issue #1743)
// ---------------------------------------------------------------------------

describe("createLocalTransport bridge startup failure", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "koi-transport-crash-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("includes full Python traceback in error when bridge crashes on startup", async () => {
    // Write more than one OS pipe buffer (~64KB on macOS) to stderr so that
    // collectStderr must read multiple chunks. The FINAL_MARKER at the end
    // proves the entire stream was drained — a single-read implementation
    // will capture only the first ~64KB and miss it.
    const bridgePath = writeMockBridge(
      tmpDir,
      "mock-crash",
      `
import sys
sys.stderr.write("Traceback (most recent call last):\\n")
# Pad with enough frames to exceed one pipe buffer chunk
for i in range(2000):
    sys.stderr.write(f"  File \\"mod_{i}.py\\", line {i}, in func_{i}\\n")
sys.stderr.write("FINAL_MARKER: AttributeError: 'NoneType' object has no attribute 'register_observer'\\n")
sys.stderr.flush()
sys.exit(1)
`,
    );

    try {
      await createLocalTransport({
        mountUri: "local://./",
        _bridgePath: bridgePath,
        startupTimeoutMs: 5_000,
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      const err = e as Error;
      // Must include the full stderr — not just the first pipe buffer chunk
      expect(err.message).toContain("Traceback");
      expect(err.message).toContain("FINAL_MARKER");
      expect(err.message).toContain("register_observer");
    }
  });

  test("preserves cause chain on startup failure", async () => {
    const bridgePath = writeMockBridge(
      tmpDir,
      "mock-crash-cause",
      `
import sys
sys.stderr.write("fatal error in bridge\\n")
sys.stderr.flush()
sys.exit(1)
`,
    );

    try {
      await createLocalTransport({
        mountUri: "local://./",
        _bridgePath: bridgePath,
        startupTimeoutMs: 5_000,
      });
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      const err = e as Error;
      // Must chain the original error as cause with the specific startup failure
      expect(err.cause).toBeInstanceOf(Error);
      const cause = err.cause as Error;
      expect(cause.message).toMatch(/Stream ended|exited with code/);
    }
  });

  test("truncates stderr exceeding size cap and includes marker", async () => {
    // Write >256KiB to stderr to trigger the size cap
    const bridgePath = writeMockBridge(
      tmpDir,
      "mock-large-stderr",
      `
import sys
# Write ~300KiB — exceeds the 256KiB cap
for i in range(6000):
    sys.stderr.write(f"frame {i}: " + "x" * 45 + "\\n")
sys.stderr.flush()
sys.exit(1)
`,
    );

    try {
      await createLocalTransport({
        mountUri: "local://./",
        _bridgePath: bridgePath,
        startupTimeoutMs: 5_000,
      });
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      const err = e as Error;
      expect(err.message).toContain("[truncated");
      expect(err.message).toContain("bytes]");
      // Should still contain early frames
      expect(err.message).toContain("frame 0:");
      // Late frames (near 6000) must NOT appear — they exceed the 256KiB cap
      expect(err.message).not.toContain("frame 5999:");
      // Verify the stderr portion is bounded near the cap (256KiB + marker overhead)
      const stderrStart = err.message.indexOf("stderr:");
      if (stderrStart !== -1) {
        const stderrPortion = err.message.slice(stderrStart);
        expect(stderrPortion.length).toBeLessThan(300_000); // 256KiB + some overhead
      }
    }
  });

  test("preserves partial stderr when drain times out", async () => {
    // Bridge writes some stderr, ignores SIGTERM, and keeps pipe open.
    // After proc.kill(), the process stays alive holding stderr open,
    // so collectStderr's 3s drain timeout fires. We should get partial
    // stderr + timeout marker.
    const bridgePath = writeMockBridge(
      tmpDir,
      "mock-hang-stderr",
      `
import sys, signal, time
# Ignore SIGTERM so proc.kill() doesn't close stderr
signal.signal(signal.SIGTERM, signal.SIG_IGN)
sys.stderr.write("PARTIAL_STDERR: something went wrong\\n")
sys.stderr.flush()
# Keep stderr open — never exit, never close pipe
time.sleep(60)
`,
    );

    try {
      await createLocalTransport({
        mountUri: "local://./",
        _bridgePath: bridgePath,
        startupTimeoutMs: 1_000,
      });
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      const err = e as Error;
      // Must contain the partial stderr that was written before the hang
      expect(err.message).toContain("PARTIAL_STDERR");
      // Must contain the timeout truncation marker
      expect(err.message).toContain("[truncated — stderr drain timed out]");
    }
  }, 10_000); // Allow 10s for startup timeout + drain timeout

  test("handles bridge that writes nothing to stderr before crashing", async () => {
    const bridgePath = writeMockBridge(
      tmpDir,
      "mock-silent-crash",
      `
import sys
sys.exit(1)
`,
    );

    try {
      await createLocalTransport({
        mountUri: "local://./",
        _bridgePath: bridgePath,
        startupTimeoutMs: 5_000,
      });
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      const err = e as Error;
      // Should still produce a meaningful error, just without stderr content
      expect(err.message).toContain("Failed to start nexus-fs bridge");
    }
  });
});

describeIf("createLocalTransport multi-mount (requires nexus-fs)", () => {
  let tmpDirA: string;
  let tmpDirB: string;
  let transport: NexusTransport;

  beforeEach(async () => {
    tmpDirA = mkdtempSync(join(tmpdir(), "koi-multi-a-"));
    tmpDirB = mkdtempSync(join(tmpdir(), "koi-multi-b-"));
    transport = await createLocalTransport({
      mountUri: [`local://${tmpDirA}`, `local://${tmpDirB}`],
      startupTimeoutMs: 15_000,
    });
  });

  afterEach(async () => {
    transport.close();
    await waitForBridgeCleanup();
    cleanupNexusCasDirs([tmpDirA, tmpDirB]);
    try {
      rmSync(tmpDirA, { recursive: true, force: true });
      rmSync(tmpDirB, { recursive: true, force: true });
    } catch {
      // Cleanup best-effort
    }
  });

  test("reports multiple mount points", () => {
    expect(transport.mounts).toBeDefined();
    expect(transport.mounts?.length).toBe(2);
  });

  test("write/read to different mounts", async () => {
    const mounts = transport.mounts ?? [];
    expect(mounts.length).toBe(2);
    const mountA = mounts[0] ?? "";
    const mountB = mounts[1] ?? "";

    // Write to mount A
    const writeA = await transport.call("write", {
      path: `${mountA}/fileA.txt`,
      content: "from mount A",
    });
    expect(writeA.ok).toBe(true);

    // Write to mount B
    const writeB = await transport.call("write", {
      path: `${mountB}/fileB.txt`,
      content: "from mount B",
    });
    expect(writeB.ok).toBe(true);

    // Read back from each — files are isolated
    const readA = await transport.call<{ readonly content: string }>("read", {
      path: `${mountA}/fileA.txt`,
    });
    expect(readA.ok).toBe(true);
    if (readA.ok) expect(readA.value.content).toBe("from mount A");

    const readB = await transport.call<{ readonly content: string }>("read", {
      path: `${mountB}/fileB.txt`,
    });
    expect(readB.ok).toBe(true);
    if (readB.ok) expect(readB.value.content).toBe("from mount B");

    // Mount A should NOT have mount B's file
    const crossRead = await transport.call("read", {
      path: `${mountA}/fileB.txt`,
    });
    expect(crossRead.ok).toBe(false);
  });
});
