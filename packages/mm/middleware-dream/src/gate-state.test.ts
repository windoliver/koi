/**
 * Tests for gate state persistence.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGateState, saveGateState } from "./gate-state.js";

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
