import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "./config.js";
import type { ForgeInput, StageReport } from "./types.js";
import { assignTrust } from "./verify-trust.js";

const validInput: ForgeInput = {
  kind: "tool",
  name: "myTool",
  description: "A tool",
  inputSchema: { type: "object" },
  implementation: "return 1;",
};

const passingStages: readonly StageReport[] = [
  { stage: "static", passed: true, durationMs: 1 },
  { stage: "sandbox", passed: true, durationMs: 2 },
  { stage: "self_test", passed: true, durationMs: 3 },
];

describe("assignTrust", () => {
  test("assigns default trust tier from config", () => {
    const config = createDefaultForgeConfig();
    const result = assignTrust(validInput, config, passingStages);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trustTier).toBe("sandbox");
      expect(result.value.passed).toBe(true);
      expect(result.value.stage).toBe("trust");
    }
  });

  test("caps trust at verified when config says promoted", () => {
    const config = createDefaultForgeConfig({ defaultTrustTier: "promoted" });
    const result = assignTrust(validInput, config, passingStages);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trustTier).toBe("verified");
    }
  });

  test("assigns verified when config says verified", () => {
    const config = createDefaultForgeConfig({ defaultTrustTier: "verified" });
    const result = assignTrust(validInput, config, passingStages);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trustTier).toBe("verified");
    }
  });

  test("rejects when a prior stage failed", () => {
    const config = createDefaultForgeConfig();
    const failedStages: readonly StageReport[] = [
      { stage: "static", passed: true, durationMs: 1 },
      { stage: "sandbox", passed: false, durationMs: 2, message: "crashed" },
    ];
    const result = assignTrust(validInput, config, failedStages);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("trust");
    }
  });

  test("includes durationMs in report", () => {
    const config = createDefaultForgeConfig();
    const result = assignTrust(validInput, config, passingStages);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
