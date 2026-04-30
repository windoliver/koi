import { describe, expect, test } from "bun:test";
import { exactMatch } from "./graders/exact-match.js";
import { toolCall } from "./graders/tool-call.js";
import { computeTaskFingerprint } from "./runner.js";
import type { EvalTask } from "./types.js";

const baseInput = { kind: "text" as const, text: "hi" };

describe("computeTaskFingerprint", () => {
  test("changes when input changes", () => {
    const a: EvalTask = { id: "t", name: "t", input: baseInput, graders: [exactMatch()] };
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: { kind: "text", text: "hello" },
      graders: [exactMatch()],
    };
    expect(computeTaskFingerprint(a)).not.toBe(computeTaskFingerprint(b));
  });

  test("changes when expected pattern (string) changes", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      expected: { kind: "text", pattern: "x" },
      graders: [exactMatch()],
    };
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      expected: { kind: "text", pattern: "y" },
      graders: [exactMatch()],
    };
    expect(computeTaskFingerprint(a)).not.toBe(computeTaskFingerprint(b));
  });

  test("changes when expected RegExp source changes", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      expected: { kind: "text", pattern: /foo/ },
      graders: [exactMatch()],
    };
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      expected: { kind: "text", pattern: /bar/ },
      graders: [exactMatch()],
    };
    expect(computeTaskFingerprint(a)).not.toBe(computeTaskFingerprint(b));
  });

  test("changes when expected RegExp flags change", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      expected: { kind: "text", pattern: /foo/ },
      graders: [exactMatch()],
    };
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      expected: { kind: "text", pattern: /foo/i },
      graders: [exactMatch()],
    };
    expect(computeTaskFingerprint(a)).not.toBe(computeTaskFingerprint(b));
  });

  test("changes when grader fallback pattern changes", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      graders: [exactMatch({ pattern: "alpha" })],
    };
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      graders: [exactMatch({ pattern: "beta" })],
    };
    expect(computeTaskFingerprint(a)).not.toBe(computeTaskFingerprint(b));
  });

  test("changes when toolCall order changes", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      graders: [toolCall({ order: "any" })],
    };
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      graders: [toolCall({ order: "strict" })],
    };
    expect(computeTaskFingerprint(a)).not.toBe(computeTaskFingerprint(b));
  });

  test("changes when toolCall calls differ", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      graders: [toolCall({ calls: [{ toolName: "x" }] })],
    };
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      graders: [toolCall({ calls: [{ toolName: "y" }] })],
    };
    expect(computeTaskFingerprint(a)).not.toBe(computeTaskFingerprint(b));
  });

  test("changes when task trialCount changes", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      graders: [exactMatch()],
      trialCount: 1,
    };
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      graders: [exactMatch()],
      trialCount: 10,
    };
    expect(computeTaskFingerprint(a)).not.toBe(computeTaskFingerprint(b));
  });

  test("changes when per-task timeoutMs changes", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      graders: [exactMatch()],
      timeoutMs: 1_000,
    };
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: baseInput,
      graders: [exactMatch()],
      timeoutMs: 60_000,
    };
    expect(computeTaskFingerprint(a)).not.toBe(computeTaskFingerprint(b));
  });

  test("rejects Map/Set/class instances without salt", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      input: { ...baseInput, ctx: new Map([["k", 1]]) } as never,
      graders: [exactMatch()],
    };
    expect(() => computeTaskFingerprint(a)).toThrow(/fingerprintSalt/);
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: { ...baseInput, ctx: new Set([1, 2]) } as never,
      graders: [exactMatch()],
    };
    expect(() => computeTaskFingerprint(b)).toThrow(/fingerprintSalt/);
  });

  test("Date and URL inputs distinguish different values", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      input: { ...baseInput, when: new Date("2026-01-01T00:00:00Z") } as never,
      graders: [exactMatch()],
    };
    const b: EvalTask = {
      id: "t",
      name: "t",
      input: { ...baseInput, when: new Date("2026-02-01T00:00:00Z") } as never,
      graders: [exactMatch()],
    };
    expect(computeTaskFingerprint(a)).not.toBe(computeTaskFingerprint(b));
  });

  test("throws when input contains a function value and no salt is set", () => {
    const a: EvalTask = {
      id: "t",
      name: "t",
      // EngineInput shapes can carry callHandlers etc. Function identity
      // determines runtime behavior but cannot be hashed safely.
      input: { ...baseInput, callHandlers: { foo: () => undefined } } as never,
      graders: [exactMatch()],
    };
    expect(() => computeTaskFingerprint(a)).toThrow(/fingerprintSalt/);
  });

  test("salt distinguishes input variants with the same shape", () => {
    const make = (salt: string): EvalTask => ({
      id: "t",
      name: "t",
      input: { ...baseInput, callHandlers: { foo: () => undefined } } as never,
      graders: [exactMatch()],
      fingerprintSalt: salt,
    });
    expect(computeTaskFingerprint(make("v1"))).not.toBe(computeTaskFingerprint(make("v2")));
  });

  test("stable for equivalent task definitions", () => {
    const make = (): EvalTask => ({
      id: "t",
      name: "t",
      input: baseInput,
      expected: { kind: "text", pattern: /hi/i },
      graders: [exactMatch({ pattern: "hi" })],
    });
    expect(computeTaskFingerprint(make())).toBe(computeTaskFingerprint(make()));
  });
});
