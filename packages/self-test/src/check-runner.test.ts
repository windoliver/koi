import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput } from "@koi/core";
import { collectEvents, extractText, runCheck, skipCheck } from "./check-runner.js";

describe("runCheck", () => {
  test("returns pass for a check that succeeds", async () => {
    const result = await runCheck("test-pass", "manifest", () => {}, 5_000);
    expect(result.status).toBe("pass");
    expect(result.name).toBe("test-pass");
    expect(result.category).toBe("manifest");
    expect(typeof result.durationMs).toBe("number");
    expect(result.error).toBeUndefined();
  });

  test("returns pass for an async check that resolves", async () => {
    const result = await runCheck(
      "async-pass",
      "tools",
      async () => {
        await Promise.resolve();
      },
      5_000,
    );
    expect(result.status).toBe("pass");
  });

  test("returns fail for a check that throws synchronously", async () => {
    const result = await runCheck(
      "sync-throw",
      "middleware",
      () => {
        throw new Error("deliberate failure");
      },
      5_000,
    );
    expect(result.status).toBe("fail");
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("INTERNAL");
    expect(result.error?.message).toBe("deliberate failure");
    expect(result.message).toBe("deliberate failure");
  });

  test("returns fail for a check that rejects", async () => {
    const result = await runCheck(
      "async-reject",
      "engine",
      async () => {
        throw new Error("async failure");
      },
      5_000,
    );
    expect(result.status).toBe("fail");
    expect(result.error?.code).toBe("INTERNAL");
    expect(result.error?.message).toBe("async failure");
  });

  test("returns fail with TIMEOUT for a check that exceeds timeout", async () => {
    const result = await runCheck(
      "timeout-check",
      "engine",
      () => new Promise(() => {}), // never resolves
      10,
    );
    expect(result.status).toBe("fail");
    expect(result.error?.code).toBe("TIMEOUT");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).toContain("timed out");
  });

  test("tracks duration for successful checks", async () => {
    const result = await runCheck(
      "timed-check",
      "manifest",
      async () => {
        await Bun.sleep(10);
      },
      5_000,
    );
    expect(result.durationMs).toBeGreaterThanOrEqual(5);
  });

  test("tracks duration for failed checks", async () => {
    const result = await runCheck(
      "failed-timed",
      "manifest",
      async () => {
        await Bun.sleep(10);
        throw new Error("fail after delay");
      },
      5_000,
    );
    expect(result.status).toBe("fail");
    expect(result.durationMs).toBeGreaterThanOrEqual(5);
  });

  test("handles non-Error throws gracefully", async () => {
    const result = await runCheck(
      "string-throw",
      "tools",
      () => {
        throw "plain string error";
      },
      5_000,
    );
    expect(result.status).toBe("fail");
    expect(result.error?.message).toBe("plain string error");
  });
});

describe("collectEvents", () => {
  test("collects events from async iterable", async () => {
    const output: EngineOutput = {
      content: [],
      stopReason: "completed",
      metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
    };
    async function* gen(): AsyncIterable<EngineEvent> {
      yield { kind: "text_delta", delta: "hello" };
      yield { kind: "done", output };
    }

    const events = await collectEvents(gen());
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("text_delta");
    expect(events[1]?.kind).toBe("done");
  });

  test("returns empty array for empty iterable", async () => {
    async function* gen(): AsyncIterable<EngineEvent> {
      // yields nothing
    }
    const events = await collectEvents(gen());
    expect(events).toHaveLength(0);
  });
});

describe("extractText", () => {
  test("concatenates text_delta events", () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "hello " },
      { kind: "text_delta", delta: "world" },
    ];
    expect(extractText(events)).toBe("hello world");
  });

  test("ignores non-text_delta events", () => {
    const output: EngineOutput = {
      content: [],
      stopReason: "completed",
      metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
    };
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "hello" },
      { kind: "done", output },
    ];
    expect(extractText(events)).toBe("hello");
  });

  test("returns empty string for no text events", () => {
    const output: EngineOutput = {
      content: [],
      stopReason: "completed",
      metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
    };
    const events: readonly EngineEvent[] = [{ kind: "done", output }];
    expect(extractText(events)).toBe("");
  });
});

describe("skipCheck", () => {
  test("creates a skip result with correct fields", () => {
    const result = skipCheck("skipped-check", "engine", "no adapter");
    expect(result.status).toBe("skip");
    expect(result.name).toBe("skipped-check");
    expect(result.category).toBe("engine");
    expect(result.message).toBe("no adapter");
    expect(result.durationMs).toBe(0);
  });
});
