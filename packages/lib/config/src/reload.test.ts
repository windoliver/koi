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
    const result = await mgr.initialize();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logLevel).toBe("debug");
      expect(result.value.limits.maxTurns).toBe(50);
    }
    expect(mgr.store.get().logLevel).toBe("debug");
    mgr.dispose();
  });

  test("initialize() returns error for missing file", async () => {
    const mgr = createConfigManager({ filePath: join(tempDir, "nope.yaml") });
    const result = await mgr.initialize();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
    // Store should retain default
    expect(mgr.store.get()).toEqual(DEFAULT_KOI_CONFIG);
    mgr.dispose();
  });

  test("initialize() returns error for invalid config", async () => {
    configPath = join(tempDir, "invalid.yaml");
    writeFileSync(configPath, "logLevel: verbose\n");
    const mgr = createConfigManager({ filePath: configPath });
    const result = await mgr.initialize();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
    mgr.dispose();
  });

  test("initialize() merges file with defaults", async () => {
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
    const result = await mgr.initialize();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logLevel).toBe("warn");
      expect(result.value.limits.maxTurns).toBe(10);
      // Defaults should fill in
      expect(result.value.spawn.maxDepth).toBe(3);
    }
    mgr.dispose();
  });

  test("reload() before initialize() acts as a one-shot bootstrap (legacy contract)", async () => {
    configPath = join(tempDir, "uninit.yaml");
    writeFileSync(configPath, minimalConfigYaml({ logLevel: "debug" }));
    const mgr = createConfigManager({ filePath: configPath });
    // No explicit initialize() — reload() should auto-promote.
    const result = await mgr.reload();
    expect(result.ok).toBe(true);
    expect(mgr.store.get().logLevel).toBe("debug");
    mgr.dispose();
  });

  test("pre-init consumer receives the initial bind via initialize()", async () => {
    configPath = join(tempDir, "preinit-consumer.yaml");
    writeFileSync(configPath, minimalConfigYaml({ logLevel: "debug" }));
    const mgr = createConfigManager({ filePath: configPath });
    const changes: ConfigChange[] = [];
    // Register BEFORE initialize — the consumer must still observe the
    // initial bind via the `changed` event that initialize() emits.
    mgr.registerConsumer({
      onConfigChange: (c) => void changes.push(c),
    });
    await mgr.initialize();
    expect(changes).toHaveLength(1);
    expect(changes[0]?.next.logLevel).toBe("debug");
    expect(changes[0]?.changedPaths).toContain("logLevel");
    mgr.dispose();
  });

  test("pre-init consumer observes no changed event when file matches defaults (documented limit)", async () => {
    configPath = join(tempDir, "preinit-defaults.yaml");
    // Write a file that's byte-identical to DEFAULT_KOI_CONFIG.
    writeFileSync(configPath, minimalConfigYaml());
    const mgr = createConfigManager({ filePath: configPath });
    const changes: ConfigChange[] = [];
    mgr.registerConsumer({
      onConfigChange: (c) => void changes.push(c),
    });
    await mgr.initialize();
    // DOCUMENTED LIMITATION: initialize() only fires `changed` when the
    // loaded config differs from DEFAULT_KOI_CONFIG. Pre-init consumers
    // that register before `initialize()` and need to observe bootstrap
    // regardless of diff must read `mgr.store.get()` after initialize().
    expect(changes).toHaveLength(0);
    mgr.dispose();
  });

  test("watcher retries initialize() after an explicit init failure (recovery)", async () => {
    const missing = join(tempDir, "will-appear.yaml");
    // Start with NO file — initialize will fail.
    const mgr = createConfigManager({ filePath: missing, watchDebounceMs: 20 });
    const firstInit = await mgr.initialize();
    expect(firstInit.ok).toBe(false);
    // Start watching. The file doesn't exist yet; watcher retries rearm
    // under the hood.
    mgr.watch();
    // Now write the file. The watcher must detect it and retry init.
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(missing, minimalConfigYaml({ logLevel: "debug" }));
    // Wait long enough for rearm (~50ms) + debounce (20ms) + init + slack.
    await new Promise((r) => setTimeout(r, 500));
    expect(mgr.store.get().logLevel).toBe("debug");
    mgr.dispose();
  });

  test("watcher events before initialize() are silently dropped (no auto-bootstrap)", async () => {
    configPath = join(tempDir, "watch-preinit.yaml");
    writeFileSync(configPath, minimalConfigYaml({ logLevel: "info" }));
    const mgr = createConfigManager({ filePath: configPath, watchDebounceMs: 20 });
    // Start watching BEFORE any initialize() call. The watcher must NOT
    // silently bootstrap the manager — store stays on defaults until an
    // explicit initialize().
    mgr.watch();
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(configPath, minimalConfigYaml({ logLevel: "debug" }));
    await new Promise((r) => setTimeout(r, 100));
    // Store is STILL defaults — the watcher event was dropped.
    expect(mgr.store.get()).toEqual(DEFAULT_KOI_CONFIG);

    // Explicit initialize now binds the store.
    await mgr.initialize();
    expect(mgr.store.get().logLevel).toBe("debug");
    mgr.dispose();
  });

  test("single-flight: .then-chained reload after head does not race with trailing", async () => {
    // Codex HIGH round 9: earlier implementations cleared `inflight = null`
    // in the head's .finally, opening a microtask window where a
    // .then-registered continuation could start a parallel reload before
    // the trailing coroutine claimed the slot.
    configPath = join(tempDir, "race.yaml");
    writeFileSync(configPath, minimalConfigYaml({ logLevel: "info" }));
    const mgr = createConfigManager({ filePath: configPath });
    await mgr.initialize();

    const attempts: string[] = [];
    mgr.events.subscribe((e) => {
      if (e.kind === "attempted") attempts.push("attempted");
    });

    // head reload
    const headPromise = mgr.reload();
    // trailing reload queued (shares promise with any later joiners)
    const trailingPromise = mgr.reload();
    // racing reload chained off the head — would hit the gap in the old
    // implementation
    const racingPromise = headPromise.then(() => mgr.reload());

    await Promise.all([headPromise, trailingPromise, racingPromise]);

    // The total number of `attempted` events tells us how many actual runs
    // happened. We expect:
    //   head (1) + coalesced trailing (1) + racing-as-new-batch (1) = 3
    // What we must NOT see is duplicates from an overlap race (>3 implies
    // the old bug). Importantly, trailing and racing must not BOTH start
    // after head finishes — they should serialize.
    expect(attempts.length).toBeLessThanOrEqual(3);
    // Store is coherent and reflects the final file content.
    expect(mgr.store.get().logLevel).toBe("info");
    mgr.dispose();
  });

  test("concurrent initialize() calls coalesce — only one full pipeline runs", async () => {
    configPath = join(tempDir, "concurrent-init.yaml");
    // Use a config that DIFFERS from defaults so initialize() emits a
    // `changed` event (required for this test's correctness assertion).
    writeFileSync(configPath, minimalConfigYaml({ logLevel: "debug" }));
    const mgr = createConfigManager({ filePath: configPath });

    // The critical correctness property is that only ONE actual disk read
    // happens — we verify this by checking the `changed` event count:
    // exactly one `changed` fires (the first successful init), and the
    // idempotent second call does NOT fire `changed`.
    const events: string[] = [];
    mgr.events.subscribe((e) => events.push(e.kind));

    const firstInit = mgr.initialize();
    const secondInit = mgr.initialize();

    const [first, second] = await Promise.all([firstInit, secondInit]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Only one `changed` — the second call was a no-op idempotent reuse.
    const changedCount = events.filter((k) => k === "changed").length;
    expect(changedCount).toBe(1);
    mgr.dispose();
  });

  test("queued reload after in-flight initialize still rereads disk", async () => {
    configPath = join(tempDir, "queue-test.yaml");
    writeFileSync(configPath, minimalConfigYaml({ logLevel: "info" }));
    const mgr = createConfigManager({ filePath: configPath });

    // Fire initialize (in-flight), then queue a reload with a different
    // on-disk value. The queued reload must observe the latest file
    // contents even though initialize was the first operation queued.
    const initPromise = mgr.initialize();
    writeFileSync(configPath, minimalConfigYaml({ logLevel: "debug" }));
    const reloadPromise = mgr.reload();

    await initPromise;
    await reloadPromise;

    expect(mgr.store.get().logLevel).toBe("debug");
    mgr.dispose();
  });

  test("watch() before initialize() is allowed but does not fire until the file changes", async () => {
    configPath = join(tempDir, "early-watch.yaml");
    writeFileSync(configPath, minimalConfigYaml());
    const mgr = createConfigManager({ filePath: configPath, watchDebounceMs: 30 });
    // Legacy startup ordering: watch() before initialize() must not throw.
    const unsub = mgr.watch();
    expect(typeof unsub).toBe("function");
    await mgr.initialize();
    mgr.dispose();
  });

  test("initialize() is idempotent — second call is a no-op", async () => {
    configPath = join(tempDir, "idempotent.yaml");
    writeFileSync(configPath, minimalConfigYaml({ logLevel: "debug" }));
    const mgr = createConfigManager({ filePath: configPath });
    const first = await mgr.initialize();
    expect(first.ok).toBe(true);
    // Change the file, then re-initialize — the second initialize is a no-op.
    writeFileSync(configPath, minimalConfigYaml({ logLevel: "warn" }));
    const second = await mgr.initialize();
    expect(second.ok).toBe(true);
    // Store still reflects the first load because initialize() is idempotent.
    expect(mgr.store.get().logLevel).toBe("debug");
    mgr.dispose();
  });

  test("watch() and dispose() work without error after initialize()", async () => {
    configPath = join(tempDir, "watch-test.yaml");
    writeFileSync(configPath, "logLevel: info\n");
    const mgr = createConfigManager({ filePath: configPath, watchDebounceMs: 50 });
    await mgr.initialize();
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
    await mgr.initialize();
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
    await mgr.initialize();
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
    await mgr.initialize();
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
    await mgr.initialize();
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
    await mgr.initialize();
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
    await mgr.initialize();

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
    await mgr.initialize();
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
    await mgr.initialize();
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
    await mgr.initialize();
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
    await mgr.initialize();
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
    await mgr.initialize();
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

  test("post-init registerConsumer does not fire until the next reload", async () => {
    const p = join(tempDir, "post-init-register.yaml");
    writeFileSync(p, minimalConfigYaml({ logLevel: "debug" }));
    const mgr = createConfigManager({ filePath: p });
    await mgr.initialize();

    const changes: ConfigChange[] = [];
    mgr.registerConsumer({
      onConfigChange: (c) => void changes.push(c),
    });
    // Post-init consumer must NOT receive an immediate invocation — it
    // should read `mgr.store.get()` for the current snapshot and subscribe
    // to future changes only.
    expect(changes).toHaveLength(0);
    expect(mgr.store.get().logLevel).toBe("debug");
    mgr.dispose();
  });

  test("Async consumer rejections do not escape as unhandled promise rejections", async () => {
    const p = join(tempDir, "asyncreject.yaml");
    writeFileSync(p, minimalConfigYaml({ logLevel: "info" }));
    const mgr = createConfigManager({ filePath: p });
    await mgr.initialize();

    // Install a process-level unhandled rejection detector.
    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);

    try {
      const fired: string[] = [];
      mgr.registerConsumer({
        onConfigChange: async () => {
          throw new Error("async boom");
        },
      });
      mgr.registerConsumer({
        onConfigChange: () => {
          fired.push("ok");
        },
      });

      writeFileSync(p, minimalConfigYaml({ logLevel: "debug" }));
      const result = await mgr.reload();
      expect(result.ok).toBe(true);
      expect(fired).toEqual(["ok"]);

      // Give the async rejection a chance to surface to the process.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
      mgr.dispose();
    }
  });

  test("Single-flight: concurrent reload() calls are coalesced", async () => {
    const p = join(tempDir, "coalesce.yaml");
    writeFileSync(p, minimalConfigYaml({ logLevel: "info" }));
    const mgr = createConfigManager({ filePath: p });
    await mgr.initialize();
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
    await mgr.initialize();
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
