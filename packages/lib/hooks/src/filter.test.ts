import { describe, expect, it } from "bun:test";
import type { HookEvent, HookFilter } from "@koi/core";
import { matchesHookFilter } from "./filter.js";

const baseEvent: HookEvent = {
  event: "session.started",
  agentId: "agent-1",
  sessionId: "session-1",
};

describe("matchesHookFilter", () => {
  it("matches when filter is undefined", () => {
    expect(matchesHookFilter(undefined, baseEvent)).toBe(true);
  });

  it("matches when filter is empty object", () => {
    expect(matchesHookFilter({}, baseEvent)).toBe(true);
  });

  it("matches when event is in events filter", () => {
    const filter: HookFilter = { events: ["session.started", "session.ended"] };
    expect(matchesHookFilter(filter, baseEvent)).toBe(true);
  });

  it("does not match when event is not in events filter", () => {
    const filter: HookFilter = { events: ["session.ended"] };
    expect(matchesHookFilter(filter, baseEvent)).toBe(false);
  });

  it("matches tool filter when toolName is present and matches", () => {
    const filter: HookFilter = { tools: ["exec", "write"] };
    const event: HookEvent = { ...baseEvent, toolName: "exec" };
    expect(matchesHookFilter(filter, event)).toBe(true);
  });

  it("does not match tool filter when toolName is absent", () => {
    const filter: HookFilter = { tools: ["exec"] };
    expect(matchesHookFilter(filter, baseEvent)).toBe(false);
  });

  it("does not match tool filter when toolName does not match", () => {
    const filter: HookFilter = { tools: ["exec"] };
    const event: HookEvent = { ...baseEvent, toolName: "read" };
    expect(matchesHookFilter(filter, event)).toBe(false);
  });

  it("matches channel filter when channelId is present and matches", () => {
    const filter: HookFilter = { channels: ["telegram", "discord"] };
    const event: HookEvent = { ...baseEvent, channelId: "telegram" };
    expect(matchesHookFilter(filter, event)).toBe(true);
  });

  it("does not match channel filter when channelId is absent", () => {
    const filter: HookFilter = { channels: ["telegram"] };
    expect(matchesHookFilter(filter, baseEvent)).toBe(false);
  });

  it("requires all filter fields to match (AND logic)", () => {
    const filter: HookFilter = {
      events: ["session.started"],
      tools: ["exec"],
    };
    // Event matches but no tool — should fail
    expect(matchesHookFilter(filter, baseEvent)).toBe(false);
    // Both match — should pass
    const event: HookEvent = { ...baseEvent, toolName: "exec" };
    expect(matchesHookFilter(filter, event)).toBe(true);
  });

  it("accepts any value within a field (OR logic)", () => {
    const filter: HookFilter = { events: ["session.started", "session.ended"] };
    expect(matchesHookFilter(filter, { ...baseEvent, event: "session.started" })).toBe(true);
    expect(matchesHookFilter(filter, { ...baseEvent, event: "session.ended" })).toBe(true);
    expect(matchesHookFilter(filter, { ...baseEvent, event: "tool.succeeded" })).toBe(false);
  });

  // Note: empty arrays (events: [], tools: [], channels: []) are rejected
  // at schema validation time. The filter function is never called with them.
});
