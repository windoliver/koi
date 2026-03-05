/**
 * Unit tests for IPC config resolution.
 *
 * Verifies 3-layer merge (defaults -> preset -> user overrides)
 * and validation of required config for nexus/orchestrator subsystems.
 */

import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "@koi/core";
import { resolveIpcConfig } from "../config-resolution.js";
import type { IpcStackConfig } from "../types.js";

const noopSpawn: SpawnFn = async () => ({ ok: true, output: "" });

describe("resolveIpcConfig", () => {
  // ── Default preset ──────────────────────────────────────────────────

  test("defaults to local preset", () => {
    const resolved = resolveIpcConfig({ spawn: noopSpawn });
    expect(resolved.messaging?.kind).toBe("local");
    expect(resolved.delegation?.kind).toBe("task-spawn");
  });

  // ── Preset selection ────────────────────────────────────────────────

  test("cloud preset sets nexus messaging and parallel-minions delegation", () => {
    const resolved = resolveIpcConfig({
      spawn: noopSpawn,
      preset: "cloud",
      messaging: { kind: "nexus", config: { agentId: "a1" as never } },
    });
    expect(resolved.messaging?.kind).toBe("nexus");
    expect(resolved.delegation?.kind).toBe("parallel-minions");
  });

  test("cloud preset without user messaging config throws for nexus", () => {
    expect(() => resolveIpcConfig({ spawn: noopSpawn, preset: "cloud" })).toThrow(
      /Nexus messaging requires explicit config/,
    );
  });

  test("hybrid preset sets local messaging and parallel-minions delegation", () => {
    const resolved = resolveIpcConfig({ spawn: noopSpawn, preset: "hybrid" });
    expect(resolved.messaging?.kind).toBe("local");
    expect(resolved.delegation?.kind).toBe("parallel-minions");
  });

  // ── User overrides ──────────────────────────────────────────────────

  test("user override replaces preset messaging", () => {
    const config: IpcStackConfig = {
      spawn: noopSpawn,
      preset: "local",
      messaging: { kind: "nexus", config: { agentId: "a1" as never } },
    };
    const resolved = resolveIpcConfig(config);
    expect(resolved.messaging?.kind).toBe("nexus");
  });

  test("user override replaces preset delegation", () => {
    const config: IpcStackConfig = {
      spawn: noopSpawn,
      preset: "local",
      delegation: { kind: "parallel-minions" },
    };
    const resolved = resolveIpcConfig(config);
    expect(resolved.delegation?.kind).toBe("parallel-minions");
  });

  // ── Pass-through fields ─────────────────────────────────────────────

  test("workspace passes through without preset default", () => {
    const workspace = { backend: {} as never };
    const resolved = resolveIpcConfig({ spawn: noopSpawn, workspace });
    expect(resolved.workspace).toBe(workspace);
  });

  test("scratchpad passes through without preset default", () => {
    const scratchpad = {
      kind: "local" as const,
      config: { groupId: "g1" as never, authorId: "a1" as never },
    };
    const resolved = resolveIpcConfig({ spawn: noopSpawn, scratchpad });
    expect(resolved.scratchpad).toBe(scratchpad);
  });

  test("federation passes through without preset default", () => {
    const federation = { middleware: { localZoneId: "z1" as never, remoteClients: new Map() } };
    const resolved = resolveIpcConfig({ spawn: noopSpawn, federation });
    expect(resolved.federation).toBe(federation);
  });

  // ── Validation ──────────────────────────────────────────────────────

  test("nexus messaging without config throws", () => {
    expect(() =>
      resolveIpcConfig({
        spawn: noopSpawn,
        messaging: { kind: "nexus" } as never,
      }),
    ).toThrow(/Nexus messaging requires explicit config/);
  });

  test("orchestrator delegation without config throws", () => {
    expect(() =>
      resolveIpcConfig({
        spawn: noopSpawn,
        delegation: { kind: "orchestrator" } as never,
      }),
    ).toThrow(/Orchestrator delegation requires explicit config/);
  });
});
