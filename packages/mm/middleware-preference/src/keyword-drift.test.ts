import { describe, expect, test } from "bun:test";
import type { TurnContext } from "@koi/core/middleware";
import { createKeywordDriftDetector } from "./keyword-drift.js";

const STUB_CTX = {} as TurnContext;

describe("createKeywordDriftDetector", () => {
  const detector = createKeywordDriftDetector();

  test("detects 'no longer' pattern", () => {
    const result = detector.detect("I no longer want dark mode", STUB_CTX);
    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "I no longer want dark mode",
    });
  });

  test("detects 'not anymore' pattern", () => {
    const result = detector.detect("I don't use TypeScript not anymore", STUB_CTX);
    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "I don't use TypeScript not anymore",
    });
  });

  test("detects 'changed my mind' pattern", () => {
    const result = detector.detect("I changed my mind about tabs", STUB_CTX);
    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "I changed my mind about tabs",
    });
  });

  test("detects 'prefer X instead' pattern", () => {
    const result = detector.detect("I prefer spaces instead", STUB_CTX);
    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "I prefer spaces instead",
    });
  });

  test("detects 'don't like/want/use' pattern", () => {
    const result = detector.detect("I don't want vim anymore", STUB_CTX);
    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "I don't want vim anymore",
    });
  });

  test("detects 'actually I want/prefer/use' pattern", () => {
    const result = detector.detect("actually I prefer Bun", STUB_CTX);
    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "actually I prefer Bun",
    });
  });

  test("detects 'switch to/from' pattern", () => {
    const result = detector.detect("Let's switch to pnpm", STUB_CTX);
    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "Let's switch to pnpm",
    });
  });

  test("detects 'from now on' pattern", () => {
    const result = detector.detect("From now on use 2-space indent", STUB_CTX);
    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "From now on use 2-space indent",
    });
  });

  test("returns no_drift for generic acknowledgment", () => {
    const result = detector.detect("Sounds good, thanks!", STUB_CTX);
    expect(result).toEqual({ kind: "no_drift" });
  });

  test("is case insensitive", () => {
    const result = detector.detect("I NO LONGER WANT THAT", STUB_CTX);
    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "I NO LONGER WANT THAT",
    });
  });

  test("supports additional custom patterns", () => {
    const custom = createKeywordDriftDetector({
      additionalPatterns: [/\bplease stop\b/i],
    });
    const result = custom.detect("please stop using semicolons", STUB_CTX);
    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "please stop using semicolons",
    });
  });
});
