import { describe, expect, it, mock } from "bun:test";
import { createAgentHost } from "./agent/host.js";
import { createMemoryMonitor } from "./monitor.js";

describe("MemoryMonitor", () => {
  const config = {
    maxAgents: 10,
    memoryWarningPercent: 80,
    memoryEvictionPercent: 90,
    monitorInterval: 50, // Fast interval for tests
  };

  it("starts and stops without error", () => {
    const host = createAgentHost(config);
    const emit = mock(() => {});
    const monitor = createMemoryMonitor(config, host, emit);

    expect(monitor.isActive()).toBe(false);
    monitor.start();
    expect(monitor.isActive()).toBe(true);
    monitor.stop();
    expect(monitor.isActive()).toBe(false);
  });

  it("reports current memory metrics", () => {
    const host = createAgentHost(config);
    const emit = mock(() => {});
    const monitor = createMemoryMonitor(config, host, emit);

    const metrics = monitor.metrics();
    expect(metrics.heapUsedBytes).toBeGreaterThan(0);
    expect(metrics.heapTotalBytes).toBeGreaterThan(0);
    expect(metrics.rssBytes).toBeGreaterThan(0);
    expect(metrics.usagePercent).toBeGreaterThanOrEqual(0);
    expect(metrics.usagePercent).toBeLessThanOrEqual(100);
  });

  it("emits memory_warning when threshold is reached", async () => {
    const host = createAgentHost(config);
    const events: Array<{ type: string; data?: unknown }> = [];
    const emit = mock((type: string, data?: unknown) => {
      events.push({ type, data });
    });

    // Artificially low thresholds to trigger warning
    const lowConfig = { ...config, memoryWarningPercent: 1, memoryEvictionPercent: 99 };
    const monitor = createMemoryMonitor(lowConfig, host, emit);

    monitor.start();
    await new Promise((r) => setTimeout(r, 80));
    monitor.stop();

    const warnings = events.filter((e) => e.type === "memory_warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("does not emit duplicate warnings", async () => {
    const host = createAgentHost(config);
    const events: Array<{ type: string }> = [];
    const emit = mock((type: string) => {
      events.push({ type });
    });

    const lowConfig = { ...config, memoryWarningPercent: 1, memoryEvictionPercent: 99 };
    const monitor = createMemoryMonitor(lowConfig, host, emit);

    monitor.start();
    await new Promise((r) => setTimeout(r, 150));
    monitor.stop();

    const warnings = events.filter((e) => e.type === "memory_warning");
    // Should only warn once (not on every check)
    expect(warnings.length).toBe(1);
  });

  it("is idempotent on start", () => {
    const host = createAgentHost(config);
    const emit = mock(() => {});
    const monitor = createMemoryMonitor(config, host, emit);

    monitor.start();
    monitor.start(); // no-op
    monitor.stop();
  });
});
