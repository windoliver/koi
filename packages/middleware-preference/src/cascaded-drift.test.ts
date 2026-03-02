import { describe, expect, test } from "bun:test";
import type { TurnContext } from "@koi/core/middleware";
import { createCascadedDriftDetector } from "./cascaded-drift.js";

const STUB_CTX = {} as TurnContext;

describe("createCascadedDriftDetector", () => {
  test("skips LLM when keyword detector returns no_drift", async () => {
    // let — needed to track call count
    let llmCalled = false;
    const classify = async (_prompt: string): Promise<string> => {
      llmCalled = true;
      return "YES: old=x new=y";
    };

    const detector = createCascadedDriftDetector(classify);
    const result = await detector.detect("Sounds good, thanks!", STUB_CTX);

    expect(result).toEqual({ kind: "no_drift" });
    expect(llmCalled).toBe(false);
  });

  test("calls LLM when keyword matches, returns LLM confirmation", async () => {
    const classify = async (_prompt: string): Promise<string> =>
      "YES: old=dark mode new=light mode";

    const detector = createCascadedDriftDetector(classify);
    const result = await detector.detect("I no longer want dark mode", STUB_CTX);

    expect(result).toEqual({
      kind: "drift_detected",
      oldPreference: "dark mode",
      newPreference: "light mode",
    });
  });

  test("calls LLM when keyword matches, LLM denies drift", async () => {
    const classify = async (_prompt: string): Promise<string> => "NO";

    const detector = createCascadedDriftDetector(classify);
    const result = await detector.detect("I no longer need the docs for this", STUB_CTX);

    expect(result).toEqual({ kind: "no_drift" });
  });

  test("returns drift_detected when LLM throws (fail-closed)", async () => {
    const classify = async (_prompt: string): Promise<string> => {
      throw new Error("Network error");
    };

    const detector = createCascadedDriftDetector(classify);
    const result = await detector.detect("I no longer want that", STUB_CTX);

    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "I no longer want that",
    });
  });
});
