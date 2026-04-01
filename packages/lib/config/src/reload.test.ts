import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigManager, DEFAULT_KOI_CONFIG } from "./reload.js";

describe("DEFAULT_KOI_CONFIG", () => {
  test("has all 8 sections", () => {
    expect(DEFAULT_KOI_CONFIG.logLevel).toBe("info");
    expect(DEFAULT_KOI_CONFIG.telemetry.enabled).toBe(false);
    expect(DEFAULT_KOI_CONFIG.limits.maxTurns).toBe(25);
    expect(DEFAULT_KOI_CONFIG.loopDetection.enabled).toBe(true);
    expect(DEFAULT_KOI_CONFIG.spawn.maxDepth).toBe(3);
    expect(DEFAULT_KOI_CONFIG.forge.enabled).toBe(true);
    expect(DEFAULT_KOI_CONFIG.modelRouter.strategy).toBe("fallback");
    expect(DEFAULT_KOI_CONFIG.features).toEqual({});
  });
});

describe("createConfigManager", () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "koi-reload-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("starts with DEFAULT_KOI_CONFIG", () => {
    configPath = join(tempDir, "start.yaml");
    writeFileSync(configPath, "logLevel: info\n");
    const mgr = createConfigManager({ filePath: configPath });
    expect(mgr.store.get()).toEqual(DEFAULT_KOI_CONFIG);
    mgr.dispose();
  });

  test("reload() loads and validates config", async () => {
    configPath = join(tempDir, "reload.yaml");
    writeFileSync(
      configPath,
      [
        "logLevel: debug",
        "telemetry:",
        "  enabled: true",
        "limits:",
        "  maxTurns: 50",
        "  maxDurationMs: 600000",
        "  maxTokens: 200000",
        "loopDetection:",
        "  enabled: true",
        "  windowSize: 8",
        "  threshold: 3",
        "spawn:",
        "  maxDepth: 3",
        "  maxFanOut: 5",
        "  maxTotalProcesses: 20",
        "forge:",
        "  enabled: true",
        "  maxForgeDepth: 1",
        "  maxForgesPerSession: 5",
        "  defaultScope: agent",
        "  defaultPolicy: sandbox",
        "modelRouter:",
        "  strategy: fallback",
        "  targets:",
        "    - provider: default",
        "      model: default",
        "features: {}",
        "",
      ].join("\n"),
    );
    const mgr = createConfigManager({ filePath: configPath });
    const result = await mgr.reload();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logLevel).toBe("debug");
      expect(result.value.limits.maxTurns).toBe(50);
    }
    expect(mgr.store.get().logLevel).toBe("debug");
    mgr.dispose();
  });

  test("reload() returns error for missing file", async () => {
    const mgr = createConfigManager({ filePath: join(tempDir, "nope.yaml") });
    const result = await mgr.reload();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
    // Store should retain default
    expect(mgr.store.get()).toEqual(DEFAULT_KOI_CONFIG);
    mgr.dispose();
  });

  test("reload() returns error for invalid config", async () => {
    configPath = join(tempDir, "invalid.yaml");
    writeFileSync(configPath, "logLevel: verbose\n");
    const mgr = createConfigManager({ filePath: configPath });
    const result = await mgr.reload();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
    mgr.dispose();
  });

  test("reload() merges file with defaults", async () => {
    configPath = join(tempDir, "partial.yaml");
    writeFileSync(
      configPath,
      [
        "logLevel: warn",
        "telemetry:",
        "  enabled: false",
        "limits:",
        "  maxTurns: 10",
        "  maxDurationMs: 300000",
        "  maxTokens: 100000",
        "loopDetection:",
        "  enabled: true",
        "  windowSize: 8",
        "  threshold: 3",
        "spawn:",
        "  maxDepth: 3",
        "  maxFanOut: 5",
        "  maxTotalProcesses: 20",
        "forge:",
        "  enabled: true",
        "  maxForgeDepth: 1",
        "  maxForgesPerSession: 5",
        "  defaultScope: agent",
        "  defaultPolicy: sandbox",
        "modelRouter:",
        "  strategy: fallback",
        "  targets:",
        "    - provider: default",
        "      model: default",
        "features: {}",
        "",
      ].join("\n"),
    );
    const mgr = createConfigManager({ filePath: configPath });
    const result = await mgr.reload();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logLevel).toBe("warn");
      expect(result.value.limits.maxTurns).toBe(10);
      // Defaults should fill in
      expect(result.value.spawn.maxDepth).toBe(3);
    }
    mgr.dispose();
  });

  test("watch() and dispose() work without error", async () => {
    configPath = join(tempDir, "watch-test.yaml");
    writeFileSync(configPath, "logLevel: info\n");
    const mgr = createConfigManager({ filePath: configPath, watchDebounceMs: 50 });
    const unsub = mgr.watch();
    expect(typeof unsub).toBe("function");
    mgr.dispose();
  });
});
