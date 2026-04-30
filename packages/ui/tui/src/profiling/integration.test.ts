import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetProfilingForTests,
  initProfiling,
  ProfilingConflictError,
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
