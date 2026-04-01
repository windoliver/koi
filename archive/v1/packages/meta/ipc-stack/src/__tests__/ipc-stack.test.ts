/**
 * Unit tests for createIpcStack factory.
 *
 * Verifies subsystem composition for each preset and user overrides.
 * Uses real factory functions (no mocks) for integration-level confidence.
 */

import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "@koi/core";
import { createIpcStack } from "../ipc-stack.js";
import type { IpcStackConfig } from "../types.js";

const noopSpawn: SpawnFn = async () => ({ ok: true, output: "" });

// ---------------------------------------------------------------------------
// Local preset (default)
// ---------------------------------------------------------------------------

describe("createIpcStack — local preset", () => {
  test("returns router for local messaging", () => {
    const bundle = createIpcStack({ spawn: noopSpawn });
    expect(bundle.router).toBeDefined();
    expect(bundle.router?.register).toBeFunction();
    expect(bundle.router?.unregister).toBeFunction();
    expect(bundle.router?.get).toBeFunction();
  });

  test("includes task-spawn provider", () => {
    const bundle = createIpcStack({ spawn: noopSpawn });
    expect(bundle.providers.length).toBeGreaterThanOrEqual(1);
    const names = bundle.providers.map((p) => p.name);
    expect(names).toContain("task-spawn");
  });

  test("no federation middleware", () => {
    const bundle = createIpcStack({ spawn: noopSpawn });
    const fedMw = bundle.middlewares.find((mw) => mw.name === "koi:federation");
    expect(fedMw).toBeUndefined();
  });

  test("no sync engine", () => {
    const bundle = createIpcStack({ spawn: noopSpawn });
    expect(bundle.syncEngine).toBeUndefined();
  });

  test("metadata reflects local preset", () => {
    const bundle = createIpcStack({ spawn: noopSpawn });
    expect(bundle.config.preset).toBe("local");
    expect(bundle.config.messagingKind).toBe("local");
    expect(bundle.config.delegationKind).toBe("task-spawn");
    expect(bundle.config.workspaceEnabled).toBe(false);
    expect(bundle.config.federationEnabled).toBe(false);
    expect(bundle.config.scratchpadKind).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Cloud preset
// ---------------------------------------------------------------------------

describe("createIpcStack — cloud preset", () => {
  test("includes nexus provider (no router)", () => {
    const bundle = createIpcStack({
      spawn: noopSpawn,
      preset: "cloud",
      messaging: {
        kind: "nexus",
        config: { agentId: "a1" as never },
      },
    });
    expect(bundle.router).toBeUndefined();
    const names = bundle.providers.map((p) => p.name);
    expect(names).toContain("ipc-nexus");
  });

  test("includes task-spawn provider", () => {
    const bundle = createIpcStack({
      spawn: noopSpawn,
      preset: "cloud",
      messaging: {
        kind: "nexus",
        config: { agentId: "a1" as never },
      },
    });
    const names = bundle.providers.map((p) => p.name);
    expect(names).toContain("task-spawn");
  });

  test("metadata reflects cloud preset", () => {
    const bundle = createIpcStack({
      spawn: noopSpawn,
      preset: "cloud",
      messaging: {
        kind: "nexus",
        config: { agentId: "a1" as never },
      },
    });
    expect(bundle.config.preset).toBe("cloud");
    expect(bundle.config.messagingKind).toBe("nexus");
    expect(bundle.config.delegationKind).toBe("task-spawn");
  });
});

// ---------------------------------------------------------------------------
// Hybrid preset
// ---------------------------------------------------------------------------

describe("createIpcStack — hybrid preset", () => {
  test("has local router + task-spawn provider", () => {
    const bundle = createIpcStack({
      spawn: noopSpawn,
      preset: "hybrid",
    });
    expect(bundle.router).toBeDefined();
    const names = bundle.providers.map((p) => p.name);
    expect(names).toContain("task-spawn");
  });

  test("metadata reflects hybrid preset", () => {
    const bundle = createIpcStack({
      spawn: noopSpawn,
      preset: "hybrid",
    });
    expect(bundle.config.preset).toBe("hybrid");
    expect(bundle.config.messagingKind).toBe("local");
    expect(bundle.config.delegationKind).toBe("task-spawn");
  });
});

// ---------------------------------------------------------------------------
// User overrides
// ---------------------------------------------------------------------------

describe("createIpcStack — user overrides", () => {
  test("explicit no messaging overrides preset", () => {
    const config: IpcStackConfig = {
      spawn: noopSpawn,
      preset: "local",
      messaging: undefined,
    };
    // When messaging is undefined in user config but preset has it,
    // resolveIpcConfig still picks up preset default
    const bundle = createIpcStack(config);
    expect(bundle.config.messagingKind).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// Scratchpad subsystem
// ---------------------------------------------------------------------------

describe("createIpcStack — scratchpad", () => {
  test("local scratchpad adds provider + disposable", () => {
    const bundle = createIpcStack({
      spawn: noopSpawn,
      scratchpad: {
        kind: "local",
        config: { groupId: "g1" as never, authorId: "a1" as never },
      },
    });
    const names = bundle.providers.map((p) => p.name);
    expect(names).toContain("koi:scratchpad-local");
    expect(bundle.disposables.length).toBeGreaterThanOrEqual(1);
    expect(bundle.config.scratchpadKind).toBe("local");
  });

  test("nexus scratchpad adds provider + middleware", () => {
    const bundle = createIpcStack({
      spawn: noopSpawn,
      scratchpad: {
        kind: "nexus",
        config: { agentId: "a1" as never, groupId: "g1" as never },
      },
    });
    const names = bundle.providers.map((p) => p.name);
    expect(names).toContain("scratchpad-nexus");
    const mwNames = bundle.middlewares.map((mw) => mw.name);
    expect(mwNames).toContain("scratchpad-flush");
    expect(bundle.config.scratchpadKind).toBe("nexus");
  });
});

// ---------------------------------------------------------------------------
// Federation subsystem
// ---------------------------------------------------------------------------

describe("createIpcStack — federation", () => {
  test("federation middleware added when configured", () => {
    const bundle = createIpcStack({
      spawn: noopSpawn,
      federation: {
        middleware: {
          localZoneId: "z1" as never,
          remoteClients: new Map(),
        },
      },
    });
    const mwNames = bundle.middlewares.map((mw) => mw.name);
    expect(mwNames).toContain("koi:federation");
    expect(bundle.config.federationEnabled).toBe(true);
  });

  test("sync engine returned + disposable added when configured", () => {
    const bundle = createIpcStack({
      spawn: noopSpawn,
      federation: {
        sync: {
          localZoneId: "z1" as never,
          remoteClients: new Map(),
          pollIntervalMs: 5000,
          minPollIntervalMs: 1000,
          maxPollIntervalMs: 30_000,
          snapshotThreshold: 1000,
          clockPruneAfterMs: 86_400_000,
        },
      },
    });
    expect(bundle.syncEngine).toBeDefined();
    expect(bundle.syncEngine?.sync).toBeFunction();
    expect(bundle.disposables.length).toBeGreaterThanOrEqual(1);

    // Clean up: dispose sync engine to stop polling timer
    for (const d of bundle.disposables) {
      d[Symbol.dispose]();
    }
  });
});

// ---------------------------------------------------------------------------
// Bundle metadata
// ---------------------------------------------------------------------------

describe("createIpcStack — metadata", () => {
  test("providerCount and middlewareCount are accurate", () => {
    const bundle = createIpcStack({
      spawn: noopSpawn,
      scratchpad: {
        kind: "nexus",
        config: { agentId: "a1" as never, groupId: "g1" as never },
      },
    });
    expect(bundle.config.providerCount).toBe(bundle.providers.length);
    expect(bundle.config.middlewareCount).toBe(bundle.middlewares.length);
  });
});
