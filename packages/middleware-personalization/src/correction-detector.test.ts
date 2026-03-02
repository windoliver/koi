import { describe, expect, test } from "bun:test";
import { createDefaultCorrectionDetector } from "./correction-detector.js";

describe("createDefaultCorrectionDetector", () => {
  const detector = createDefaultCorrectionDetector();

  test("detects 'No, I prefer' as correction", async () => {
    const result = await detector.detect("No, I prefer dark mode", []);
    expect(result.corrective).toBe(true);
    expect(result.preferenceUpdate).toContain("dark mode");
  });

  test("detects 'Actually, use TypeScript'", async () => {
    const result = await detector.detect("Actually, use TypeScript", []);
    expect(result.corrective).toBe(true);
    expect(result.preferenceUpdate).toContain("TypeScript");
  });

  test("detects 'I prefer' mid-sentence", async () => {
    const result = await detector.detect("For this project I prefer tabs", []);
    expect(result.corrective).toBe(true);
    expect(result.preferenceUpdate).toContain("tabs");
  });

  test("detects 'I meant' correction", async () => {
    const result = await detector.detect("I meant the other file", []);
    expect(result.corrective).toBe(true);
  });

  test("detects 'please use' correction", async () => {
    const result = await detector.detect("please use Bun instead", []);
    expect(result.corrective).toBe(true);
  });

  test("detects 'change to' correction", async () => {
    const result = await detector.detect("change to snake_case", []);
    expect(result.corrective).toBe(true);
  });

  test("detects 'switch to' correction", async () => {
    const result = await detector.detect("switch to dark mode", []);
    expect(result.corrective).toBe(true);
  });

  test("does not detect plain request as correction", async () => {
    const result = await detector.detect("Please refactor the auth module", []);
    expect(result.corrective).toBe(false);
  });

  test("does not detect question as correction", async () => {
    const result = await detector.detect("Can you explain this?", []);
    expect(result.corrective).toBe(false);
  });

  test("does not detect empty string as correction", async () => {
    const result = await detector.detect("", []);
    expect(result.corrective).toBe(false);
  });

  test("does not detect 'No problem' as correction", async () => {
    const result = await detector.detect("No problem, continue", []);
    expect(result.corrective).toBe(false);
  });

  test("does not detect 'No worries' as correction", async () => {
    const result = await detector.detect("No worries about that", []);
    expect(result.corrective).toBe(false);
  });

  test("does not detect 'No thanks' as correction", async () => {
    const result = await detector.detect("No thanks, I'm good", []);
    expect(result.corrective).toBe(false);
  });

  test("caps very long preference text", async () => {
    const longText = `Actually, ${"x".repeat(500)}`;
    const result = await detector.detect(longText, []);
    expect(result.corrective).toBe(true);
    expect((result.preferenceUpdate ?? "").length).toBeLessThanOrEqual(200);
  });
});
