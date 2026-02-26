/**
 * Tests for verify-resolve pipeline stage.
 */

import { describe, expect, test } from "bun:test";
import type { DependencyConfig } from "./config.js";
import type { ForgeInput, ResolveStageReport } from "./types.js";
import { verifyResolve } from "./verify-resolve.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_DEP_CONFIG: DependencyConfig = {
  maxDependencies: 20,
  installTimeoutMs: 15_000,
  maxCacheSizeBytes: 1_073_741_824,
  maxWorkspaceAgeDays: 30,
  maxTransitiveDependencies: 200,
};

function makeToolInput(overrides?: Partial<ForgeInput>): ForgeInput {
  return {
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    implementation: "return input;",
    inputSchema: { type: "object" },
    ...overrides,
  } as ForgeInput;
}

// ---------------------------------------------------------------------------
// Skip (no packages)
// ---------------------------------------------------------------------------

describe("verifyResolve (no packages)", () => {
  test("skips when no requires field", async () => {
    const input = makeToolInput();
    const result = await verifyResolve(input, DEFAULT_DEP_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stage).toBe("resolve");
      expect(result.value.passed).toBe(true);
      expect(result.value.message).toContain("skipped");
      expect(result.value.workspacePath).toBeUndefined();
    }
  });

  test("skips when requires has no packages", async () => {
    const input = makeToolInput({ requires: { bins: ["node"] } });
    const result = await verifyResolve(input, DEFAULT_DEP_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(true);
    }
  });

  test("skips when packages is empty object", async () => {
    const input = makeToolInput({ requires: { packages: {} } });
    const result = await verifyResolve(input, DEFAULT_DEP_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(true);
      expect(result.value.message).toContain("skipped");
    }
  });

  test("skips for skill kind", async () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "test-skill",
      description: "A test skill",
      body: "# Test",
    };
    const result = await verifyResolve(input, DEFAULT_DEP_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Audit failures
// ---------------------------------------------------------------------------

describe("verifyResolve (audit failures)", () => {
  test("fails when too many dependencies", async () => {
    const config: DependencyConfig = { ...DEFAULT_DEP_CONFIG, maxDependencies: 1 };
    const input = makeToolInput({
      requires: {
        packages: { a: "1.0.0", b: "2.0.0" },
      },
    });
    const result = await verifyResolve(input, config);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("resolve");
      expect(result.error.message).toContain("Too many dependencies");
    }
  });

  test("fails when package uses semver range", async () => {
    const input = makeToolInput({
      requires: {
        packages: { zod: "^3.22.0" },
      },
    });
    const result = await verifyResolve(input, DEFAULT_DEP_CONFIG);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("resolve");
      expect(result.error.message).toContain("exact semver");
    }
  });

  test("fails when package is blocked", async () => {
    const config: DependencyConfig = {
      ...DEFAULT_DEP_CONFIG,
      blockedPackages: ["evil-pkg"],
    };
    const input = makeToolInput({
      requires: {
        packages: { "evil-pkg": "1.0.0" },
      },
    });
    const result = await verifyResolve(input, config);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("blocked");
    }
  });
});

// ---------------------------------------------------------------------------
// Stage report structure
// ---------------------------------------------------------------------------

describe("verifyResolve (report structure)", () => {
  test("report has correct stage name", async () => {
    const input = makeToolInput();
    const result = await verifyResolve(input, DEFAULT_DEP_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stage).toBe("resolve");
    }
  });

  test("report includes durationMs", async () => {
    const input = makeToolInput();
    const result = await verifyResolve(input, DEFAULT_DEP_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("report is typed as ResolveStageReport", async () => {
    const input = makeToolInput();
    const result = await verifyResolve(input, DEFAULT_DEP_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const report = result.value as ResolveStageReport;
      expect(report.stage).toBe("resolve");
      // workspacePath and entryPath are undefined when no packages
      expect(report.workspacePath).toBeUndefined();
      expect(report.entryPath).toBeUndefined();
    }
  });
});
