import { describe, expect, test } from "bun:test";
import type { TurnContext } from "@koi/core/middleware";
import { createLlmDriftDetector } from "./llm-drift.js";

const STUB_CTX = {} as TurnContext;

describe("createLlmDriftDetector", () => {
  test("returns drift_detected with old/new when classifier says YES", async () => {
    const classify = async (_prompt: string): Promise<string> =>
      "YES: old=dark mode new=light mode";

    const detector = createLlmDriftDetector(classify);
    const result = await detector.detect("I now prefer light mode", STUB_CTX);

    expect(result).toEqual({
      kind: "drift_detected",
      oldPreference: "dark mode",
      newPreference: "light mode",
    });
  });

  test("returns no_drift when classifier says NO", async () => {
    const classify = async (_prompt: string): Promise<string> => "NO";

    const detector = createLlmDriftDetector(classify);
    const result = await detector.detect("Sounds good, thanks!", STUB_CTX);

    expect(result).toEqual({ kind: "no_drift" });
  });

  test("returns drift_detected on malformed response (fail-closed)", async () => {
    const classify = async (_prompt: string): Promise<string> => "I'm not sure what you mean";

    const detector = createLlmDriftDetector(classify);
    const result = await detector.detect("changed my mind", STUB_CTX);

    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "I'm not sure what you mean",
    });
  });

  test("returns drift_detected when classifier throws (fail-closed)", async () => {
    const classify = async (_prompt: string): Promise<string> => {
      throw new Error("API timeout");
    };

    const detector = createLlmDriftDetector(classify);
    const result = await detector.detect("switch to vim", STUB_CTX);

    expect(result).toEqual({
      kind: "drift_detected",
      newPreference: "switch to vim",
    });
  });
});
