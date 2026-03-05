import { describe, expect, test } from "bun:test";
import { createKeywordDriftDetector } from "./keyword-drift.js";

describe("createKeywordDriftDetector", () => {
  const detector = createKeywordDriftDetector();

  test("detects 'no longer'", () => {
    const result = detector.detect("I no longer want dark mode");
    expect(result.kind).toBe("drift_detected");
  });

  test("detects 'changed my mind'", () => {
    const result = detector.detect("I changed my mind about tabs");
    expect(result.kind).toBe("drift_detected");
  });

  test("detects 'prefer X instead'", () => {
    const result = detector.detect("I prefer spaces instead of tabs");
    expect(result.kind).toBe("drift_detected");
  });

  test("detects 'switch to'", () => {
    const result = detector.detect("Please switch to vim mode");
    expect(result.kind).toBe("drift_detected");
  });

  test("detects 'from now on'", () => {
    const result = detector.detect("From now on use camelCase");
    expect(result.kind).toBe("drift_detected");
  });

  test("returns no_drift for normal message", () => {
    const result = detector.detect("Thanks, that looks great!");
    expect(result.kind).toBe("no_drift");
  });

  test("supports additional patterns", () => {
    const custom = createKeywordDriftDetector({
      additionalPatterns: [/\bcustom\s+trigger\b/i],
    });
    const result = custom.detect("This has a custom trigger phrase");
    expect(result.kind).toBe("drift_detected");
  });

  test("additional patterns don't break defaults", () => {
    const custom = createKeywordDriftDetector({
      additionalPatterns: [/\bcustom\b/i],
    });
    const result = custom.detect("I no longer want this");
    expect(result.kind).toBe("drift_detected");
  });
});
