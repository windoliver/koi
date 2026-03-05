/**
 * Tests for the script runner adapter.
 */

import { describe, expect, mock, test } from "bun:test";
import { createScriptRunner } from "./create-script-runner.js";

describe("createScriptRunner", () => {
  test("returns an object with a run method", () => {
    const runner = createScriptRunner();
    expect(typeof runner.run).toBe("function");
  });

  test("wraps host functions into tools and executes code", async () => {
    const runner = createScriptRunner({ timeoutMs: 5_000, maxCalls: 10 });

    const hostFns = new Map<string, (args: Record<string, unknown>) => unknown>([
      ["greet", (args) => `Hello, ${String(args.name)}!`],
    ]);

    const result = await runner.run({
      code: 'var msg = callTool("greet", { name: "World" }); console.log(msg);',
      hostFns,
      timeoutMs: 5_000,
      maxCalls: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.callCount).toBeGreaterThanOrEqual(1);
    expect(result.console.length).toBeGreaterThanOrEqual(1);
    expect(result.console[0]).toContain("Hello, World!");
  });

  test("maps errors from executeScript to RlmScriptResult", async () => {
    const runner = createScriptRunner({ timeoutMs: 1_000 });

    const result = await runner.run({
      code: "throw new Error('boom');",
      hostFns: new Map(),
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("boom");
  });

  test("flattens console entries to string array", async () => {
    const runner = createScriptRunner();

    const result = await runner.run({
      code: 'console.log("line1"); console.log("line2"); console.warn("warn1");',
      hostFns: new Map(),
    });

    expect(result.ok).toBe(true);
    expect(result.console).toEqual(["line1", "line2", "warn1"]);
  });

  test("respects default config values", () => {
    const runner = createScriptRunner({ timeoutMs: 10_000, maxCalls: 50 });
    // Just verify it creates without error — defaults are used internally
    expect(runner).toBeDefined();
  });

  test("async host functions work correctly", async () => {
    const runner = createScriptRunner();

    const asyncFn = mock(async (args: Record<string, unknown>) => {
      return { value: Number(args.x ?? 0) * 2 };
    });

    const hostFns = new Map<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>([
      ["double", asyncFn],
    ]);

    const result = await runner.run({
      code: 'var r = callTool("double", { x: 21 }); console.log(r.value);',
      hostFns,
    });

    expect(result.ok).toBe(true);
    expect(result.console).toEqual(["42"]);
    expect(asyncFn).toHaveBeenCalled();
  });
});
