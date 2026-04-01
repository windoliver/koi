import { describe, expect, test } from "bun:test";
import { createCascadedDriftDetector } from "./cascaded-drift.js";

describe("createCascadedDriftDetector", () => {
  test("skips LLM when keyword detector returns no_drift", async () => {
    let llmCalled = false; // let: tracking flag
    const classify = async (_prompt: string): Promise<string> => {
      llmCalled = true;
      return "YES: old=tabs new=spaces";
    };

    const detector = createCascadedDriftDetector(classify);
    const result = await detector.detect("Thanks, that looks good!");

    expect(result.kind).toBe("no_drift");
    expect(llmCalled).toBe(false);
  });

  test("calls LLM when keyword detector finds drift", async () => {
    let llmCalled = false; // let: tracking flag
    const classify = async (_prompt: string): Promise<string> => {
      llmCalled = true;
      return "YES: old=tabs new=spaces";
    };

    const detector = createCascadedDriftDetector(classify);
    const result = await detector.detect("I no longer want tabs");

    expect(result.kind).toBe("drift_detected");
    expect(llmCalled).toBe(true);
    if (result.kind === "drift_detected") {
      expect(result.oldPreference).toBe("tabs");
      expect(result.newPreference).toBe("spaces");
    }
  });

  test("LLM returns NO → overrides keyword match", async () => {
    const classify = async (_prompt: string): Promise<string> => "NO";
    const detector = createCascadedDriftDetector(classify);
    const result = await detector.detect("I no longer need this section");

    expect(result.kind).toBe("no_drift");
  });

  test("LLM throws → fail-closed (assume drift)", async () => {
    const classify = async (_prompt: string): Promise<string> => {
      throw new Error("API down");
    };
    const detector = createCascadedDriftDetector(classify);
    const result = await detector.detect("I no longer want this");

    expect(result.kind).toBe("drift_detected");
  });
});
