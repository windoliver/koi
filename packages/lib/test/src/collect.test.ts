import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { toolCallId } from "@koi/core";
import {
  collectEvents,
  collectOutput,
  collectText,
  collectToolNames,
  collectUsage,
  filterByKind,
} from "./collect.js";

const sampleEvents: readonly EngineEvent[] = [
  { kind: "turn_start", turnIndex: 0 },
  { kind: "text_delta", delta: "hello " },
  { kind: "tool_call_start", toolName: "search", callId: toolCallId("c1") },
  { kind: "tool_call_end", callId: toolCallId("c1"), result: { items: [] } },
  { kind: "text_delta", delta: "world" },
  { kind: "turn_end", turnIndex: 0 },
  {
    kind: "done",
    output: {
      content: [],
      stopReason: "completed",
      metrics: {
        totalTokens: 30,
        inputTokens: 10,
        outputTokens: 20,
        turns: 1,
        durationMs: 5,
      },
    },
  },
];

async function* iterate(): AsyncGenerator<EngineEvent> {
  for (const e of sampleEvents) {
    yield e;
  }
}

describe("collectEvents", () => {
  test("drains an async iterable", async () => {
    const collected = await collectEvents(iterate());
    expect(collected).toHaveLength(sampleEvents.length);
  });
});

describe("collectText", () => {
  test("concatenates text deltas", () => {
    expect(collectText(sampleEvents)).toBe("hello world");
  });

  test("returns empty string for no text events", () => {
    expect(collectText([])).toBe("");
  });
});

describe("collectToolNames", () => {
  test("returns tool names in order", () => {
    expect(collectToolNames(sampleEvents)).toEqual(["search"]);
  });
});

describe("collectOutput", () => {
  test("returns output from done event", () => {
    const output = collectOutput(sampleEvents);
    expect(output?.stopReason).toBe("completed");
  });

  test("returns undefined when no done event", () => {
    expect(collectOutput([])).toBeUndefined();
  });
});

describe("collectUsage", () => {
  test("returns inputTokens and outputTokens", () => {
    const usage = collectUsage(sampleEvents);
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  test("returns undefined when no done event", () => {
    expect(collectUsage([])).toBeUndefined();
  });
});

describe("filterByKind", () => {
  test("narrows the result type to the chosen variant", () => {
    const textDeltas = filterByKind(sampleEvents, "text_delta");
    expect(textDeltas).toHaveLength(2);
    // Type-level: textDeltas[0].delta is available without narrowing
    expect(textDeltas[0]?.delta).toBe("hello ");
  });
});
