import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetProfilingForTests, initProfiling, shutdownProfiling } from "./integration.js";
import { bumpCounter, resetProfiler } from "./profiler.js";

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

  test("ignores duplicate calls", () => {
    process.env.KOI_TUI_PROFILE = "1";
    process.env.KOI_TUI_PROFILE_OUT = join(workDir, "report.json");
    resetProfiler();

    const onSpy = mock((_event: string, _handler: () => void) => process);
    initProfiling({
      processOn: onSpy as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    initProfiling({
      processOn: onSpy as unknown as typeof process.on,
      cpuSamplerOptions: { setIntervalFn: noopSetInterval },
    });
    // exit handler registered exactly once
    const exitCalls = onSpy.mock.calls.filter((c) => c[0] === "exit");
    expect(exitCalls.length).toBe(1);
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

  test("rejects concurrent profiled runs with a stderr warning", () => {
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

    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    let ownedA = false;
    let ownedB = false;
    try {
      // First run starts cleanly — owns profiling
      ownedA = initProfiling({
        processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
        cpuSamplerOptions: { setIntervalFn: setIntervalA },
      });
      // Second run while first is still active — must be refused (not owner)
      ownedB = initProfiling({
        processOn: ((_event: string, _h: () => void) => process) as unknown as typeof process.on,
        cpuSamplerOptions: { setIntervalFn: setIntervalB },
      });
    } finally {
      process.stderr.write = origWrite;
    }

    expect(ownedA).toBe(true);
    expect(ownedB).toBe(false);
    expect(secondSetIntervalCalls).toBe(0);
    expect(stderrWrites.some((w) => w.includes("already being profiled"))).toBe(true);
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
