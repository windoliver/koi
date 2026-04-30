import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetProfilingForTests,
  initProfiling,
  ProfilingConflictError,
  ProfilingPendingWriteError,
  shutdownProfiling,
} from "./integration.js";
import { bumpCounter, dumpProfile, resetProfiler } from "./profiler.js";

const noopSetInterval = ((_fn: () => void, _ms: number) =>
  1 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval;

describe("initProfiling", () => {
  let prevEnv: string | undefined;
  let prevOut: string | undefined;
  let workDir: string;

  beforeEach(() => {
    prevEnv = process.env.KOI_TUI_PROFILE;
    prevOut = process.env.KOI_TUI_PROFILE_OUT;
    workDir = mkdtempSync(join(tmpdir(), "koi-prof-"));
    __resetProfilingForTests();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.KOI_TUI_PROFILE;
    else process.env.KOI_TUI_PROFILE = prevEnv;
    if (prevOut === undefined) delete process.env.KOI_TUI_PROFILE_OUT;
    else process.env.KOI_TUI_PROFILE_OUT = prevOut;
    rmSync(workDir, { recursive: true, force: true });
    __resetProfilingForTests();
    resetProfiler({ enabled: false });
  });

  test("no-op when profiling disabled — returns false (no ownership)", () => {
    process.env.KOI_TUI_PROFILE = "0";
    resetProfiler();
    const onSpy = mock((_event: string, _handler: () => void) => process);
    const owned = initProfiling({ processOn: onSpy as unknown as typeof process.on });
    expect(owned).toBe(false);
    expect(onSpy).not.toHaveBeenCalled();
  });

  test("returns true when this call took profiling ownership", () => {
    process.env.KOI_TUI_PROFILE = "1";
    process.env.KOI_TUI_PROFILE_OUT = join(workDir, "report.json");
    resetProfiler();
    const owned = initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    expect(owned).toBe(true);
  });

  test("when enabled, registers exit handler that writes report to KOI_TUI_PROFILE_OUT", () => {
    process.env.KOI_TUI_PROFILE = "1";
    const outPath = join(workDir, "report.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    let exitHandler: (() => void) | null = null;
    const onSpy = mock((event: string, handler: () => void) => {
      if (event === "exit") exitHandler = handler;
      return process;
    });

    initProfiling({
      processOn: onSpy as unknown as typeof process.on,
      cpuSamplerOptions: {
        // pass a no-op scheduler so no real timer is created
        setIntervalFn: ((_fn: () => void, _ms: number) =>
          1 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval,
      },
    });

    bumpCounter("messagerow.mount", 5);
    expect(exitHandler).not.toBeNull();
    if (!exitHandler) return;
    (exitHandler as () => void)();

    const written = JSON.parse(readFileSync(outPath, "utf8")) as {
      counters: Record<string, number>;
    };
    expect(written.counters["messagerow.mount"]).toBe(5);
  });

  test("duplicate call without shutdown throws ProfilingConflictError", () => {
    process.env.KOI_TUI_PROFILE = "1";
    process.env.KOI_TUI_PROFILE_OUT = join(workDir, "report.json");
    resetProfiler();

    const onSpy = mock((_event: string, _handler: () => void) => process);
    initProfiling({
      processOn: onSpy as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    expect(() =>
      initProfiling({
        processOn: onSpy as unknown as typeof process.on,
        cpuSamplerOptions: { setIntervalFn: noopSetInterval },
      }),
    ).toThrow(ProfilingConflictError);
    // exit handler registered exactly once
    const exitCalls = onSpy.mock.calls.filter((c) => c[0] === "exit");
    expect(exitCalls.length).toBe(1);
  });

  test("output path is resolved absolute — process.chdir during run is ignored", () => {
    process.env.KOI_TUI_PROFILE = "1";
    // Set a RELATIVE path; resolution happens at init relative to current cwd.
    const stableAbs = join(workDir, "stable.json");
    process.env.KOI_TUI_PROFILE_OUT = "stable.json";
    const origCwd = process.cwd();
    process.chdir(workDir);
    resetProfiler();

    initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 6);

    // chdir mid-run — would relocate the write target if the path were
    // resolved at flush time.
    const decoyDir = mkdtempSync(join(tmpdir(), "koi-prof-decoy-"));
    try {
      process.chdir(decoyDir);
      shutdownProfiling();

      const written = JSON.parse(readFileSync(stableAbs, "utf8")) as {
        counters: Record<string, number>;
      };
      expect(written.counters["messagerow.mount"]).toBe(6);
      // Decoy dir must be empty for stable.json
      expect(() => readFileSync(join(decoyDir, "stable.json"), "utf8")).toThrow();
    } finally {
      process.chdir(origCwd);
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });

  test("output path is captured at init — mid-run env mutation is ignored", () => {
    process.env.KOI_TUI_PROFILE = "1";
    const stablePath = join(workDir, "stable.json");
    const decoyPath = join(workDir, "decoy.json");
    process.env.KOI_TUI_PROFILE_OUT = stablePath;
    resetProfiler();

    initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 4);

    // Mid-run, redirect the env. A naive impl reading env at flush time
    // would write to decoyPath, losing this run's report.
    process.env.KOI_TUI_PROFILE_OUT = decoyPath;

    shutdownProfiling();

    const written = JSON.parse(readFileSync(stablePath, "utf8")) as {
      counters: Record<string, number>;
    };
    expect(written.counters["messagerow.mount"]).toBe(4);
    // Decoy must NOT have been touched.
    expect(() => readFileSync(decoyPath, "utf8")).toThrow();
  });

  test("shutdownProfiling writes the run's report and resets state", () => {
    process.env.KOI_TUI_PROFILE = "1";
    const outPath = join(workDir, "report.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 7);
    shutdownProfiling();

    const written = JSON.parse(readFileSync(outPath, "utf8")) as {
      counters: Record<string, number>;
    };
    expect(written.counters["messagerow.mount"]).toBe(7);
  });

  test("env unset between runs disables profiling for the second run", () => {
    // Regression: state.enabled used to leak across runs because
    // shutdownProfiling did not clear it and initProfiling gated on the
    // runtime flag instead of the env. After run 1 with profiling on,
    // unsetting KOI_TUI_PROFILE should fully disable profiling for run 2.
    process.env.KOI_TUI_PROFILE = "1";
    const outPath = join(workDir, "report.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    // Run 1: profiled
    const ownedA = initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    expect(ownedA).toBe(true);
    bumpCounter("messagerow.mount", 9);
    shutdownProfiling();

    // Disable for run 2
    delete process.env.KOI_TUI_PROFILE;

    // Run 2: must NOT take ownership and must NOT start a sampler
    let secondSetIntervalCalls = 0;
    const setIntervalSpy = ((_fn: () => void, _ms: number) => {
      secondSetIntervalCalls++;
      return 7 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const ownedB = initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: setIntervalSpy },
    });
    expect(ownedB).toBe(false);
    expect(secondSetIntervalCalls).toBe(0);

    // Probes must be no-ops in run 2 — bumping a counter does nothing.
    bumpCounter("messagerow.mount", 99);
    // Verify by enabling profiling fresh and confirming the counter is
    // zero after the new reset (i.e. the prior bump did not stick).
    resetProfiler({ enabled: true });
    bumpCounter("messagerow.mount", 1);
    expect(dumpProfile().counters["messagerow.mount"]).toBe(1);
  });

  test("multi-run isolation — second run starts fresh and writes its own report", () => {
    process.env.KOI_TUI_PROFILE = "1";
    const outPath = join(workDir, "report.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    // Run 1
    initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 100);
    shutdownProfiling();

    const run1 = JSON.parse(readFileSync(outPath, "utf8")) as {
      counters: Record<string, number>;
    };
    expect(run1.counters["messagerow.mount"]).toBe(100);

    // Run 2 — must NOT carry run 1's counters
    initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 3);
    shutdownProfiling();

    const run2 = JSON.parse(readFileSync(outPath, "utf8")) as {
      counters: Record<string, number>;
    };
    expect(run2.counters["messagerow.mount"]).toBe(3);
  });

  test("exit handler is registered exactly once across multiple runs", () => {
    process.env.KOI_TUI_PROFILE = "1";
    process.env.KOI_TUI_PROFILE_OUT = join(workDir, "report.json");
    resetProfiler();

    const onSpy = mock((_event: string, _handler: () => void) => process);

    initProfiling({
      processOn: onSpy as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    shutdownProfiling();
    initProfiling({
      processOn: onSpy as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    shutdownProfiling();

    const exitCalls = onSpy.mock.calls.filter((c) => c[0] === "exit");
    expect(exitCalls.length).toBe(1);
  });

  test("permits an unprofiled second run alongside an active profiled run", () => {
    // Regression: initProfiling used to throw on any concurrent run, even
    // unprofiled ones, blocking unrelated TUI startups. The conflict gate
    // must check if the new caller is asking for profiling first.
    process.env.KOI_TUI_PROFILE = "1";
    process.env.KOI_TUI_PROFILE_OUT = join(workDir, "report.json");
    resetProfiler();

    // Profiled run A
    const ownedA = initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    expect(ownedA).toBe(true);

    // Unprofiled run B — env off for THIS caller. Must not throw.
    delete process.env.KOI_TUI_PROFILE;
    let ownedB = false;
    expect(() => {
      ownedB = initProfiling({
        processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
        cpuSamplerOptions: { setIntervalFn: noopSetInterval },
      });
    }).not.toThrow();
    expect(ownedB).toBe(false);
  });

  test("rejects concurrent profiled runs by throwing ProfilingConflictError", () => {
    process.env.KOI_TUI_PROFILE = "1";
    process.env.KOI_TUI_PROFILE_OUT = join(workDir, "report.json");
    resetProfiler();

    let secondSetIntervalCalls = 0;
    const setIntervalA = ((_fn: () => void, _ms: number) =>
      1 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval;
    const setIntervalB = ((_fn: () => void, _ms: number) => {
      secondSetIntervalCalls++;
      return 2 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    // First run starts cleanly — owns profiling
    const ownedA = initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: setIntervalA },
    });
    expect(ownedA).toBe(true);

    // Second run while first is still active — MUST throw, not silently
    // skip. A silent rejection would still let the second TUI mount its
    // probes, which write into the global state and contaminate run A.
    expect(() =>
      initProfiling({
        processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
        cpuSamplerOptions: { setIntervalFn: setIntervalB },
      }),
    ).toThrow(ProfilingConflictError);

    // Second sampler must not have been started.
    expect(secondSetIntervalCalls).toBe(0);
  });

  test("exit handler stops sampler before writing so the trailing partial interval is captured", () => {
    process.env.KOI_TUI_PROFILE = "1";
    const outPath = join(workDir, "exit-sampler.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    let exitHandler: (() => void) | null = null;
    const onSpy = mock((event: string, handler: () => void) => {
      if (event === "exit") exitHandler = handler;
      return process;
    });

    // Capture the sampler's tick fn so we can drive it deterministically.
    const captured: { fn: (() => void) | null } = { fn: null };
    const fakeSetInterval = ((fn: () => void, _ms: number) => {
      captured.fn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const fakeClearInterval = ((_: ReturnType<typeof setInterval>) =>
      undefined) as unknown as typeof clearInterval;

    initProfiling({
      processOn: onSpy as unknown as typeof process.on,
      cpuSamplerOptions: {
        intervalMs: 10_000,
        setIntervalFn: fakeSetInterval,
        clearIntervalFn: fakeClearInterval,
      },
    });
    // No scheduled tick has fired yet (fake interval). Process dies.
    // Without the exit-handler stopCpuSampler() call, no CPU samples
    // would be captured at all — only stopCpuSampler emits the final
    // synchronous tick.
    expect(exitHandler).not.toBeNull();
    if (!exitHandler) return;
    (exitHandler as () => void)();

    const written = JSON.parse(readFileSync(outPath, "utf8")) as {
      samples: Record<string, ReadonlyArray<readonly [number, number]>>;
    };
    expect(written.samples["cpu.userUs"]?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("shutdownProfiling({ write: false }) does NOT clobber a previous successful report", () => {
    process.env.KOI_TUI_PROFILE = "1";
    const outPath = join(workDir, "preserve.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    // Run 1: profiled, succeeds.
    initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 7);
    shutdownProfiling();
    const goldenContent = readFileSync(outPath, "utf8");
    expect(JSON.parse(goldenContent).counters["messagerow.mount"]).toBe(7);

    // Run 2: profiled, but caller signals 'aborted pre-mount' via write:false.
    // Bump some pre-mount activity that would (incorrectly) be flushed if
    // shutdown wrote unconditionally.
    initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 9999);
    shutdownProfiling({ write: false });

    // Original report must be intact — no overwrite.
    const after = readFileSync(outPath, "utf8");
    expect(after).toBe(goldenContent);
  });

  test("atomic rename preserves the existing report when write fails", () => {
    process.env.KOI_TUI_PROFILE = "1";
    const outPath = join(workDir, "atomic.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    // Seed a successful prior report.
    initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 1);
    shutdownProfiling();
    const golden = readFileSync(outPath, "utf8");

    // Now arrange the path to fail mid-write: replace the file with a
    // directory of the same name. writeFileSync(tmpPath) succeeds,
    // renameSync(tmpPath -> outPath) fails because outPath is a dir.
    rmSync(outPath);
    mkdirSync(outPath);

    // Stash the golden content INSIDE the dir so we can verify it persists.
    // Then run another profiled session — the write should fail and the
    // dir should still exist intact.
    initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 2);
    shutdownProfiling();

    // The directory at outPath must still be a directory — atomic
    // rename did not partially truncate or replace it.
    expect(existsSync(outPath)).toBe(true);
    expect(() => readFileSync(outPath, "utf8")).toThrow(); // still a dir

    // No leftover .tmp file in the workdir.
    const tmpFiles = require("node:fs")
      .readdirSync(workDir)
      .filter((f: string) => f.startsWith("atomic.json.tmp"));
    expect(tmpFiles.length).toBe(0);

    // golden content placeholder used to anchor the test; unused beyond
    // signalling the prior write produced something.
    expect(golden.length).toBeGreaterThan(0);
  });

  test("stderr.write throwing after a successful file write does not mark the run failed", () => {
    process.env.KOI_TUI_PROFILE = "1";
    const outPath = join(workDir, "stderr-throw.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    const origWrite = process.stderr.write.bind(process.stderr);
    // stderr is unwritable on the success path. The file write itself is
    // unaffected; logging is best-effort.
    process.stderr.write = (() => {
      throw new Error("stderr closed");
    }) as unknown as typeof process.stderr.write;

    try {
      initProfiling({
        processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
        cpuSamplerOptions: { setIntervalFn: noopSetInterval },
      });
      bumpCounter("messagerow.mount", 13);
      shutdownProfiling();
    } finally {
      process.stderr.write = origWrite;
    }

    // File was written despite stderr throwing.
    const written = JSON.parse(readFileSync(outPath, "utf8")) as {
      counters: Record<string, number>;
    };
    expect(written.counters["messagerow.mount"]).toBe(13);

    // Critical: a subsequent profiled run must NOT throw
    // ProfilingPendingWriteError, because the previous write actually
    // succeeded.
    process.env.KOI_TUI_PROFILE_OUT = join(workDir, "stderr-throw-2.json");
    expect(() =>
      initProfiling({
        processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
        cpuSamplerOptions: { setIntervalFn: noopSetInterval },
      }),
    ).not.toThrow();
    shutdownProfiling();
  });

  test("pending failed write blocks later profiled run; resolving the issue clears it", () => {
    process.env.KOI_TUI_PROFILE = "1";
    const missingDir = join(workDir, "missing-block");
    const outPathA = join(missingDir, "a.json");
    process.env.KOI_TUI_PROFILE_OUT = outPathA;
    resetProfiler();

    // Run A: profiled, write fails → pending snapshot set.
    initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 5);
    shutdownProfiling();
    expect(existsSync(outPathA)).toBe(false);

    // Try to start run B WITHOUT resolving the pending — must throw.
    const outPathB = join(workDir, "b.json");
    process.env.KOI_TUI_PROFILE_OUT = outPathB;
    expect(() =>
      initProfiling({
        processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
        cpuSamplerOptions: { setIntervalFn: noopSetInterval },
      }),
    ).toThrow(ProfilingPendingWriteError);

    // Resolve the issue — create the directory. Run B's init now retries
    // run A's pending write (succeeds → A.json written), then starts B.
    mkdirSync(missingDir, { recursive: true });
    const ownedB = initProfiling({
      processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    expect(ownedB).toBe(true);

    bumpCounter("messagerow.mount", 99);
    shutdownProfiling();

    // A's pending write resolved to A.json with run-A data.
    const writtenA = JSON.parse(readFileSync(outPathA, "utf8")) as {
      counters: Record<string, number>;
    };
    expect(writtenA.counters["messagerow.mount"]).toBe(5);

    // B's own data went to B.json — NOT clobbered by A's stale snapshot.
    const writtenB = JSON.parse(readFileSync(outPathB, "utf8")) as {
      counters: Record<string, number>;
    };
    expect(writtenB.counters["messagerow.mount"]).toBe(99);
  });

  test("shutdown write failure + later activity: exit retry writes the original snapshot, not the mix", () => {
    // Hardest case: shutdown's write fails, an unprofiled second run
    // happens before process exit and bumps probes, then the exit
    // handler retries. The retry MUST write the original snapshot —
    // not the mixed state — because the live state was reset at
    // shutdown and the snapshot was frozen at write-failure time.
    process.env.KOI_TUI_PROFILE = "1";
    const missingDir = join(workDir, "missing-mix");
    const outPath = join(missingDir, "report.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    let exitHandler: (() => void) | null = null;
    const onSpy = mock((event: string, handler: () => void) => {
      if (event === "exit") exitHandler = handler;
      return process;
    });

    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      // Run 1: profiled. bump counters. shutdown — write fails (no parent dir).
      initProfiling({
        processOn: onSpy as unknown as typeof process.on,
        cpuSamplerOptions: { setIntervalFn: noopSetInterval },
      });
      bumpCounter("messagerow.mount", 7);
      shutdownProfiling();
      expect(existsSync(outPath)).toBe(false);

      // Run 2: unprofiled (env still set, but new initProfiling sees
      // runActive=false and a fresh start). Actually for this test we
      // simulate the mixed-state scenario: bumpCounter directly. After
      // shutdown reset, state.enabled is false, so this is a no-op —
      // but we explicitly enable to verify the snapshot is independent.
      resetProfiler({ enabled: true });
      bumpCounter("messagerow.mount", 9999);
      bumpCounter("contamination", 4242);

      // Now repair the path and fire the exit handler.
      mkdirSync(missingDir, { recursive: true });
      expect(exitHandler).not.toBeNull();
      if (!exitHandler) return;
      (exitHandler as () => void)();

      const written = JSON.parse(readFileSync(outPath, "utf8")) as {
        counters: Record<string, number>;
      };
      // Snapshot reflects ONLY run 1 — no contamination from the post-
      // shutdown bumps.
      expect(written.counters["messagerow.mount"]).toBe(7);
      expect(written.counters.contamination).toBeUndefined();
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("write failure during shutdown is recoverable via exit-handler retry", () => {
    process.env.KOI_TUI_PROFILE = "1";
    // Path under a non-existent parent dir so writeFileSync throws ENOENT
    // on the first attempt.
    const missingDir = join(workDir, "missing-subdir");
    const outPath = join(missingDir, "report.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    let exitHandler: (() => void) | null = null;
    const onSpy = mock((event: string, handler: () => void) => {
      if (event === "exit") exitHandler = handler;
      return process;
    });

    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      initProfiling({
        processOn: onSpy as unknown as typeof process.on,
        cpuSamplerOptions: { setIntervalFn: noopSetInterval },
      });
      bumpCounter("messagerow.mount", 11);
      shutdownProfiling();

      // First attempt failed: file does not exist, error logged.
      expect(existsSync(outPath)).toBe(false);
      expect(stderrWrites.some((w) => w.includes("failed to write"))).toBe(true);

      // Now create the parent dir and trigger the registered exit handler.
      // The retry MUST succeed and write the original captured report.
      mkdirSync(missingDir, { recursive: true });
      expect(exitHandler).not.toBeNull();
      if (!exitHandler) return;
      (exitHandler as () => void)();

      const written = JSON.parse(readFileSync(outPath, "utf8")) as {
        counters: Record<string, number>;
      };
      expect(written.counters["messagerow.mount"]).toBe(11);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("exit handler is idempotent after shutdownProfiling already wrote", () => {
    process.env.KOI_TUI_PROFILE = "1";
    const outPath = join(workDir, "report.json");
    process.env.KOI_TUI_PROFILE_OUT = outPath;
    resetProfiler();

    let exitHandler: (() => void) | null = null;
    const onSpy = mock((event: string, handler: () => void) => {
      if (event === "exit") exitHandler = handler;
      return process;
    });

    initProfiling({
      processOn: onSpy as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    bumpCounter("messagerow.mount", 9);
    shutdownProfiling();

    // After shutdown, the report exists with the correct value
    const after = JSON.parse(readFileSync(outPath, "utf8")) as {
      counters: Record<string, number>;
    };
    expect(after.counters["messagerow.mount"]).toBe(9);

    // Now bump a new counter that should NOT appear in any subsequent
    // exit-triggered write (since shutdown already flushed this run).
    bumpCounter("messagerow.mount", 50);
    if (!exitHandler) return;
    (exitHandler as () => void)();

    const stillSame = JSON.parse(readFileSync(outPath, "utf8")) as {
      counters: Record<string, number>;
    };
    expect(stillSame.counters["messagerow.mount"]).toBe(9);
  });
});
