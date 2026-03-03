import { describe, expect, it } from "bun:test";
import type { MinionOutcome, MinionSpawnResult } from "./types.js";
import {
  isMinionOutcomeFailure,
  isMinionOutcomeSuccess,
  isMinionSpawnFailure,
  isMinionSpawnSuccess,
} from "./types.js";

describe("type guards", () => {
  it("isMinionSpawnSuccess returns true for success", () => {
    const result: MinionSpawnResult = { ok: true, output: "done" };
    expect(isMinionSpawnSuccess(result)).toBe(true);
    expect(isMinionSpawnFailure(result)).toBe(false);
  });

  it("isMinionSpawnFailure returns true for failure", () => {
    const result: MinionSpawnResult = { ok: false, error: "oops" };
    expect(isMinionSpawnFailure(result)).toBe(true);
    expect(isMinionSpawnSuccess(result)).toBe(false);
  });

  it("isMinionOutcomeSuccess returns true for success", () => {
    const outcome: MinionOutcome = { ok: true, taskIndex: 0, output: "done" };
    expect(isMinionOutcomeSuccess(outcome)).toBe(true);
    expect(isMinionOutcomeFailure(outcome)).toBe(false);
  });

  it("isMinionOutcomeFailure returns true for failure", () => {
    const outcome: MinionOutcome = { ok: false, taskIndex: 0, error: "oops" };
    expect(isMinionOutcomeFailure(outcome)).toBe(true);
    expect(isMinionOutcomeSuccess(outcome)).toBe(false);
  });
});
