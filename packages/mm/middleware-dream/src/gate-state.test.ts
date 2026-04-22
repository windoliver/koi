/**
 * Tests for gate state persistence.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGateState, mutateGateState, saveGateState } from "./gate-state.js";

const TEST_DIR = join(import.meta.dir, "__test_gate_tmp__");

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("loadGateState", () => {
  it("returns default state when file does not exist", async () => {
    const state = await loadGateState(TEST_DIR);
    expect(state).toEqual({ lastDreamAt: 0, sessionsSinceDream: 0 });
  });

  it("returns saved state from disk", async () => {
    const expected = { lastDreamAt: 1_700_000_000_000, sessionsSinceDream: 3 };
    await writeFile(join(TEST_DIR, ".dream-gate.json"), JSON.stringify(expected), "utf-8");

    const state = await loadGateState(TEST_DIR);
    expect(state).toEqual(expected);
  });

  it("returns default state when file contains corrupted JSON", async () => {
    await writeFile(join(TEST_DIR, ".dream-gate.json"), "not-valid-json{{{", "utf-8");

    const state = await loadGateState(TEST_DIR);
    expect(state).toEqual({ lastDreamAt: 0, sessionsSinceDream: 0 });
  });

  it("returns default state when JSON has wrong shape", async () => {
    await writeFile(join(TEST_DIR, ".dream-gate.json"), JSON.stringify({ foo: "bar" }), "utf-8");

    const state = await loadGateState(TEST_DIR);
    expect(state).toEqual({ lastDreamAt: 0, sessionsSinceDream: 0 });
  });
});

describe("saveGateState", () => {
  it("persists state and can be loaded back", async () => {
    const state = { lastDreamAt: 1_700_000_000_000, sessionsSinceDream: 7 };
    await saveGateState(TEST_DIR, state);

    const loaded = await loadGateState(TEST_DIR);
    expect(loaded).toEqual(state);
  });

  it("overwrites existing state", async () => {
    await saveGateState(TEST_DIR, { lastDreamAt: 100, sessionsSinceDream: 2 });
    await saveGateState(TEST_DIR, { lastDreamAt: 200, sessionsSinceDream: 0 });

    const loaded = await loadGateState(TEST_DIR);
    expect(loaded).toEqual({ lastDreamAt: 200, sessionsSinceDream: 0 });
  });
});

describe("mutateGateState (concurrency)", () => {
  it("serializes 10 concurrent in-process increments without losing any", async () => {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        mutateGateState(TEST_DIR, (s) => ({
          lastDreamAt: s.lastDreamAt,
          sessionsSinceDream: s.sessionsSinceDream + 1,
        })),
      ),
    );
    const final = await loadGateState(TEST_DIR);
    expect(final.sessionsSinceDream).toBe(10);
  });

  it("returns the new state from the mutator", async () => {
    const result = await mutateGateState(TEST_DIR, () => ({
      lastDreamAt: 42,
      sessionsSinceDream: 7,
    }));
    expect(result).toEqual({ lastDreamAt: 42, sessionsSinceDream: 7 });
  });

  it("a throwing mutator does not poison the per-dir chain", async () => {
    await expect(
      mutateGateState(TEST_DIR, () => {
        throw new Error("first call boom");
      }),
    ).rejects.toThrow("first call boom");

    // Subsequent mutation must still work
    const result = await mutateGateState(TEST_DIR, (s) => ({
      lastDreamAt: s.lastDreamAt,
      sessionsSinceDream: s.sessionsSinceDream + 1,
    }));
    expect(result.sessionsSinceDream).toBe(1);
  });

  it("evicts a stale gate-lock left behind by a crashed prior holder", async () => {
    // Stale lock with timestamp from 10s ago — older than STALE_LOCK_AGE_MS (5s)
    await writeFile(join(TEST_DIR, ".dream-gate.lock"), `99999:${String(Date.now() - 10_000)}:abc`);
    const result = await mutateGateState(TEST_DIR, () => ({
      lastDreamAt: 1,
      sessionsSinceDream: 1,
    }));
    expect(result.sessionsSinceDream).toBe(1);
  });
});
