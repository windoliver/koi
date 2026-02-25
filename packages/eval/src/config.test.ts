import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  validateEvalConfig,
} from "./config.js";

const VALID_TASK = {
  id: "t1",
  name: "test task",
  input: { kind: "text" as const, text: "hello" },
  graders: [
    { id: "g1", name: "test grader", grade: () => ({ graderId: "g1", score: 1, pass: true }) },
  ],
};

const VALID_CONFIG = {
  name: "test-eval",
  tasks: [VALID_TASK],
  agentFactory: async () => ({
    stream: async function* () {
      yield {
        kind: "done" as const,
        output: {
          content: [],
          stopReason: "completed" as const,
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
        },
      };
    },
  }),
};

describe("validateEvalConfig", () => {
  test("accepts valid config", () => {
    const result = validateEvalConfig(VALID_CONFIG);
    expect(result.ok).toBe(true);
  });

  test("rejects non-object config", () => {
    const result = validateEvalConfig("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("non-null object");
    }
  });

  test("rejects null config", () => {
    const result = validateEvalConfig(null);
    expect(result.ok).toBe(false);
  });

  test("rejects empty name", () => {
    const result = validateEvalConfig({ ...VALID_CONFIG, name: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("name");
    }
  });

  test("rejects missing tasks", () => {
    const result = validateEvalConfig({ ...VALID_CONFIG, tasks: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("tasks");
    }
  });

  test("rejects task without id", () => {
    const result = validateEvalConfig({
      ...VALID_CONFIG,
      tasks: [{ ...VALID_TASK, id: "" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("id");
    }
  });

  test("rejects task without name", () => {
    const result = validateEvalConfig({
      ...VALID_CONFIG,
      tasks: [{ ...VALID_TASK, name: "" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("name");
    }
  });

  test("rejects task without valid input", () => {
    const result = validateEvalConfig({
      ...VALID_CONFIG,
      tasks: [{ ...VALID_TASK, input: "not an object" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("input");
    }
  });

  test("rejects task with empty graders", () => {
    const result = validateEvalConfig({
      ...VALID_CONFIG,
      tasks: [{ ...VALID_TASK, graders: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("graders");
    }
  });

  test("rejects task with invalid trialCount", () => {
    const result = validateEvalConfig({
      ...VALID_CONFIG,
      tasks: [{ ...VALID_TASK, trialCount: 0 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("trialCount");
    }
  });

  test("rejects task with invalid timeoutMs", () => {
    const result = validateEvalConfig({
      ...VALID_CONFIG,
      tasks: [{ ...VALID_TASK, timeoutMs: -1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timeoutMs");
    }
  });

  test("rejects missing agentFactory", () => {
    const { agentFactory: _, ...noFactory } = VALID_CONFIG;
    const result = validateEvalConfig(noFactory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("agentFactory");
    }
  });

  test("rejects invalid concurrency", () => {
    const result = validateEvalConfig({ ...VALID_CONFIG, concurrency: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("concurrency");
    }
  });

  test("rejects invalid passThreshold", () => {
    const result = validateEvalConfig({ ...VALID_CONFIG, passThreshold: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("passThreshold");
    }
  });

  test("rejects non-function onTrialComplete", () => {
    const result = validateEvalConfig({
      ...VALID_CONFIG,
      onTrialComplete: "not a function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("onTrialComplete");
    }
  });
});

describe("defaults", () => {
  test("DEFAULT_CONCURRENCY is 5", () => {
    expect(DEFAULT_CONCURRENCY).toBe(5);
  });

  test("DEFAULT_TIMEOUT_MS is 60_000", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
  });

  test("DEFAULT_PASS_THRESHOLD is 0.5", () => {
    expect(DEFAULT_PASS_THRESHOLD).toBe(0.5);
  });
});
