import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { startCpuSampler, stopCpuSampler } from "./cpu-sampler.js";
import { dumpProfile, resetProfiler } from "./profiler.js";

describe("cpu-sampler", () => {
  beforeEach(() => {
    resetProfiler({ enabled: true });
  });

  afterEach(() => {
    stopCpuSampler();
    resetProfiler({ enabled: false });
  });

  test("does nothing when profiling disabled", () => {
    resetProfiler({ enabled: false });
    const setIntervalSpy = mock(() => 0);
    startCpuSampler({
      intervalMs: 100,
      setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
    });
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  test("starts a timer at the requested interval when enabled", () => {
    const setIntervalSpy = mock(
      (_fn: () => void, _ms: number) => 42 as unknown as ReturnType<typeof setInterval>,
    );
    startCpuSampler({
      intervalMs: 250,
      setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
    });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(250);
  });

  test("ignores duplicate start calls", () => {
    const setIntervalSpy = mock(
      (_fn: () => void, _ms: number) => 42 as unknown as ReturnType<typeof setInterval>,
    );
    startCpuSampler({
      intervalMs: 100,
      setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
    });
    startCpuSampler({
      intervalMs: 100,
      setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
    });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  test("stop clears the timer and allows restart", () => {
    const clearIntervalSpy = mock((_id: ReturnType<typeof setInterval>) => undefined);
    const setIntervalSpy = mock(
      (_fn: () => void, _ms: number) => 42 as unknown as ReturnType<typeof setInterval>,
    );
    startCpuSampler({
      intervalMs: 100,
      setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
      clearIntervalFn: clearIntervalSpy as unknown as typeof clearInterval,
    });
    stopCpuSampler();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    startCpuSampler({
      intervalMs: 100,
      setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
      clearIntervalFn: clearIntervalSpy as unknown as typeof clearInterval,
    });
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });

  test("each tick records cpu.userUs, cpu.systemUs, cpu.wallMs, cpu.utilizationPct", () => {
    const captured: { fn: (() => void) | null } = { fn: null };
    const setIntervalSpy = mock((fn: () => void, _ms: number) => {
      captured.fn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    startCpuSampler({
      intervalMs: 100,
      setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
    });
    const tick = captured.fn;
    expect(tick).not.toBeNull();
    if (!tick) return;
    // Run two ticks so histograms have entries
    tick();
    tick();
    const report = dumpProfile();
    expect(report.samples["cpu.userUs"]).toBeDefined();
    expect(report.samples["cpu.systemUs"]).toBeDefined();
    expect(report.samples["cpu.wallMs"]).toBeDefined();
    expect(report.samples["cpu.utilizationPct"]).toBeDefined();
    expect(report.samples["cpu.userUs"]?.length).toBe(2);
    // All four series share the same timestamp at each tick so consumers can
    // window any one and read the others at the same point.
    const tA = report.samples["cpu.userUs"]?.[0]?.[0];
    const tB = report.samples["cpu.systemUs"]?.[0]?.[0];
    expect(tA).toBeDefined();
    expect(tA).toBe(tB ?? -1);
  });
});
