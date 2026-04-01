import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createMockEngineAdapter } from "@koi/test-utils";
import { runEngineChecks } from "./engine-checks.js";

const TIMEOUT = 5_000;

describe("runEngineChecks", () => {
  test("all checks pass for a valid mock adapter (instance)", async () => {
    const adapter = createMockEngineAdapter();
    const results = await runEngineChecks(adapter, TIMEOUT);
    // resolve + engineId + stream callable + stream done + output valid = 5
    // No dispose check (instance mode)
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.status).toBe("pass");
      expect(r.category).toBe("engine");
    }
  });

  test("all checks pass for a valid mock adapter (factory)", async () => {
    const factory = () => createMockEngineAdapter();
    const results = await runEngineChecks(factory, TIMEOUT);
    // resolve + engineId + stream callable + stream done + output valid + dispose = 6
    expect(results).toHaveLength(6);
    for (const r of results) {
      expect(r.status).toBe("pass");
    }
  });

  test("skips all checks when factory throws", async () => {
    const factory = () => {
      throw new Error("factory boom");
    };
    const results = await runEngineChecks(factory, TIMEOUT);
    // resolve (fail) + 4 skips + dispose skip = 6
    expect(results).toHaveLength(6);
    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.error?.message).toBe("factory boom");
    for (const r of results.slice(1)) {
      expect(r.status).toBe("skip");
    }
  });

  test("fails when adapter has empty engineId", async () => {
    const adapter = createMockEngineAdapter({ engineId: "" });
    const results = await runEngineChecks(adapter, TIMEOUT);
    const idCheck = results.find((r) => r.name.includes("engineId"));
    expect(idCheck?.status).toBe("fail");
  });

  test("fails when stream yields no done event", async () => {
    const events: readonly EngineEvent[] = [{ kind: "text_delta", delta: "hello" }];
    const adapter = createMockEngineAdapter({ events });
    const results = await runEngineChecks(adapter, TIMEOUT);
    const streamCheck = results.find((r) => r.name.includes("stream yields done"));
    expect(streamCheck?.status).toBe("fail");
    expect(streamCheck?.error?.message).toContain("done event");
  });

  test("skips output validation when stream check fails", async () => {
    const events: readonly EngineEvent[] = [{ kind: "text_delta", delta: "no done" }];
    const adapter = createMockEngineAdapter({ events });
    const results = await runEngineChecks(adapter, TIMEOUT);
    const outputCheck = results.find((r) => r.name.includes("done output is valid"));
    expect(outputCheck?.status).toBe("skip");
  });

  test("dispose check runs for factory adapter", async () => {
    const adapter = createMockEngineAdapter();
    const factory = () => adapter;
    const results = await runEngineChecks(factory, TIMEOUT);
    const disposeCheck = results.find((r) => r.name.includes("dispose completes"));
    expect(disposeCheck?.status).toBe("pass");
    expect(adapter.disposeCalls.length).toBe(1);
  });

  test("no dispose check for instance adapter", async () => {
    const adapter = createMockEngineAdapter();
    const results = await runEngineChecks(adapter, TIMEOUT);
    const disposeCheck = results.find((r) => r.name.includes("dispose"));
    expect(disposeCheck).toBeUndefined();
  });
});
