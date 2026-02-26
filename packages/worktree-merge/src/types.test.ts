import { describe, expect, it } from "bun:test";
import type { MergeConfig } from "./types.js";
import { validateMergeConfig } from "./types.js";

const BASE_CONFIG: MergeConfig = {
  repoPath: "/tmp/repo",
  targetBranch: "main",
  branches: [],
  strategy: "sequential",
};

describe("validateMergeConfig", () => {
  it("accepts empty branches", () => {
    const result = validateMergeConfig(BASE_CONFIG);
    expect(result.ok).toBe(true);
  });

  it("accepts valid config with branches", () => {
    const result = validateMergeConfig({
      ...BASE_CONFIG,
      branches: [
        { name: "a", dependsOn: [] },
        { name: "b", dependsOn: ["a"] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing repoPath", () => {
    const result = validateMergeConfig({
      ...BASE_CONFIG,
      repoPath: "",
      branches: [{ name: "a", dependsOn: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("repoPath");
    }
  });

  it("rejects missing targetBranch", () => {
    const result = validateMergeConfig({
      ...BASE_CONFIG,
      targetBranch: "",
      branches: [{ name: "a", dependsOn: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("targetBranch");
    }
  });

  it("rejects dependency on unknown branch", () => {
    const result = validateMergeConfig({
      ...BASE_CONFIG,
      branches: [{ name: "a", dependsOn: ["nonexistent"] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("nonexistent");
    }
  });
});
