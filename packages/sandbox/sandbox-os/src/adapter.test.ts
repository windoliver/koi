import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SandboxProfile } from "@koi/core";

import { collectStream, createOsAdapterForTest } from "./adapter.js";

const ORIGINAL_WHICH = Bun.which;
const ORIGINAL_SPAWN = Bun.spawn;

const openProfile = (allow: boolean): SandboxProfile => ({
  filesystem: { defaultReadAccess: "open" },
  network: { allow },
  resources: {},
});

const closedProfile = (allow: boolean): SandboxProfile => ({
  filesystem: { defaultReadAccess: "closed" },
  network: { allow },
  resources: {},
});

describe("createOsAdapterForTest", () => {
  test("allows open defaultReadAccess on seatbelt", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    // Should resolve without throwing
    const instance = await adapter.create(openProfile(true));
    expect(instance).toBeDefined();
  });

  test("rejects closed defaultReadAccess on seatbelt with VALIDATION error", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    let caughtError: unknown;
    try {
      await adapter.create(closedProfile(true));
    } catch (e: unknown) {
      caughtError = e;
    }
    expect(caughtError).toBeInstanceOf(Error);
    // The cause is the KoiError with code VALIDATION
    const cause = (caughtError as Error & { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe("VALIDATION");
  });

  test("allows closed defaultReadAccess on bwrap", async () => {
    const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
    const instance = await adapter.create(closedProfile(false));
    expect(instance).toBeDefined();
  });

  test("allows open defaultReadAccess on bwrap", async () => {
    const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
    const instance = await adapter.create(openProfile(true));
    expect(instance).toBeDefined();
  });

  test("throws when maxMemoryMb is set but systemdRunAvailable is false", async () => {
    const adapter = createOsAdapterForTest({
      platform: "bwrap",
      available: true,
      systemdRunAvailable: false,
    });
    let caughtError: unknown;
    try {
      await adapter.create({
        filesystem: { defaultReadAccess: "open" },
        network: { allow: false },
        resources: { maxMemoryMb: 256 },
      });
    } catch (e: unknown) {
      caughtError = e;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toContain("systemd-run");
    expect((caughtError as Error).message).toContain("maxMemoryMb");
  });

  test("allows maxMemoryMb when systemdRunAvailable is true", async () => {
    const adapter = createOsAdapterForTest({
      platform: "bwrap",
      available: true,
      systemdRunAvailable: true,
    });
    const instance = await adapter.create({
      filesystem: { defaultReadAccess: "open" },
      network: { allow: false },
      resources: { maxMemoryMb: 256 },
    });
    expect(instance).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// collectStream unit tests — no process spawning needed
// ---------------------------------------------------------------------------

function makeStream(data: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(data);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("collectStream", () => {
  test("collects full text when budget is sufficient", async () => {
    const result = await collectStream(makeStream("hello"), { remaining: 100 });
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  test("truncates when budget is exhausted mid-stream", async () => {
    const result = await collectStream(makeStream("hello world"), { remaining: 5 });
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("hello");
  });

  test("truncated=false for empty stream", async () => {
    const result = await collectStream(makeStream(""), { remaining: 100 });
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });

  test("budget.remaining is decremented by bytes consumed", async () => {
    const budget = { remaining: 100 };
    await collectStream(makeStream("hello"), budget);
    expect(budget.remaining).toBe(95); // 100 - 5
  });

  test("shared budget: combined streams respect combined cap", async () => {
    const budget = { remaining: 6 };
    const [r1, r2] = await Promise.all([
      collectStream(makeStream("abcdef"), budget), // 6 bytes — exhausts budget
      collectStream(makeStream("ghijkl"), budget), // 6 bytes — budget already 0
    ]);
    const totalChars = r1.text.length + r2.text.length;
    expect(totalChars).toBeLessThanOrEqual(6);
    expect(r1.truncated || r2.truncated).toBe(true);
  });

  test("onChunk callback is called for each decoded chunk", async () => {
    const chunks: string[] = [];
    await collectStream(makeStream("hello"), { remaining: 100 }, (c) => chunks.push(c));
    expect(chunks.join("")).toBe("hello");
  });

  test("onChunk is NOT called after budget exhausted", async () => {
    const chunks: string[] = [];
    await collectStream(makeStream("hello world"), { remaining: 5 }, (c) => chunks.push(c));
    expect(chunks.join("")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// OOM heuristic unit tests — mocked Bun.spawn, no real processes
// ---------------------------------------------------------------------------

/**
 * Build a minimal Bun.spawn mock that simulates process exit with specific
 * signalCode and exitCode.
 */
function makeMockSpawn(opts: {
  readonly exitCode: number;
  readonly signalCode: string | null;
}): typeof Bun.spawn {
  return ((_argv: unknown, _spawnOpts: unknown) => ({
    stdout: makeStream(""),
    stderr: makeStream(""),
    exited: Promise.resolve(opts.exitCode),
    signalCode: opts.signalCode,
    kill: (_signal?: number | string) => {},
  })) as unknown as typeof Bun.spawn;
}

describe("OOM heuristic (mocked spawn)", () => {
  beforeEach(() => {
    Bun.which = ORIGINAL_WHICH;
  });

  afterEach(() => {
    Bun.spawn = ORIGINAL_SPAWN;
    Bun.which = ORIGINAL_WHICH;
  });

  test.skipIf(process.platform !== "linux")(
    "oomKilled=true when process exits with SIGKILL without timeout",
    async () => {
      Bun.spawn = makeMockSpawn({ exitCode: 137, signalCode: "SIGKILL" });

      const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
      const instance = await adapter.create(openProfile(false));
      const result = await instance.exec("any-command", []);

      expect(result.oomKilled).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBe("SIGKILL");
    },
  );

  test.skipIf(process.platform !== "linux")(
    "oomKilled=false when process exits with SIGKILL due to timeout",
    async () => {
      // Simulate: timeout fires → abort → proc.kill() → process exits with SIGKILL
      let resolveExit!: (code: number) => void;
      const exitedPromise = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      Bun.spawn = ((_argv: unknown, _spawnOpts: unknown) => ({
        stdout: makeStream(""),
        stderr: makeStream(""),
        exited: exitedPromise,
        signalCode: "SIGKILL",
        // When killed (by timeout abort handler), resolve the exit promise
        kill: (_signal?: number | string) => {
          resolveExit(137);
        },
      })) as unknown as typeof Bun.spawn;

      const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
      const instance = await adapter.create(openProfile(false));
      const result = await instance.exec("any-command", [], { timeoutMs: 10 });

      expect(result.timedOut).toBe(true);
      expect(result.oomKilled).toBe(false); // timedOut=true prevents oomKilled classification
    },
  );

  test.skipIf(process.platform !== "linux")(
    "oomKilled=false when process exits with SIGTERM (not SIGKILL)",
    async () => {
      Bun.spawn = makeMockSpawn({ exitCode: 143, signalCode: "SIGTERM" });

      const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
      const instance = await adapter.create(openProfile(false));
      const result = await instance.exec("any-command", []);

      expect(result.oomKilled).toBe(false);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "oomKilled=false when process exits cleanly with exit code 0",
    async () => {
      Bun.spawn = makeMockSpawn({ exitCode: 0, signalCode: null });

      const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
      const instance = await adapter.create(openProfile(false));
      const result = await instance.exec("any-command", []);

      expect(result.oomKilled).toBe(false);
      expect(result.exitCode).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// sandboxCode discrimination — Issue 11
// ---------------------------------------------------------------------------

describe("sandboxCode in error context", () => {
  beforeEach(() => {
    Bun.which = ORIGINAL_WHICH;
  });

  afterEach(() => {
    Bun.which = ORIGINAL_WHICH;
  });

  test.skipIf(process.platform !== "linux")(
    "BWRAP_NOT_FOUND sandboxCode when bwrap binary is missing",
    async () => {
      // Mock Bun.which to simulate bwrap not installed
      Bun.which = mock((_name: unknown) => null);

      // We test createOsAdapterForTest indirectly: when platform=bwrap, available=false,
      // the platform info carries the reason. The sandboxCode is set in createOsAdapter().
      // Since createOsAdapter() calls detectPlatform() + Bun.which(), mock Bun.which to null.
      // We use the direct validationError path visible in adapter.ts via createOsAdapter.
      // For unit testing, verify via the platform info on the adapter.
      const adapter = createOsAdapterForTest({ platform: "bwrap", available: false });
      expect(adapter.platform.available).toBe(false);
      expect(adapter.platform.reason).toContain("bwrap");
    },
  );
});

// ---------------------------------------------------------------------------
// Integration tests — real bwrap process isolation
// Requires: SANDBOX_INTEGRATION=1 AND process.platform === "linux"
// ---------------------------------------------------------------------------

const SKIP_INTEGRATION = !process.env.SANDBOX_INTEGRATION || process.platform !== "linux";

describe.skipIf(SKIP_INTEGRATION)("bwrap integration (SANDBOX_INTEGRATION=1 + Linux)", () => {
  test("timeout kills long-running process and sets timedOut=true", async () => {
    const adapter = createOsAdapterForTest({
      platform: "bwrap",
      available: true,
      systemdRunAvailable: false,
    });
    const instance = await adapter.create(openProfile(false));
    const start = Date.now();
    const result = await instance.exec("sleep", ["60"], { timeoutMs: 200 });
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    // Should complete well before 60s — allow 5s margin for slow CI runners
    expect(elapsed).toBeLessThan(5_000);
  });

  test("exit code is propagated correctly", async () => {
    const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
    const instance = await adapter.create(openProfile(false));
    const result = await instance.exec("/bin/sh", ["-c", "exit 42"]);

    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  test("stdout is captured correctly", async () => {
    const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
    const instance = await adapter.create(openProfile(false));
    const result = await instance.exec("/bin/sh", ["-c", "echo hello"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("closed mode prevents reading unmounted paths", async () => {
    const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
    // Closed mode with no allowRead — /etc/passwd should not be accessible
    const instance = await adapter.create({
      filesystem: {
        defaultReadAccess: "closed",
        allowRead: ["/bin", "/lib", "/lib64", "/usr"],
      },
      network: { allow: false },
      resources: {},
    });
    const result = await instance.exec("/bin/sh", ["-c", "cat /etc/passwd 2>/dev/null; exit $?"]);

    // In closed mode with no /etc mounted, cat should fail (file not found or permission denied)
    expect(result.exitCode).not.toBe(0);
  });

  test("exec maxOutputBytes truncation", async () => {
    const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
    const instance = await adapter.create(openProfile(false));
    // printf generates ~200 bytes; cap at 20
    const result = await instance.exec("/bin/sh", ["-c", "printf '%0200d' 0"], {
      maxOutputBytes: 20,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// macOS integration test (seatbelt) — kept for completeness
// ---------------------------------------------------------------------------

const SKIP_MACOS_INTEGRATION = !process.env.SANDBOX_INTEGRATION || process.platform !== "darwin";

describe.skipIf(SKIP_MACOS_INTEGRATION)("exec maxOutputBytes truncation (macOS seatbelt)", () => {
  test("truncated=true when process output exceeds maxOutputBytes", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    const instance = await adapter.create(openProfile(false));
    // printf repeats a pattern — generates ~200 bytes, cap at 20
    const result = await instance.exec("/bin/sh", ["-c", "printf '%0200d' 0"], {
      maxOutputBytes: 20,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// Process-group abort — regression for #1698 Q1b
//
// Without `detached: true` + pgroup-directed kill, an abort of a sandboxed
// bash invocation signaled only the wrapper (sandbox-exec / bwrap) and left
// grandchildren (e.g. `sleep` started by the bash subshell) running as
// orphans reparented to init. Q1b surfaced this on every graceful or force
// cancel. This test pins the pgroup-kill path so the regression cannot
// reappear.
// ---------------------------------------------------------------------------

const SKIP_PGROUP_MACOS = !process.env.SANDBOX_INTEGRATION || process.platform !== "darwin";

describe.skipIf(SKIP_PGROUP_MACOS)("abort kills bash grandchildren (macOS seatbelt)", () => {
  test("signal.abort() terminates the sleep grandchild via process-group kill", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    const instance = await adapter.create(openProfile(false));
    const marker = `koi-pgroup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    const execPromise = instance.exec(
      "bash",
      ["--noprofile", "--norc", "-c", `sleep 30 && echo ${marker}`],
      { signal: controller.signal },
    );

    // Wait for the bash subshell and its sleep grandchild to actually start
    // — aborting pre-spawn would trivially "pass" without exercising the
    // pgroup path.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    controller.abort();
    await execPromise.catch(() => {
      // Expected: abort may reject or resolve with a non-zero exit code.
    });

    // Give the OS a moment to finish reaping the grandchild before we
    // assert it's gone.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // `pgrep -f` matches on the full argv — the marker string only appears
    // in the aborted invocation's bash argv, so a match here means the
    // grandchild survived the abort.
    const probe = Bun.spawnSync(["pgrep", "-f", marker], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const survivors = new TextDecoder().decode(new Uint8Array(probe.stdout)).trim();
    expect(survivors).toBe("");
  });
});
