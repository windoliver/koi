import { describe, expect, test } from "bun:test";
import { createDefaultCorrectionDetector } from "./correction-detector.js";

describe("createDefaultCorrectionDetector", () => {
  const detector = createDefaultCorrectionDetector();

  test("detects 'actually,' correction", () => {
    const result = detector.detect("Actually, use spaces instead of tabs", []);
    expect(result.corrective).toBe(true);
    expect(result.preferenceUpdate).toBeDefined();
  });

  test("detects 'I prefer' correction", () => {
    const result = detector.detect("I prefer dark mode for everything", []);
    expect(result.corrective).toBe(true);
  });

  test("detects 'switch to' correction", () => {
    const result = detector.detect("Switch to vim keybindings", []);
    expect(result.corrective).toBe(true);
  });

  test("returns false for normal message", () => {
    const result = detector.detect("Thanks, that looks great!", []);
    expect(result.corrective).toBe(false);
  });

  test("returns false for empty message", () => {
    const result = detector.detect("", []);
    expect(result.corrective).toBe(false);
  });

  test("filters false-positive 'no problem'", () => {
    const result = detector.detect("No problem, that works fine", []);
    expect(result.corrective).toBe(false);
  });

  test("filters false-positive 'no worries'", () => {
    const result = detector.detect("No worries about the format", []);
    expect(result.corrective).toBe(false);
  });

  test("caps preference text at 200 characters", () => {
    const longText = `Actually, ${"x".repeat(300)}`;
    const result = detector.detect(longText, []);
    expect(result.corrective).toBe(true);
    expect(result.preferenceUpdate?.length).toBeLessThanOrEqual(200);
  });
});
