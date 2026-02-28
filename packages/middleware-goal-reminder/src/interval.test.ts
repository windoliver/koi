/**
 * Table-driven tests for computeNextInterval and defaultIsDrifting.
 */

import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import { computeNextInterval, defaultIsDrifting } from "./interval.js";
import type { ReminderSessionState } from "./types.js";

// ---------------------------------------------------------------------------
// computeNextInterval
// ---------------------------------------------------------------------------

describe("computeNextInterval", () => {
  const BASE = 5;
  const MAX = 20;

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly state: ReminderSessionState;
    readonly isDrifting: boolean;
    readonly expected: ReminderSessionState;
  }> = [
    {
      name: "first trigger at base interval (turn 5)",
      state: { turnCount: 4, currentInterval: 5, lastReminderTurn: 0, shouldInject: false },
      isDrifting: false,
      expected: { turnCount: 5, currentInterval: 10, lastReminderTurn: 5, shouldInject: true },
    },
    {
      name: "non-trigger turn passes through",
      state: { turnCount: 1, currentInterval: 5, lastReminderTurn: 0, shouldInject: false },
      isDrifting: false,
      expected: { turnCount: 2, currentInterval: 5, lastReminderTurn: 0, shouldInject: false },
    },
    {
      name: "on-track doubles interval",
      state: { turnCount: 14, currentInterval: 10, lastReminderTurn: 5, shouldInject: false },
      isDrifting: false,
      expected: { turnCount: 15, currentInterval: 20, lastReminderTurn: 15, shouldInject: true },
    },
    {
      name: "interval capped at max",
      state: { turnCount: 34, currentInterval: 20, lastReminderTurn: 15, shouldInject: false },
      isDrifting: false,
      expected: { turnCount: 35, currentInterval: 20, lastReminderTurn: 35, shouldInject: true },
    },
    {
      name: "drifting resets to base",
      state: { turnCount: 14, currentInterval: 10, lastReminderTurn: 5, shouldInject: false },
      isDrifting: true,
      expected: { turnCount: 15, currentInterval: 5, lastReminderTurn: 15, shouldInject: true },
    },
    {
      name: "at base + drifting stays at base",
      state: { turnCount: 4, currentInterval: 5, lastReminderTurn: 0, shouldInject: false },
      isDrifting: true,
      expected: { turnCount: 5, currentInterval: 5, lastReminderTurn: 5, shouldInject: true },
    },
    {
      name: "at max + drifting resets to base",
      state: { turnCount: 34, currentInterval: 20, lastReminderTurn: 15, shouldInject: false },
      isDrifting: true,
      expected: { turnCount: 35, currentInterval: 5, lastReminderTurn: 35, shouldInject: true },
    },
    {
      name: "geometric doubling: 5 → 10 → 20 (second doubling)",
      state: { turnCount: 19, currentInterval: 10, lastReminderTurn: 10, shouldInject: false },
      isDrifting: false,
      expected: { turnCount: 20, currentInterval: 20, lastReminderTurn: 20, shouldInject: true },
    },
  ];

  for (const { name, state, isDrifting, expected } of cases) {
    test(name, () => {
      const result = computeNextInterval(state, isDrifting, BASE, MAX);
      expect(result).toEqual(expected);
    });
  }

  test("returns new object (immutability)", () => {
    const state: ReminderSessionState = {
      turnCount: 0,
      currentInterval: 5,
      lastReminderTurn: 0,
      shouldInject: false,
    };
    const result = computeNextInterval(state, false, BASE, MAX);
    expect(result).not.toBe(state);
  });
});

// ---------------------------------------------------------------------------
// defaultIsDrifting
// ---------------------------------------------------------------------------

describe("defaultIsDrifting", () => {
  function makeMessage(text: string): InboundMessage {
    return {
      senderId: "user",
      timestamp: Date.now(),
      content: [{ kind: "text", text }],
    };
  }

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly messages: readonly InboundMessage[];
    readonly goals: readonly string[];
    readonly expected: boolean;
  }> = [
    {
      name: "messages with goal keyword → not drifting",
      messages: [makeMessage("I finished the search and found results")],
      goals: ["search the web for data"],
      expected: false,
    },
    {
      name: "messages without goal keywords → drifting",
      messages: [makeMessage("Let me cook dinner instead")],
      goals: ["search the web for data"],
      expected: true,
    },
    {
      name: "empty goals → never drifting",
      messages: [makeMessage("random unrelated text")],
      goals: [],
      expected: false,
    },
    {
      name: "empty messages → drifting",
      messages: [],
      goals: ["complete the report"],
      expected: true,
    },
    {
      name: "keyword match is case-insensitive",
      messages: [makeMessage("I ran a SEARCH on the topic")],
      goals: ["search the web"],
      expected: false,
    },
    {
      name: "only checks last 3 messages",
      messages: [
        makeMessage("search results are in"),
        makeMessage("unrelated chat"),
        makeMessage("more unrelated talk"),
        makeMessage("completely off topic now"),
      ],
      goals: ["search the web"],
      expected: true,
    },
    {
      name: "short words (< 4 chars) are ignored as keywords",
      messages: [makeMessage("I did the job")],
      goals: ["do a web search"],
      expected: true, // "web" is only 3 chars, "search" is the keyword
    },
  ];

  for (const { name, messages, goals, expected } of cases) {
    test(name, () => {
      expect(defaultIsDrifting(messages, goals)).toBe(expected);
    });
  }
});
