import { describe, expect, test } from "bun:test";
import type { SessionId } from "@koi/core/ecs";
import { createRuleEngine } from "./rule-engine.js";
import { validateEventRulesConfig } from "./rule-schema.js";
import type { RuleEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compile(rules: readonly Record<string, unknown>[]) {
  const result = validateEventRulesConfig({ rules });
  if (!result.ok) throw new Error(`Compilation failed: ${result.error.message}`);
  return result.value;
}

function makeEvent(type: string, fields: Record<string, unknown> = {}): RuleEvent {
  return { type: type as RuleEvent["type"], fields, sessionId: "sess-1" as SessionId };
}

// ---------------------------------------------------------------------------
// Predicate matching
// ---------------------------------------------------------------------------

describe("createRuleEngine — predicate matching", () => {
  test("exact boolean match", () => {
    const ruleset = compile([
      {
        name: "r1",
        on: "tool_call",
        match: { ok: false },
        actions: [{ type: "log", level: "warn", message: "fail" }],
      },
    ]);
    const engine = createRuleEngine(ruleset);

    const hit = engine.evaluate(makeEvent("tool_call", { ok: false }));
    expect(hit.actions).toHaveLength(1);

    const miss = engine.evaluate(makeEvent("tool_call", { ok: true }));
    expect(miss.actions).toHaveLength(0);
  });

  test("regex match", () => {
    const ruleset = compile([
      {
        name: "r1",
        on: "tool_call",
        match: { toolId: { regex: "^shell_" } },
        actions: [{ type: "log", level: "warn", message: "x" }],
      },
    ]);
    const engine = createRuleEngine(ruleset);

    expect(engine.evaluate(makeEvent("tool_call", { toolId: "shell_exec" })).actions).toHaveLength(
      1,
    );
    expect(engine.evaluate(makeEvent("tool_call", { toolId: "web_fetch" })).actions).toHaveLength(
      0,
    );
  });

  test("numeric gte match", () => {
    const ruleset = compile([
      {
        name: "r1",
        on: "turn_complete",
        match: { turnIndex: { gte: 15 } },
        actions: [{ type: "log", level: "info", message: "x" }],
      },
    ]);
    const engine = createRuleEngine(ruleset);

    expect(engine.evaluate(makeEvent("turn_complete", { turnIndex: 14 })).actions).toHaveLength(0);
    expect(engine.evaluate(makeEvent("turn_complete", { turnIndex: 15 })).actions).toHaveLength(1);
    expect(engine.evaluate(makeEvent("turn_complete", { turnIndex: 20 })).actions).toHaveLength(1);
  });

  test("AND logic — all predicates must match", () => {
    const ruleset = compile([
      {
        name: "r1",
        on: "tool_call",
        match: { ok: false, toolId: { regex: "^shell_" } },
        actions: [{ type: "log", level: "warn", message: "x" }],
      },
    ]);
    const engine = createRuleEngine(ruleset);

    expect(
      engine.evaluate(makeEvent("tool_call", { ok: false, toolId: "shell_exec" })).actions,
    ).toHaveLength(1);
    expect(
      engine.evaluate(makeEvent("tool_call", { ok: true, toolId: "shell_exec" })).actions,
    ).toHaveLength(0);
    expect(
      engine.evaluate(makeEvent("tool_call", { ok: false, toolId: "web_fetch" })).actions,
    ).toHaveLength(0);
  });

  test("rule without match matches all events of that type", () => {
    const ruleset = compile([
      {
        name: "r1",
        on: "turn_complete",
        actions: [{ type: "log", level: "info", message: "always" }],
      },
    ]);
    const engine = createRuleEngine(ruleset);

    expect(engine.evaluate(makeEvent("turn_complete", {})).actions).toHaveLength(1);
    expect(engine.evaluate(makeEvent("turn_complete", { anything: 123 })).actions).toHaveLength(1);
  });

  test("no rules for event type returns empty result", () => {
    const ruleset = compile([
      { name: "r1", on: "tool_call", actions: [{ type: "log", level: "info", message: "x" }] },
    ]);
    const engine = createRuleEngine(ruleset);

    const result = engine.evaluate(makeEvent("session_start", {}));
    expect(result.actions).toHaveLength(0);
    expect(result.skipToolIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stopOnMatch
// ---------------------------------------------------------------------------

describe("createRuleEngine — stopOnMatch", () => {
  test("stops evaluating after first matching rule with stopOnMatch", () => {
    const ruleset = compile([
      {
        name: "r1",
        on: "tool_call",
        actions: [{ type: "log", level: "info", message: "first" }],
        stopOnMatch: true,
      },
      { name: "r2", on: "tool_call", actions: [{ type: "log", level: "info", message: "second" }] },
    ]);
    const engine = createRuleEngine(ruleset);

    const result = engine.evaluate(makeEvent("tool_call", {}));
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.ruleName).toBe("r1");
  });

  test("evaluates all rules when stopOnMatch is false", () => {
    const ruleset = compile([
      { name: "r1", on: "tool_call", actions: [{ type: "log", level: "info", message: "first" }] },
      { name: "r2", on: "tool_call", actions: [{ type: "log", level: "info", message: "second" }] },
    ]);
    const engine = createRuleEngine(ruleset);

    const result = engine.evaluate(makeEvent("tool_call", {}));
    expect(result.actions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Counter / windowed conditions
// ---------------------------------------------------------------------------

describe("createRuleEngine — windowed conditions", () => {
  test("does not trigger until count threshold is reached", () => {
    const ruleset = compile([
      {
        name: "r1",
        on: "tool_call",
        match: { ok: false },
        condition: { count: 3, window: "1m" },
        actions: [{ type: "escalate", message: "fail" }],
      },
    ]);

    // let justified: mutable clock for test injection
    let clock = 1000;
    const engine = createRuleEngine(ruleset, () => clock);
    const event = makeEvent("tool_call", { ok: false });

    expect(engine.evaluate(event).actions).toHaveLength(0); // 1st
    clock += 1000;
    expect(engine.evaluate(event).actions).toHaveLength(0); // 2nd
    clock += 1000;
    expect(engine.evaluate(event).actions).toHaveLength(1); // 3rd — triggers
  });

  test("expired entries are pruned from counter window", () => {
    const ruleset = compile([
      {
        name: "r1",
        on: "tool_call",
        match: { ok: false },
        condition: { count: 3, window: "10s" },
        actions: [{ type: "escalate", message: "fail" }],
      },
    ]);

    // let justified: mutable clock for test injection
    let clock = 1000;
    const engine = createRuleEngine(ruleset, () => clock);
    const event = makeEvent("tool_call", { ok: false });

    engine.evaluate(event); // 1st at t=1000
    clock += 1000;
    engine.evaluate(event); // 2nd at t=2000

    // Jump past window — both entries expire
    clock = 20_000;
    expect(engine.evaluate(event).actions).toHaveLength(0); // Only 1 in window
  });

  test("reset clears all counter state", () => {
    const ruleset = compile([
      {
        name: "r1",
        on: "tool_call",
        match: { ok: false },
        condition: { count: 2, window: "1m" },
        actions: [{ type: "escalate", message: "fail" }],
      },
    ]);

    const engine = createRuleEngine(ruleset, () => 1000);
    const event = makeEvent("tool_call", { ok: false });

    engine.evaluate(event); // 1st
    engine.reset();
    expect(engine.evaluate(event).actions).toHaveLength(0); // 1st again after reset
  });
});

// ---------------------------------------------------------------------------
// skip_tool action
// ---------------------------------------------------------------------------

describe("createRuleEngine — skip_tool", () => {
  test("collects skipToolIds from skip_tool actions", () => {
    const ruleset = compile([
      { name: "r1", on: "tool_call", actions: [{ type: "skip_tool", toolId: "shell_exec" }] },
    ]);
    const engine = createRuleEngine(ruleset);

    const result = engine.evaluate(makeEvent("tool_call", {}));
    expect(result.skipToolIds).toEqual(["shell_exec"]);
  });
});
