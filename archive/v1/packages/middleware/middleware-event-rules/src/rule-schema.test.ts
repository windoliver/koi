import { describe, expect, test } from "bun:test";
import { validateEventRulesConfig } from "./rule-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    rules: [
      {
        name: "test-rule",
        on: "tool_call",
        match: { ok: false },
        actions: [{ type: "log", level: "warn", message: "test" }],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid configs
// ---------------------------------------------------------------------------

describe("validateEventRulesConfig — valid configs", () => {
  test("accepts minimal valid config", () => {
    const result = validateEventRulesConfig(validConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rules).toHaveLength(1);
      expect(result.value.rules[0]?.name).toBe("test-rule");
    }
  });

  test("accepts config with all event types", () => {
    const result = validateEventRulesConfig({
      rules: [
        { name: "r1", on: "tool_call", actions: [{ type: "log", level: "info", message: "a" }] },
        {
          name: "r2",
          on: "turn_complete",
          actions: [{ type: "log", level: "info", message: "b" }],
        },
        {
          name: "r3",
          on: "session_start",
          actions: [{ type: "log", level: "info", message: "c" }],
        },
        { name: "r4", on: "session_end", actions: [{ type: "log", level: "info", message: "d" }] },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rules).toHaveLength(4);
    }
  });

  test("accepts config with condition (count + window)", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "windowed",
          on: "tool_call",
          match: { ok: false },
          condition: { count: 3, window: "1m" },
          actions: [{ type: "escalate", message: "fail" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // biome-ignore lint/style/noNonNullAssertion: safe — array validated non-empty
      const rule = result.value.rules[0]!;
      expect(rule.condition).toEqual({ count: 3, windowMs: 60_000 });
    }
  });

  test("accepts config with regex match", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "regex-rule",
          on: "tool_call",
          match: { toolId: { regex: "^shell_" } },
          actions: [{ type: "log", level: "warn", message: "shell" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // biome-ignore lint/style/noNonNullAssertion: safe — validated single rule with single predicate
      const pred = result.value.rules[0]!.predicates[0]!;
      expect(pred.field).toBe("toolId");
      expect(pred.test("shell_exec")).toBe(true);
      expect(pred.test("web_fetch")).toBe(false);
    }
  });

  test("accepts config with numeric gte match", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "numeric-rule",
          on: "turn_complete",
          match: { turnIndex: { gte: 15 } },
          actions: [{ type: "log", level: "warn", message: "high turns" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // biome-ignore lint/style/noNonNullAssertion: safe — validated single rule with single predicate
      const pred = result.value.rules[0]!.predicates[0]!;
      expect(pred.test(15)).toBe(true);
      expect(pred.test(14)).toBe(false);
      expect(pred.test(20)).toBe(true);
    }
  });

  test("accepts config with oneOf array match", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "oneof-rule",
          on: "tool_call",
          match: { toolId: ["shell_exec", "file_write"] },
          actions: [{ type: "log", level: "warn", message: "risky" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // biome-ignore lint/style/noNonNullAssertion: safe — validated single rule with single predicate
      const pred = result.value.rules[0]!.predicates[0]!;
      expect(pred.test("shell_exec")).toBe(true);
      expect(pred.test("file_write")).toBe(true);
      expect(pred.test("web_fetch")).toBe(false);
    }
  });

  test("accepts config with exact boolean match", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "bool-rule",
          on: "tool_call",
          match: { ok: false },
          actions: [{ type: "log", level: "warn", message: "failed" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // biome-ignore lint/style/noNonNullAssertion: safe — validated single rule with single predicate
      const pred = result.value.rules[0]!.predicates[0]!;
      expect(pred.test(false)).toBe(true);
      expect(pred.test(true)).toBe(false);
    }
  });

  test("accepts all action types with required fields", () => {
    const result = validateEventRulesConfig({
      rules: [
        { name: "r1", on: "tool_call", actions: [{ type: "emit", event: "custom.alert" }] },
        { name: "r2", on: "tool_call", actions: [{ type: "escalate", message: "help" }] },
        { name: "r3", on: "tool_call", actions: [{ type: "log", level: "info", message: "log" }] },
        {
          name: "r4",
          on: "tool_call",
          actions: [{ type: "notify", channel: "ops", message: "hey" }],
        },
        { name: "r5", on: "tool_call", actions: [{ type: "skip_tool", toolId: "shell_exec" }] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts stopOnMatch flag", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "stop-rule",
          on: "tool_call",
          actions: [{ type: "log", level: "info", message: "x" }],
          stopOnMatch: true,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rules[0]?.stopOnMatch).toBe(true);
    }
  });

  test("pre-indexes rules by event type", () => {
    const result = validateEventRulesConfig({
      rules: [
        { name: "r1", on: "tool_call", actions: [{ type: "log", level: "info", message: "a" }] },
        { name: "r2", on: "tool_call", actions: [{ type: "log", level: "info", message: "b" }] },
        {
          name: "r3",
          on: "turn_complete",
          actions: [{ type: "log", level: "info", message: "c" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.byEventType.get("tool_call")).toHaveLength(2);
      expect(result.value.byEventType.get("turn_complete")).toHaveLength(1);
      expect(result.value.byEventType.get("session_start")).toBeUndefined();
    }
  });

  test("accepts rule without match (matches all events of type)", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "all-turns",
          on: "turn_complete",
          actions: [{ type: "log", level: "info", message: "turn done" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rules[0]?.predicates).toHaveLength(0);
    }
  });

  test("compiles combined numeric operators (gte + lte)", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "range-rule",
          on: "turn_complete",
          match: { turnIndex: { gte: 5, lte: 10 } },
          actions: [{ type: "log", level: "info", message: "in range" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // biome-ignore lint/style/noNonNullAssertion: safe — validated single rule with single predicate
      const pred = result.value.rules[0]!.predicates[0]!;
      expect(pred.test(4)).toBe(false);
      expect(pred.test(5)).toBe(true);
      expect(pred.test(7)).toBe(true);
      expect(pred.test(10)).toBe(true);
      expect(pred.test(11)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid configs
// ---------------------------------------------------------------------------

describe("validateEventRulesConfig — rejections", () => {
  test("rejects null input", () => {
    const result = validateEventRulesConfig(null);
    expect(result.ok).toBe(false);
  });

  test("rejects empty rules array", () => {
    const result = validateEventRulesConfig({ rules: [] });
    expect(result.ok).toBe(false);
  });

  test("rejects empty rule name", () => {
    const result = validateEventRulesConfig({
      rules: [
        { name: "", on: "tool_call", actions: [{ type: "log", level: "info", message: "x" }] },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects unknown event type", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "bad",
          on: "unknown_event",
          actions: [{ type: "log", level: "info", message: "x" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects duplicate rule names", () => {
    const result = validateEventRulesConfig({
      rules: [
        { name: "dup", on: "tool_call", actions: [{ type: "log", level: "info", message: "a" }] },
        {
          name: "dup",
          on: "turn_complete",
          actions: [{ type: "log", level: "info", message: "b" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects empty actions array", () => {
    const result = validateEventRulesConfig({
      rules: [{ name: "no-actions", on: "tool_call", actions: [] }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects emit action without event field", () => {
    const result = validateEventRulesConfig({
      rules: [{ name: "bad-emit", on: "tool_call", actions: [{ type: "emit" }] }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects escalate action without message field", () => {
    const result = validateEventRulesConfig({
      rules: [{ name: "bad-esc", on: "tool_call", actions: [{ type: "escalate" }] }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects log action without level", () => {
    const result = validateEventRulesConfig({
      rules: [{ name: "bad-log", on: "tool_call", actions: [{ type: "log", message: "x" }] }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects notify action without channel", () => {
    const result = validateEventRulesConfig({
      rules: [{ name: "bad-notif", on: "tool_call", actions: [{ type: "notify", message: "x" }] }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects skip_tool action without toolId", () => {
    const result = validateEventRulesConfig({
      rules: [{ name: "bad-skip", on: "tool_call", actions: [{ type: "skip_tool" }] }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects invalid regex pattern", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "bad-regex",
          on: "tool_call",
          match: { toolId: { regex: "[invalid" } },
          actions: [{ type: "log", level: "info", message: "x" }],
        },
      ],
    });
    // Regex compilation happens during compilation, but invalid regex should cause an error
    // The regex is compiled in compilePredicate — new RegExp("[invalid") throws
    expect(result.ok).toBe(false);
  });

  test("rejects condition with invalid window format", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "bad-window",
          on: "tool_call",
          condition: { count: 3, window: "abc" },
          actions: [{ type: "log", level: "info", message: "x" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects condition with zero count", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "zero-count",
          on: "tool_call",
          condition: { count: 0, window: "1m" },
          actions: [{ type: "log", level: "info", message: "x" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects numeric operator with no comparisons", () => {
    const result = validateEventRulesConfig({
      rules: [
        {
          name: "empty-num",
          on: "turn_complete",
          match: { turnIndex: {} },
          actions: [{ type: "log", level: "info", message: "x" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
});
