import { describe, expect, mock, test } from "bun:test";
import { createConfigManager, type DEFAULT_KOI_CONFIG } from "./reload.js";

/** Polls until a condition is met, with a deadline to avoid infinite hangs. */
async function waitFor(condition: () => boolean, timeoutMs: number = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

const fullConfig = `logLevel: info
telemetry:
  enabled: false
limits:
  maxTurns: 25
  maxDurationMs: 300000
  maxTokens: 100000
loopDetection:
  enabled: true
  windowSize: 8
  threshold: 3
spawn:
  maxDepth: 3
  maxFanOut: 5
  maxTotalProcesses: 20
forge:
  enabled: true
  maxForgeDepth: 1
  maxForgesPerSession: 5
  defaultScope: agent
  defaultPolicy: sandbox
modelRouter:
  strategy: fallback
  targets:
    - provider: default
      model: default
features: {}
`;

describe("createConfigManager", () => {
  test("store starts with default config", () => {
    const mgr = createConfigManager({ filePath: "/tmp/nonexistent.yaml" });
    expect(mgr.store.get().logLevel).toBe("info");
    expect(mgr.store.get().limits.maxTurns).toBe(25);
  });

  test("store starts with initial overrides merged", () => {
    const mgr = createConfigManager({
      filePath: "/tmp/nonexistent.yaml",
      initial: { logLevel: "debug" } as Partial<typeof DEFAULT_KOI_CONFIG>,
    });
    expect(mgr.store.get().logLevel).toBe("debug");
    expect(mgr.store.get().limits.maxTurns).toBe(25); // default preserved
  });

  test("reload returns NOT_FOUND for nonexistent file", async () => {
    const mgr = createConfigManager({ filePath: "/tmp/koi-test-nonexistent.yaml" });
    const result = await mgr.reload();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("reload notifies subscribers on success", async () => {
    const tmpPath = "/tmp/koi-test-reload.yaml";
    await Bun.write(
      tmpPath,
      fullConfig
        .replace("logLevel: info", "logLevel: debug")
        .replace("maxTurns: 25", "maxTurns: 10"),
    );

    const mgr = createConfigManager({ filePath: tmpPath });
    const fn = mock(() => {});
    mgr.store.subscribe(fn);

    const result = await mgr.reload();
    expect(result.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mgr.store.get().logLevel).toBe("debug");
    expect(mgr.store.get().limits.maxTurns).toBe(10);
  });

  test("reload returns validation error and does not update store", async () => {
    const tmpPath = "/tmp/koi-test-invalid.yaml";
    await Bun.write(tmpPath, "logLevel: not-a-level\n");

    const mgr = createConfigManager({ filePath: tmpPath });
    const fn = mock(() => {});
    mgr.store.subscribe(fn);

    const result = await mgr.reload();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
    // Store should retain default config
    expect(mgr.store.get().logLevel).toBe("info");
    expect(fn).not.toHaveBeenCalled();
  });

  test("watch() triggers reload on file change", async () => {
    const tmpPath = "/tmp/koi-test-watch.yaml";
    await Bun.write(tmpPath, fullConfig);

    const mgr = createConfigManager({ filePath: tmpPath });
    const fn = mock(() => {});
    mgr.store.subscribe(fn);

    const unsubscribe = mgr.watch();
    try {
      // Modify the file with a valid change
      await Bun.write(tmpPath, fullConfig.replace("logLevel: info", "logLevel: debug"));

      // Poll until subscriber fires
      await waitFor(() => fn.mock.calls.length > 0);

      expect(fn).toHaveBeenCalled();
      expect(mgr.store.get().logLevel).toBe("debug");
    } finally {
      unsubscribe();
    }
  });

  test("watch() unsubscribe stops file watching", async () => {
    const tmpPath = "/tmp/koi-test-watch-unsub.yaml";
    await Bun.write(tmpPath, fullConfig);

    const mgr = createConfigManager({ filePath: tmpPath });
    const fn = mock(() => {});
    mgr.store.subscribe(fn);

    const unsubscribe = mgr.watch();
    unsubscribe();

    await Bun.write(tmpPath, fullConfig.replace("logLevel: info", "logLevel: debug"));
    await new Promise((r) => setTimeout(r, 300));

    expect(fn).not.toHaveBeenCalled();
  });

  test("watch() calls onReloadError when reload fails", async () => {
    const tmpPath = "/tmp/koi-test-watch-error.yaml";
    await Bun.write(tmpPath, fullConfig);

    const onReloadError = mock(() => {});
    const mgr = createConfigManager({ filePath: tmpPath, onReloadError });
    const unsubscribe = mgr.watch();

    try {
      // Write invalid config
      await Bun.write(tmpPath, "logLevel: INVALID\n");

      // Poll until error callback fires
      await waitFor(() => onReloadError.mock.calls.length > 0);

      expect(onReloadError).toHaveBeenCalled();
      // Store should still have valid config
      expect(mgr.store.get().logLevel).toBe("info");
    } finally {
      unsubscribe();
    }
  });
});
