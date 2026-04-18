import { describe, expect, test } from "bun:test";
import type { TranscriptEntry, TranscriptEntryId } from "@koi/core";
import { groupTurns, turnsToEntryRange } from "../turns.js";

const entry = (id: string, role: TranscriptEntry["role"], content = ""): TranscriptEntry => ({
  id: id as TranscriptEntryId,
  role,
  content,
  timestamp: 0,
});

describe("groupTurns", () => {
  test("empty input yields zero turns", () => {
    expect(groupTurns([])).toEqual([]);
  });

  test("a single user entry yields one turn", () => {
    const t = groupTurns([entry("u1", "user")]);
    expect(t.length).toBe(1);
    expect(t[0]?.entries.length).toBe(1);
  });

  test("user→assistant→tool_result groups into one turn", () => {
    const entries = [
      entry("u1", "user"),
      entry("a1", "assistant"),
      entry("tc1", "tool_call"),
      entry("tr1", "tool_result"),
    ];
    const t = groupTurns(entries);
    expect(t.length).toBe(1);
    expect(t[0]?.entries.length).toBe(4);
  });

  test("consecutive users split into separate turns", () => {
    const entries = [entry("u1", "user"), entry("u2", "user")];
    const t = groupTurns(entries);
    expect(t.length).toBe(2);
  });

  test("compaction entry starts a new turn", () => {
    const entries = [
      entry("u1", "user"),
      entry("a1", "assistant"),
      entry("c1", "compaction"),
      entry("u2", "user"),
    ];
    const t = groupTurns(entries);
    expect(t.length).toBe(3);
    expect(t[1]?.entries[0]?.role).toBe("compaction");
  });

  test("leading non-boundary entries form implicit turn 0", () => {
    const entries = [entry("s1", "system"), entry("u1", "user")];
    const t = groupTurns(entries);
    expect(t.length).toBe(2);
    expect(t[0]?.entries[0]?.role).toBe("system");
    expect(t[1]?.entries[0]?.role).toBe("user");
  });
});

describe("turnsToEntryRange", () => {
  const ents = [
    entry("u1", "user"),
    entry("a1", "assistant"),
    entry("u2", "user"),
    entry("a2", "assistant"),
    entry("u3", "user"),
  ];
  const turns = groupTurns(ents);

  test("returns full slice for valid range", () => {
    const r = turnsToEntryRange(turns, 0, 1);
    expect(r.map((e) => e.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("single-turn slice", () => {
    const r = turnsToEntryRange(turns, 2, 2);
    expect(r.map((e) => e.id)).toEqual(["u3"]);
  });

  test("fromTurn=0 edge", () => {
    const r = turnsToEntryRange(turns, 0, 0);
    expect(r.map((e) => e.id)).toEqual(["u1", "a1"]);
  });

  test("toTurn=last edge", () => {
    const r = turnsToEntryRange(turns, 0, turns.length - 1);
    expect(r.length).toBe(5);
  });

  test("returns empty array when fromTurn > toTurn", () => {
    const r = turnsToEntryRange(turns, 2, 1);
    expect(r).toEqual([]);
  });

  test("returns empty array when toTurn is out of range", () => {
    const r = turnsToEntryRange(turns, 0, 99);
    expect(r).toEqual([]);
  });
});
