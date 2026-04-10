import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigChange, ConfigConsumer } from "./consumer.js";
import type { ConfigReloadEvent } from "./events.js";
import { createConfigManager, DEFAULT_KOI_CONFIG } from "./reload.js";

/** Builds a minimal fully-populated KoiConfig YAML string for test fixtures. */
function minimalConfigYaml(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    logLevel: "info",
    // All required sections with default values
    telemetry: "{ enabled: false }",
    limits: "{ maxTurns: 25, maxDurationMs: 300000, maxTokens: 100000 }",
    loopDetection: "{ enabled: true, windowSize: 8, threshold: 3 }",
    spawn: "{ maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 20 }",
    forge:
      "{ enabled: true, maxForgeDepth: 1, maxForgesPerSession: 5, defaultScope: agent, defaultPolicy: sandbox }",
    modelRouter: "{ strategy: fallback, targets: [{ provider: default, model: default }] }",
    features: "{}",
    ...overrides,
  };
  return `${Object.entries(base)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n`;
}

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

// ---------------------------------------------------------------------------
// Hot-reload scenarios (issue #1632)
// ---------------------------------------------------------------------------

describe("ConfigManager hot-reload: events and classification", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "koi-hotreload-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function captureEvents(mgr: ReturnType<typeof createConfigManager>): ConfigReloadEvent[] {
    const received: ConfigReloadEvent[] = [];
    mgr.events.subscribe((e) => received.push(e));
    return received;
  }

  // ----- Hot-apply paths (4) -----

  test("Hot #1: logLevel change is applied and emits changed event", async () => {
    const p = join(tempDir, "hot1.yaml");
    writeFileSync(p, minimalConfigYaml({ logLevel: "info" }));
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    const events = captureEvents(mgr);
    const changes: ConfigChange[] = [];
    mgr.registerConsumer({ onConfigChange: (c) => void changes.push(c) });

    writeFileSync(p, minimalConfigYaml({ logLevel: "debug" }));
    const result = await mgr.reload();

    expect(result.ok).toBe(true);
    expect(mgr.store.get().logLevel).toBe("debug");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("attempted");
    expect(kinds).toContain("applied");
    expect(kinds).toContain("changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changedPaths).toContain("logLevel");
    mgr.dispose();
  });

  test("Hot #2: loopDetection.threshold change fires consumer with loopDetection path", async () => {
    const p = join(tempDir, "hot2.yaml");
    writeFileSync(p, minimalConfigYaml());
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    const changes: ConfigChange[] = [];
    mgr.registerConsumer({ onConfigChange: (c) => void changes.push(c) });

    writeFileSync(
      p,
      minimalConfigYaml({
        loopDetection: "{ enabled: true, windowSize: 8, threshold: 5 }",
      }),
    );
    const result = await mgr.reload();

    expect(result.ok).toBe(true);
    expect(mgr.store.get().loopDetection.threshold).toBe(5);
    expect(changes[0]?.changedPaths.some((path) => path.startsWith("loopDetection"))).toBe(true);
    mgr.dispose();
  });

  test("Hot #3: modelRouter.targets replacement is reported on the array path", async () => {
    const p = join(tempDir, "hot3.yaml");
    writeFileSync(p, minimalConfigYaml());
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    const changes: ConfigChange[] = [];
    mgr.registerConsumer({ onConfigChange: (c) => void changes.push(c) });

    writeFileSync(
      p,
      minimalConfigYaml({
        modelRouter:
          "{ strategy: fallback, targets: [{ provider: openai, model: gpt-5 }, { provider: anthropic, model: claude }] }",
      }),
    );
    const result = await mgr.reload();

    expect(result.ok).toBe(true);
    expect(mgr.store.get().modelRouter.targets).toHaveLength(2);
    expect(changes[0]?.changedPaths).toEqual(expect.arrayContaining(["modelRouter.targets"]));
    mgr.dispose();
  });

  test("Hot #4: features flag toggle does not touch sibling sections", async () => {
    const p = join(tempDir, "hot4.yaml");
    writeFileSync(p, minimalConfigYaml());
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    const changes: ConfigChange[] = [];
    mgr.registerConsumer({ onConfigChange: (c) => void changes.push(c) });

    writeFileSync(p, minimalConfigYaml({ features: "{ experimentalThing: true }" }));
    const result = await mgr.reload();

    expect(result.ok).toBe(true);
    expect(mgr.store.get().features.experimentalThing).toBe(true);
    expect(changes[0]?.changedPaths).toEqual(
      expect.arrayContaining(["features.experimentalThing"]),
    );
    mgr.dispose();
  });

  // ----- Restart-required paths (2) -----

  test("Restart #1: limits change is rejected with restart-required reason", async () => {
    const p = join(tempDir, "restart1.yaml");
    writeFileSync(p, minimalConfigYaml());
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    const prevLimits = mgr.store.get().limits;
    const events = captureEvents(mgr);
    const changes: ConfigChange[] = [];
    mgr.registerConsumer({ onConfigChange: (c) => void changes.push(c) });

    writeFileSync(
      p,
      minimalConfigYaml({
        limits: "{ maxTurns: 50, maxDurationMs: 600000, maxTokens: 200000 }",
      }),
    );
    const result = await mgr.reload();

    expect(result.ok).toBe(false);
    // Store is unchanged.
    expect(mgr.store.get().limits).toEqual(prevLimits);
    // Consumer was NOT fired (no hot-apply happened).
    expect(changes).toHaveLength(0);
    // Rejected event carries restart-required reason + paths.
    const rejected = events.find((e) => e.kind === "rejected");
    expect(rejected?.kind).toBe("rejected");
    if (rejected?.kind === "rejected") {
      expect(rejected.reason).toBe("restart-required");
      expect(rejected.restartRequiredPaths).toEqual(expect.arrayContaining(["limits.maxTurns"]));
    }
    mgr.dispose();
  });

  test("Restart #2: mixed hot+restart edit is rejected as a whole (no partial apply)", async () => {
    const p = join(tempDir, "restart2.yaml");
    writeFileSync(p, minimalConfigYaml({ logLevel: "info" }));
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();

    writeFileSync(
      p,
      minimalConfigYaml({
        logLevel: "debug", // hot
        telemetry: "{ enabled: true }", // restart
      }),
    );
    const result = await mgr.reload();

    expect(result.ok).toBe(false);
    // Critically: the hot field was NOT applied either.
    expect(mgr.store.get().logLevel).toBe("info");
    expect(mgr.store.get().telemetry.enabled).toBe(false);
    mgr.dispose();
  });

  // ----- Defensive tests (Codex review) -----

  test("Empty diff: file touched without changes — applied fires with empty paths, changed does NOT", async () => {
    const p = join(tempDir, "empty.yaml");
    writeFileSync(p, minimalConfigYaml());
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    const events = captureEvents(mgr);
    const changes: ConfigChange[] = [];
    mgr.registerConsumer({ onConfigChange: (c) => void changes.push(c) });

    // Re-write the same content
    writeFileSync(p, minimalConfigYaml());
    const result = await mgr.reload();

    expect(result.ok).toBe(true);
    const applied = events.find((e) => e.kind === "applied");
    expect(applied?.kind).toBe("applied");
    if (applied?.kind === "applied") {
      expect(applied.changedPaths).toEqual([]);
    }
    // No `changed` event — consumer must not have fired.
    expect(events.some((e) => e.kind === "changed")).toBe(false);
    expect(changes).toHaveLength(0);
    mgr.dispose();
  });

  test("Empty diff (Codex): Zod strips unknown keys; an unknown-key-only edit is a no-op", async () => {
    const p = join(tempDir, "zod-strip.yaml");
    writeFileSync(p, minimalConfigYaml());
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    const changes: ConfigChange[] = [];
    mgr.registerConsumer({ onConfigChange: (c) => void changes.push(c) });

    // Add an unknown top-level key — Zod should strip it.
    writeFileSync(p, `${minimalConfigYaml()}unknownExtraKey: hello\n`);
    const result = await mgr.reload();

    expect(result.ok).toBe(true);
    // After stripping, validated config is identical to prior — consumer should NOT fire.
    expect(changes).toHaveLength(0);
    mgr.dispose();
  });

  test("Validation failure: store retains old value; subsequent valid reload succeeds", async () => {
    const p = join(tempDir, "valfail.yaml");
    writeFileSync(p, minimalConfigYaml({ logLevel: "debug" }));
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    expect(mgr.store.get().logLevel).toBe("debug");

    // Invalid logLevel
    writeFileSync(p, minimalConfigYaml({ logLevel: "verbose" }));
    const bad = await mgr.reload();
    expect(bad.ok).toBe(false);
    // Store still has the previous good value.
    expect(mgr.store.get().logLevel).toBe("debug");

    // Valid reload now succeeds.
    writeFileSync(p, minimalConfigYaml({ logLevel: "warn" }));
    const good = await mgr.reload();
    expect(good.ok).toBe(true);
    expect(mgr.store.get().logLevel).toBe("warn");
    mgr.dispose();
  });

  test("Load error: permission denied leaves store unchanged and emits rejected/load", async () => {
    const p = join(tempDir, "permdenied.yaml");
    writeFileSync(p, minimalConfigYaml({ logLevel: "debug" }));
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    const events = captureEvents(mgr);
    const priorLevel = mgr.store.get().logLevel;

    // Revoke read permission
    chmodSync(p, 0o000);
    try {
      const result = await mgr.reload();
      expect(result.ok).toBe(false);
      expect(mgr.store.get().logLevel).toBe(priorLevel);
      const rejected = events.find((e) => e.kind === "rejected");
      expect(rejected?.kind).toBe("rejected");
    } finally {
      chmodSync(p, 0o644);
    }
    mgr.dispose();
  });

  test("Consumer exceptions are isolated — next consumer still fires", async () => {
    const p = join(tempDir, "throws.yaml");
    writeFileSync(p, minimalConfigYaml({ logLevel: "info" }));
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    const fired: string[] = [];
    const boomConsumer: ConfigConsumer = {
      onConfigChange: () => {
        throw new Error("boom");
      },
    };
    const okConsumer: ConfigConsumer = {
      onConfigChange: () => {
        fired.push("ok");
      },
    };
    mgr.registerConsumer(boomConsumer);
    mgr.registerConsumer(okConsumer);

    writeFileSync(p, minimalConfigYaml({ logLevel: "debug" }));
    const result = await mgr.reload();

    expect(result.ok).toBe(true);
    expect(fired).toEqual(["ok"]);
    mgr.dispose();
  });

  test("Single-flight: concurrent reload() calls are coalesced", async () => {
    const p = join(tempDir, "coalesce.yaml");
    writeFileSync(p, minimalConfigYaml({ logLevel: "info" }));
    const mgr = createConfigManager({ filePath: p });
    await mgr.reload();
    const events = captureEvents(mgr);

    writeFileSync(p, minimalConfigYaml({ logLevel: "debug" }));
    const p1 = mgr.reload();
    writeFileSync(p, minimalConfigYaml({ logLevel: "warn" }));
    const p2 = mgr.reload();
    writeFileSync(p, minimalConfigYaml({ logLevel: "error" }));
    const p3 = mgr.reload();

    await Promise.all([p1, p2, p3]);

    // Final state reflects the latest file
    expect(mgr.store.get().logLevel).toBe("error");
    // p2 and p3 should be the same trailing promise (coalesced).
    expect(p2).toBe(p3);
    // At most 2 reloads should have actually executed (leading + trailing).
    const attemptedCount = events.filter((e) => e.kind === "attempted").length;
    expect(attemptedCount).toBeLessThanOrEqual(2);
    mgr.dispose();
  });

  test("Rename-on-save: atomic write via tmp+rename re-arms watcher and fires consumer", async () => {
    const p = join(tempDir, "rename.yaml");
    writeFileSync(p, minimalConfigYaml({ logLevel: "info" }));
    const mgr = createConfigManager({ filePath: p, watchDebounceMs: 20 });
    await mgr.reload();
    mgr.watch();

    const changes: ConfigChange[] = [];
    mgr.registerConsumer({ onConfigChange: (c) => void changes.push(c) });

    // Atomic-save pattern: write temp, rename over target.
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, minimalConfigYaml({ logLevel: "debug" }));
    renameSync(tmp, p);

    // Wait for debounce + reload + potential re-arm.
    await new Promise((r) => setTimeout(r, 400));

    expect(mgr.store.get().logLevel).toBe("debug");
    expect(changes.length).toBeGreaterThanOrEqual(1);
    mgr.dispose();
  });
});
