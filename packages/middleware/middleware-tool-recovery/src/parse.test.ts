import { describe, expect, test } from "bun:test";
import { recoverToolCalls } from "./parse.js";
import type { RecoveryEvent, ToolCallPattern } from "./types.js";

/** Simple test pattern that always matches if text contains "[tool:NAME]". */
function createTestPattern(name: string): ToolCallPattern {
  return {
    name,
    detect(text: string) {
      const regex = /\[tool:(\w+)\]/g;
      const matches = [...text.matchAll(regex)];
      if (matches.length === 0) return undefined;
      // let justified: building remaining text by removing matched regions
      let remaining = text;
      const toolCalls = matches.map((m) => {
        remaining = remaining.replace(m[0], "");
        return { toolName: m[1] ?? "", arguments: {} };
      });
      return { toolCalls, remainingText: remaining.trim() };
    },
  };
}

describe("recoverToolCalls", () => {
  const pattern = createTestPattern("test");
  const allowed = new Set(["search", "get_weather"]);

  test("returns undefined when no pattern matches", () => {
    const result = recoverToolCalls("plain text", [pattern], allowed, 10);
    expect(result).toBeUndefined();
  });

  test("returns undefined when allowedTools is empty", () => {
    const result = recoverToolCalls("[tool:search]", [pattern], new Set(), 10);
    expect(result).toBeUndefined();
  });

  test("recovers matching tool calls", () => {
    const result = recoverToolCalls("[tool:search]", [pattern], allowed, 10);
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(1);
    expect(result?.toolCalls[0]?.toolName).toBe("search");
  });

  test("filters out tools not in allowedTools", () => {
    const events: RecoveryEvent[] = [];
    const result = recoverToolCalls("[tool:search] [tool:forbidden]", [pattern], allowed, 10, (e) =>
      events.push(e),
    );
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(1);
    expect(result?.toolCalls[0]?.toolName).toBe("search");
    expect(events.some((e) => e.kind === "rejected" && e.toolName === "forbidden")).toBe(true);
  });

  test("returns undefined when all tool calls are rejected", () => {
    const result = recoverToolCalls("[tool:unknown]", [pattern], allowed, 10);
    expect(result).toBeUndefined();
  });

  test("caps at maxCalls", () => {
    const text = "[tool:search] [tool:get_weather] [tool:search]";
    const result = recoverToolCalls(text, [pattern], allowed, 2);
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(2);
  });

  test("first pattern wins when multiple patterns could match", () => {
    const patternA = createTestPattern("pattern-a");
    const patternB = createTestPattern("pattern-b");
    const events: RecoveryEvent[] = [];
    recoverToolCalls("[tool:search]", [patternA, patternB], allowed, 10, (e) => events.push(e));
    const recoveredEvents = events.filter((e) => e.kind === "recovered");
    expect(recoveredEvents).toHaveLength(1);
    if (recoveredEvents[0]?.kind === "recovered") {
      expect(recoveredEvents[0]?.pattern).toBe("pattern-a");
    }
  });

  test("skips pattern with all rejected calls and tries next pattern", () => {
    // Pattern A only returns "forbidden" tools, pattern B returns "search"
    const patternA: ToolCallPattern = {
      name: "pattern-a",
      detect(text: string) {
        if (!text.includes("[forbidden]")) return undefined;
        return {
          toolCalls: [{ toolName: "forbidden", arguments: {} }],
          remainingText: text.replace("[forbidden]", "").trim(),
        };
      },
    };
    const patternB: ToolCallPattern = {
      name: "pattern-b",
      detect(text: string) {
        if (!text.includes("[search]")) return undefined;
        return {
          toolCalls: [{ toolName: "search", arguments: {} }],
          remainingText: text.replace("[search]", "").trim(),
        };
      },
    };

    const result = recoverToolCalls("[forbidden] [search]", [patternA, patternB], allowed, 10);
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(1);
    expect(result?.toolCalls[0]?.toolName).toBe("search");
  });

  test("returns undefined when all patterns match but all calls rejected", () => {
    // Both patterns match but only return disallowed tools
    const patternA: ToolCallPattern = {
      name: "pattern-a",
      detect(text: string) {
        if (!text.includes("[x]")) return undefined;
        return {
          toolCalls: [{ toolName: "disallowed_a", arguments: {} }],
          remainingText: text,
        };
      },
    };
    const patternB: ToolCallPattern = {
      name: "pattern-b",
      detect(text: string) {
        if (!text.includes("[x]")) return undefined;
        return {
          toolCalls: [{ toolName: "disallowed_b", arguments: {} }],
          remainingText: text,
        };
      },
    };

    const result = recoverToolCalls("[x]", [patternA, patternB], allowed, 10);
    expect(result).toBeUndefined();
  });

  test("first pattern with accepted calls wins over later patterns", () => {
    const events: RecoveryEvent[] = [];
    // Both patterns match; pattern A has allowed calls, pattern B also has allowed calls
    const patternA: ToolCallPattern = {
      name: "pattern-a",
      detect(text: string) {
        if (!text.includes("[tool:search]")) return undefined;
        return {
          toolCalls: [{ toolName: "search", arguments: {} }],
          remainingText: text.replace("[tool:search]", "").trim(),
        };
      },
    };
    const patternB: ToolCallPattern = {
      name: "pattern-b",
      detect(text: string) {
        if (!text.includes("[tool:search]")) return undefined;
        return {
          toolCalls: [{ toolName: "get_weather", arguments: {} }],
          remainingText: text.replace("[tool:search]", "").trim(),
        };
      },
    };

    const result = recoverToolCalls("[tool:search]", [patternA, patternB], allowed, 10, (e) =>
      events.push(e),
    );
    expect(result).toBeDefined();
    expect(result?.toolCalls[0]?.toolName).toBe("search");
    const recovered = events.filter((e) => e.kind === "recovered");
    expect(recovered).toHaveLength(1);
    if (recovered[0]?.kind === "recovered") {
      expect(recovered[0]?.pattern).toBe("pattern-a");
    }
  });

  test("emits recovered event with pattern name", () => {
    const events: RecoveryEvent[] = [];
    recoverToolCalls("[tool:search]", [pattern], allowed, 10, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("recovered");
    if (events[0]?.kind === "recovered") {
      expect(events[0]?.pattern).toBe("test");
    }
  });
});
