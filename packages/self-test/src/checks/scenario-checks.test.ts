import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineInput, EngineOutput } from "@koi/core";
import { createMockEngineAdapter } from "@koi/test-utils";
import type { SelfTestScenario } from "../types.js";
import { runScenarioChecks } from "./scenario-checks.js";

const TIMEOUT = 5_000;

const DEFAULT_OUTPUT: EngineOutput = {
  content: [{ kind: "text", text: "pong" }],
  stopReason: "completed",
  metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
};

const DEFAULT_EVENTS: readonly EngineEvent[] = [
  { kind: "text_delta", delta: "pong" },
  { kind: "done", output: DEFAULT_OUTPUT },
];

const PING_INPUT: EngineInput = { kind: "text", text: "ping" };

describe("runScenarioChecks", () => {
  test("returns skip when no scenarios provided", async () => {
    const adapter = createMockEngineAdapter();
    const results = await runScenarioChecks(adapter, [], TIMEOUT);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("skip");
  });

  test("passes for a scenario that completes with done event", async () => {
    const adapter = createMockEngineAdapter({ events: [...DEFAULT_EVENTS] });
    const scenario: SelfTestScenario = { name: "ping-pong", input: PING_INPUT };
    const results = await runScenarioChecks(adapter, [scenario], TIMEOUT);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
  });

  test("passes when expected pattern matches", async () => {
    const adapter = createMockEngineAdapter({ events: [...DEFAULT_EVENTS] });
    const scenario: SelfTestScenario = {
      name: "pattern-match",
      input: PING_INPUT,
      expectedPattern: "pong",
    };
    const results = await runScenarioChecks(adapter, [scenario], TIMEOUT);
    expect(results[0]?.status).toBe("pass");
  });

  test("fails when expected pattern does not match", async () => {
    const adapter = createMockEngineAdapter({ events: [...DEFAULT_EVENTS] });
    const scenario: SelfTestScenario = {
      name: "pattern-miss",
      input: PING_INPUT,
      expectedPattern: "notfound",
    };
    const results = await runScenarioChecks(adapter, [scenario], TIMEOUT);
    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.error?.message).toContain("did not match");
  });

  test("passes when regex pattern matches", async () => {
    const adapter = createMockEngineAdapter({ events: [...DEFAULT_EVENTS] });
    const scenario: SelfTestScenario = {
      name: "regex-match",
      input: PING_INPUT,
      expectedPattern: /p.ng/,
    };
    const results = await runScenarioChecks(adapter, [scenario], TIMEOUT);
    expect(results[0]?.status).toBe("pass");
  });

  test("passes when custom assertion succeeds", async () => {
    const adapter = createMockEngineAdapter({ events: [...DEFAULT_EVENTS] });
    const scenario: SelfTestScenario = {
      name: "custom-assert",
      input: PING_INPUT,
      assert(events) {
        if (events.length < 2) throw new Error("too few events");
      },
    };
    const results = await runScenarioChecks(adapter, [scenario], TIMEOUT);
    expect(results[0]?.status).toBe("pass");
  });

  test("fails when custom assertion throws", async () => {
    const adapter = createMockEngineAdapter({ events: [...DEFAULT_EVENTS] });
    const scenario: SelfTestScenario = {
      name: "custom-assert-fail",
      input: PING_INPUT,
      assert() {
        throw new Error("assertion failed");
      },
    };
    const results = await runScenarioChecks(adapter, [scenario], TIMEOUT);
    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.error?.message).toBe("assertion failed");
  });

  test("fails when stream yields no done event", async () => {
    const events: readonly EngineEvent[] = [{ kind: "text_delta", delta: "no done" }];
    const adapter = createMockEngineAdapter({ events: [...events] });
    const scenario: SelfTestScenario = { name: "no-done", input: PING_INPUT };
    const results = await runScenarioChecks(adapter, [scenario], TIMEOUT);
    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.error?.message).toContain("done event");
  });

  test("disposes factory-created adapters", async () => {
    const adapter = createMockEngineAdapter({ events: [...DEFAULT_EVENTS] });
    const factory = () => adapter;
    const scenario: SelfTestScenario = { name: "dispose-test", input: PING_INPUT };
    const results = await runScenarioChecks(factory, [scenario], TIMEOUT);
    expect(results[0]?.status).toBe("pass");
    expect(adapter.disposeCalls.length).toBe(1);
  });

  test("handles multiple scenarios", async () => {
    const adapter = createMockEngineAdapter({ events: [...DEFAULT_EVENTS] });
    const scenarios: readonly SelfTestScenario[] = [
      { name: "scenario-a", input: PING_INPUT },
      { name: "scenario-b", input: PING_INPUT },
    ];
    const results = await runScenarioChecks(adapter, scenarios, TIMEOUT);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });
});
