import { describe, expect, test } from "bun:test";
import { createKeywordDriftDetector } from "./keyword-drift.js";

const detector = createKeywordDriftDetector();

async function decide(text: string): Promise<{ readonly drifted: boolean }> {
  return detector.detect(text, []);
}

describe("createKeywordDriftDetector", () => {
  test("detects 'switch to'", async () => {
    expect((await decide("Let's switch to YAML")).drifted).toBe(true);
  });
  test("detects 'use X instead'", async () => {
    expect((await decide("Use JSON instead")).drifted).toBe(true);
  });
  test("detects 'no longer'", async () => {
    expect((await decide("we no longer need that flag")).drifted).toBe(true);
  });
  test("ignores unrelated text", async () => {
    expect((await decide("the weather is nice")).drifted).toBe(false);
  });
  test("captures new value when present", async () => {
    const r = await detector.detect("switch to rust", []);
    expect(r.drifted).toBe(true);
    expect(r.newValue).toBe("rust");
  });
});
