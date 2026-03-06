/**
 * Unit tests for IPC deployment presets.
 *
 * Verifies:
 *   - All 3 presets are defined and frozen
 *   - "local": messaging=local, delegation=task-spawn
 *   - "cloud": messaging=nexus, delegation=task-spawn
 *   - "hybrid": messaging=local, delegation=task-spawn
 */

import { describe, expect, test } from "bun:test";
import { IPC_PRESET_SPECS } from "../presets.js";

describe("IPC_PRESET_SPECS", () => {
  test("all 3 presets are defined", () => {
    expect(IPC_PRESET_SPECS).toHaveProperty("local");
    expect(IPC_PRESET_SPECS).toHaveProperty("cloud");
    expect(IPC_PRESET_SPECS).toHaveProperty("hybrid");
  });

  test("registry is frozen", () => {
    expect(Object.isFrozen(IPC_PRESET_SPECS)).toBe(true);
  });

  test("each preset spec is frozen", () => {
    expect(Object.isFrozen(IPC_PRESET_SPECS.local)).toBe(true);
    expect(Object.isFrozen(IPC_PRESET_SPECS.cloud)).toBe(true);
    expect(Object.isFrozen(IPC_PRESET_SPECS.hybrid)).toBe(true);
  });

  // ── Local preset ─────────────────────────────────────────────────────

  test("local: messaging is local", () => {
    expect(IPC_PRESET_SPECS.local.messaging?.kind).toBe("local");
  });

  test("local: delegation is task-spawn", () => {
    expect(IPC_PRESET_SPECS.local.delegation?.kind).toBe("task-spawn");
  });

  // ── Cloud preset ─────────────────────────────────────────────────────

  test("cloud: messaging is nexus", () => {
    expect(IPC_PRESET_SPECS.cloud.messaging?.kind).toBe("nexus");
  });

  test("cloud: delegation is task-spawn", () => {
    expect(IPC_PRESET_SPECS.cloud.delegation?.kind).toBe("task-spawn");
  });

  // ── Hybrid preset ────────────────────────────────────────────────────

  test("hybrid: messaging is local", () => {
    expect(IPC_PRESET_SPECS.hybrid.messaging?.kind).toBe("local");
  });

  test("hybrid: delegation is task-spawn", () => {
    expect(IPC_PRESET_SPECS.hybrid.delegation?.kind).toBe("task-spawn");
  });
});
