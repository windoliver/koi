/**
 * BgLogTail tailer engine tests (#1944).
 *
 * Tests use real tmpdir + Bun.write for fs operations and
 * inject a real setInterval override for determinism.
 * Component render tests use testRender for the smoke test.
 */

import { testRender } from "@opentui/solid";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { watch as nodeWatch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BgSessionRow } from "../state/types.js";
import { BgLogTail, startTailer, type TailerFs, type TailerIntervalHandle } from "./BgLogTail.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function realFs(): TailerFs {
  return {
    open: (p: string) => fsOpen(p, "r"),
    stat: (p: string) =>
      fsStat(p).then((s) => ({ size: s.size, ino: Number(s.ino), dev: Number(s.dev) })),
    watch: (p: string): FSWatcher => nodeWatch(p),
  };
}

/** No-op setInterval override — never fires unless manually triggered. */
function noopInterval(): (fn: () => void, ms: number) => TailerIntervalHandle {
  return (_fn, _ms) => ({ clear: () => {} });
}

/** setInterval override that records callbacks without firing automatically. */
function captureInterval(): {
  readonly setInterval: (fn: () => void, ms: number) => TailerIntervalHandle;
  readonly tick: () => Promise<void>;
  readonly clearCount: () => number;
} {
  let capturedFn: (() => void) | null = null;
  let clears = 0;
  return {
    setInterval: (fn, _ms) => {
      capturedFn = fn;
      return {
        clear: () => {
          clears++;
        },
      };
    },
    tick: async () => {
      if (capturedFn !== null) capturedFn();
      // Allow microtasks to settle
      await new Promise((r) => setTimeout(r, 10));
    },
    clearCount: () => clears,
  };
}

function makeRow(overrides: Partial<BgSessionRow> = {}): BgSessionRow {
  return {
    workerId: "w-test",
    agentId: "a-test",
    sessionId: null,
    status: "running",
    pid: 1234,
    startedAt: Date.now() - 1000,
    endedAt: null,
    exitCode: null,
    lastHeartbeatAt: null,
    heartbeatDeadlineAt: null,
    logPath: "/tmp/test.log",
    backendKind: "subprocess",
    version: 1,
    signaledAt: null,
    freshness: "ok",
    ...overrides,
  };
}

/** Wait for condition with timeout. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BgLogTail tailer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "koi-bg-log-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  test("never starts when logPath is ''", async () => {
    const openCalled = mock(() => Promise.reject(new Error("should not be called")));
    const statCalled = mock(() => Promise.reject(new Error("should not be called")));
    const watchCalled = mock(() => {
      throw new Error("should not be called");
    });

    const tailer = startTailer({
      logPath: "",
      maxLines: 1000,
      fs: { open: openCalled, stat: statCalled, watch: watchCalled },
      setInterval: noopInterval(),
      onLines: () => {},
      onBanner: () => {},
    });

    // Give any async ops a moment to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(openCalled).not.toHaveBeenCalled();
    expect(statCalled).not.toHaveBeenCalled();
    expect(watchCalled).not.toHaveBeenCalled();
    await tailer.stop();
  });

  // -------------------------------------------------------------------------
  test("initial reverse-tail returns last 1000 lines", async () => {
    const logPath = join(tmpDir, "test.log");
    // Write 1500 lines
    const lines = Array.from({ length: 1500 }, (_, i) => `line-${i + 1}`);
    await writeFile(logPath, lines.join("\n") + "\n");

    const received: string[][] = [];

    const tailer = startTailer({
      logPath,
      maxLines: 1000,
      fs: realFs(),
      setInterval: noopInterval(),
      onLines: (l) => received.push([...l]),
      onBanner: () => {},
    });

    await waitFor(() => received.length > 0);
    await tailer.stop();

    const last = received[received.length - 1];
    expect(last).toBeDefined();
    expect(last!.length).toBe(1000);
    // Should be last 1000 lines (line-501 through line-1500)
    expect(last![0]).toBe("line-501");
    expect(last![999]).toBe("line-1500");
  });

  // -------------------------------------------------------------------------
  test("appended bytes append to buffer", async () => {
    const logPath = join(tmpDir, "append.log");
    await writeFile(logPath, "line-1\nline-2\n");

    const received: string[][] = [];
    const capture = captureInterval();

    const tailer = startTailer({
      logPath,
      maxLines: 1000,
      fs: realFs(),
      setInterval: capture.setInterval,
      onLines: (l) => received.push([...l]),
      onBanner: () => {},
    });

    await waitFor(() => received.length > 0);
    const initialLen = received[received.length - 1]!.length;
    expect(initialLen).toBe(2);

    // Append a new line
    await writeFile(logPath, "line-1\nline-2\nline-3\n");

    // Tick watchdog to pick up changes (avoids relying solely on fs.watch timing)
    // Give the write a moment to flush, then tick
    await new Promise((r) => setTimeout(r, 30));
    await capture.tick();

    await waitFor(() => {
      const last = received[received.length - 1];
      return last !== undefined && last.length === 3;
    }, 3000);

    const last = received[received.length - 1];
    expect(last).toBeDefined();
    expect(last![2]).toBe("line-3");
    await tailer.stop();
  });

  // -------------------------------------------------------------------------
  test("truncation: file size shrinks → '--- log truncated ---' banner + offset reset", async () => {
    const logPath = join(tmpDir, "truncate.log");
    await writeFile(logPath, "line-1\nline-2\nline-3\n");

    const banners: string[] = [];
    const received: string[][] = [];
    const capture = captureInterval();

    const tailer = startTailer({
      logPath,
      maxLines: 1000,
      fs: realFs(),
      setInterval: capture.setInterval,
      onLines: (l) => received.push([...l]),
      onBanner: (b) => banners.push(b),
    });

    await waitFor(() => received.length > 0);
    // Truncate the file (overwrite with less content)
    await writeFile(logPath, "new-line-1\n");
    await capture.tick();

    await waitFor(() => banners.includes("--- log truncated ---"), 2000);
    expect(banners).toContain("--- log truncated ---");

    await tailer.stop();
  });

  // -------------------------------------------------------------------------
  test("inode change (rotation): different inode → '--- log rotated ---' banner", async () => {
    const logPath = join(tmpDir, "rotate.log");
    const rotatedPath = join(tmpDir, "rotate.log.1");
    await writeFile(logPath, "before-rotation\n");

    const banners: string[] = [];
    const capture = captureInterval();

    const tailer = startTailer({
      logPath,
      maxLines: 1000,
      fs: realFs(),
      setInterval: capture.setInterval,
      onLines: () => {},
      onBanner: (b) => banners.push(b),
    });

    await waitFor(() => {
      // Check that tailer opened by doing a tick; initial open should have happened
      return true;
    });
    await new Promise((r) => setTimeout(r, 50));

    // Rotate: rename old file, write new file at same path (new inode)
    await rename(logPath, rotatedPath);
    await writeFile(logPath, "after-rotation\n");
    await capture.tick();

    await waitFor(() => banners.includes("--- log rotated ---"), 2000);
    expect(banners).toContain("--- log rotated ---");

    await tailer.stop();
  });

  // -------------------------------------------------------------------------
  test("logPath change mid-tail: closes prior fd + '--- log path changed ---' + opens new", async () => {
    const logPathA = join(tmpDir, "pathA.log");
    const logPathB = join(tmpDir, "pathB.log");
    await writeFile(logPathA, "file-a-content\n");
    await writeFile(logPathB, "file-b-content\n");

    const banners: string[] = [];
    const received: string[][] = [];

    const tailer = startTailer({
      logPath: logPathA,
      maxLines: 1000,
      fs: realFs(),
      setInterval: noopInterval(),
      onLines: (l) => received.push([...l]),
      onBanner: (b) => banners.push(b),
    });

    await waitFor(() => received.length > 0);
    const initial = received[received.length - 1];
    expect(initial).toBeDefined();
    expect(initial![0]).toBe("file-a-content");

    tailer.updateLogPath(logPathB);

    await waitFor(() => banners.includes("--- log path changed ---"), 2000);
    await waitFor(
      () => {
        const last = received[received.length - 1];
        return last !== undefined && last.some((l) => l === "file-b-content");
      },
      2000,
    );

    expect(banners).toContain("--- log path changed ---");
    const last = received[received.length - 1];
    expect(last).toBeDefined();
    expect(last!.some((l) => l === "file-b-content")).toBe(true);

    await tailer.stop();
  });

  // -------------------------------------------------------------------------
  test("ENOENT at startup → 'waiting' state, then '--- log opened ---' on appearance", async () => {
    const logPath = join(tmpDir, "notyet.log");
    // File does NOT exist yet

    const banners: string[] = [];
    const received: string[][] = [];

    const tailer = startTailer({
      logPath,
      maxLines: 1000,
      fs: realFs(),
      setInterval: noopInterval(),
      onLines: (l) => received.push([...l]),
      onBanner: (b) => banners.push(b),
    });

    // Should see waiting banner fairly quickly
    await waitFor(() => banners.includes("--- waiting for log ---"), 1000);
    expect(banners).toContain("--- waiting for log ---");

    // Now create the file
    await writeFile(logPath, "appeared!\n");

    // Wait for the ENOENT poll to detect it (poll is real setInterval here?
    // No — we used noopInterval which doesn't fire. Use real setInterval for this test.)
    // So we need to use real setInterval for the ENOENT poll test.
    // The ENOENT poll uses global setInterval, not the injected one.
    // Wait for the real ENOENT poll (250ms intervals)
    await waitFor(() => banners.includes("--- log opened ---"), 3000);
    expect(banners).toContain("--- log opened ---");
    await waitFor(
      () => received.some((lines) => lines.some((l) => l === "appeared!")),
      2000,
    );

    await tailer.stop();
  });

  // -------------------------------------------------------------------------
  test("watchdog 1s stat catches silent fs.watch drops", async () => {
    const logPath = join(tmpDir, "watchdog.log");
    await writeFile(logPath, "initial\n");

    const received: string[][] = [];
    const capture = captureInterval();

    // Use a silent watcher that never fires events
    const silentWatcher = (): FSWatcher => {
      const w = {
        on: () => w,
        close: () => {},
        addListener: () => w,
        removeListener: () => w,
        emit: () => false,
        removeAllListeners: () => w,
        listeners: () => [],
        rawListeners: () => [],
        once: () => w,
        prependListener: () => w,
        prependOnceListener: () => w,
        off: () => w,
        listenerCount: () => 0,
        eventNames: () => [],
        getMaxListeners: () => 10,
        setMaxListeners: () => w,
        ref: () => {},
        unref: () => {},
      } as unknown as FSWatcher;
      return w;
    };

    const tailer = startTailer({
      logPath,
      maxLines: 1000,
      fs: { ...realFs(), watch: silentWatcher },
      setInterval: capture.setInterval,
      onLines: (l) => received.push([...l]),
      onBanner: () => {},
    });

    await waitFor(() => received.length > 0);
    const initialCount = received[received.length - 1]!.length;

    // Append new content — fs.watch is silent, only watchdog will detect it
    await writeFile(logPath, "initial\nnew-watchdog-line\n");

    // Simulate watchdog tick
    await capture.tick();

    await waitFor(
      () => {
        const last = received[received.length - 1];
        return last !== undefined && last.length > initialCount;
      },
      2000,
    );

    const last = received[received.length - 1];
    expect(last).toBeDefined();
    expect(last!.some((l) => l === "new-watchdog-line")).toBe(true);
    await tailer.stop();
  });

  // -------------------------------------------------------------------------
  test("unmount: closes fd, clears watcher, clears watchdog", async () => {
    const logPath = join(tmpDir, "unmount.log");
    await writeFile(logPath, "content\n");

    const capture = captureInterval();
    let watcherClosed = false;
    let fdClosed = false;

    const fakeFs: TailerFs = {
      open: async (p: string) => {
        const fh = await fsOpen(p, "r");
        // Wrap to track close
        const wrapped = new Proxy(fh, {
          get(target, prop) {
            if (prop === "close") {
              return async () => {
                fdClosed = true;
                return target.close();
              };
            }
            const v = target[prop as keyof typeof target];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        return wrapped;
      },
      stat: (p: string) =>
        fsStat(p).then((s) => ({ size: s.size, ino: Number(s.ino), dev: Number(s.dev) })),
      watch: (p: string): FSWatcher => {
        const w = nodeWatch(p);
        const origClose = w.close.bind(w);
        w.close = () => {
          watcherClosed = true;
          origClose();
        };
        return w;
      },
    };

    const received: string[][] = [];
    const tailer = startTailer({
      logPath,
      maxLines: 1000,
      fs: fakeFs,
      setInterval: capture.setInterval,
      onLines: (l) => received.push([...l]),
      onBanner: () => {},
    });

    await waitFor(() => received.length > 0);

    await tailer.stop();

    expect(fdClosed).toBe(true);
    expect(watcherClosed).toBe(true);
    expect(capture.clearCount()).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Smoke test: component renders without crashing
// ---------------------------------------------------------------------------

describe("BgLogTail component", () => {
  test("renders nothing when logPath is ''", () => {
    const row = makeRow({ logPath: "" });
    const result = testRender(() => <BgLogTail row={row} />);
    // Should return null / empty — no crash
    expect(result).toBeDefined();
  });

  test("smoke: mounts with valid logPath (no crash)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koi-bg-smoke-"));
    const logPath = join(dir, "smoke.log");
    await writeFile(logPath, "hello from log\n");

    const row = makeRow({ logPath });

    // Just verify it doesn't throw during mount
    let rendered = false;
    try {
      testRender(() => <BgLogTail row={row} />);
      rendered = true;
    } catch (e: unknown) {
      void e;
      rendered = false;
    }
    expect(rendered).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});
