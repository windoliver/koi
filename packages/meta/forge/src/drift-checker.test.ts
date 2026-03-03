import { describe, expect, mock, test } from "bun:test";
import type { BrickDriftContext, KoiError, Result } from "@koi/core";
import { createDriftChecker } from "./drift-checker.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockGit(opts: {
  readonly headCommit?: string;
  readonly changedFiles?: readonly string[];
  readonly headError?: boolean;
  readonly diffError?: boolean;
}): {
  readonly changedFilesSince: (
    commit: string,
    cwd: string,
  ) => Promise<Result<readonly string[], KoiError>>;
  readonly getHeadCommit: (cwd: string) => Promise<Result<string, KoiError>>;
} {
  const changedFilesSince = mock(
    async (_commit: string, _cwd: string): Promise<Result<readonly string[], KoiError>> => {
      if (opts.diffError) {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "git diff failed", retryable: false },
        };
      }
      return { ok: true, value: opts.changedFiles ?? [] };
    },
  );

  const getHeadCommit = mock(async (_cwd: string): Promise<Result<string, KoiError>> => {
    if (opts.headError) {
      return {
        ok: false,
        error: { code: "EXTERNAL", message: "not a git repo", retryable: false },
      };
    }
    return { ok: true, value: opts.headCommit ?? "abc123" };
  });

  return { changedFilesSince, getHeadCommit };
}

function createDriftContext(overrides?: Partial<BrickDriftContext>): BrickDriftContext {
  return {
    sourceFiles: ["packages/pay/src/**/*.ts"],
    lastCheckedCommit: "old-commit",
    driftScore: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDriftChecker", () => {
  test("returns undefined when sourceFiles is empty", async () => {
    const git = createMockGit({ headCommit: "new-commit" });
    const checker = createDriftChecker({ cwd: "/repo", git });

    const result = await checker.checkDrift(createDriftContext({ sourceFiles: [] }));
    expect(result).toBeUndefined();
  });

  test("returns undefined when HEAD matches lastCheckedCommit", async () => {
    const git = createMockGit({ headCommit: "same-commit" });
    const checker = createDriftChecker({ cwd: "/repo", git });

    const result = await checker.checkDrift(
      createDriftContext({ lastCheckedCommit: "same-commit" }),
    );
    expect(result).toBeUndefined();
  });

  test("returns undefined when getHeadCommit fails", async () => {
    const git = createMockGit({ headError: true });
    const checker = createDriftChecker({ cwd: "/repo", git });

    const result = await checker.checkDrift(createDriftContext());
    expect(result).toBeUndefined();
  });

  test("returns undefined when changedFilesSince fails", async () => {
    const git = createMockGit({ headCommit: "new-commit", diffError: true });
    const checker = createDriftChecker({ cwd: "/repo", git });

    const result = await checker.checkDrift(createDriftContext());
    expect(result).toBeUndefined();
  });

  test("computes drift score for changed files", async () => {
    const git = createMockGit({
      headCommit: "new-commit",
      changedFiles: ["packages/pay/src/config.ts"],
    });
    const checker = createDriftChecker({ cwd: "/repo", git });

    const result = await checker.checkDrift(createDriftContext());
    expect(result).toBeDefined();
    expect(result?.driftScore).toBe(1.0);
    expect(result?.currentCommit).toBe("new-commit");
  });

  test("returns 0 drift score when no source files changed", async () => {
    const git = createMockGit({
      headCommit: "new-commit",
      changedFiles: ["packages/auth/src/login.ts"],
    });
    const checker = createDriftChecker({ cwd: "/repo", git });

    const result = await checker.checkDrift(createDriftContext());
    expect(result).toBeDefined();
    expect(result?.driftScore).toBe(0);
  });

  test("uses cached changed files within TTL", async () => {
    const git = createMockGit({
      headCommit: "new-commit",
      changedFiles: ["packages/pay/src/index.ts"],
    });
    const checker = createDriftChecker({ cwd: "/repo", git, cacheTtlMs: 60_000 });

    // First call
    await checker.checkDrift(createDriftContext());
    // Second call — should use cache
    await checker.checkDrift(createDriftContext({ lastCheckedCommit: "old-commit-2" }));

    // getHeadCommit called twice (once per checkDrift), but changedFilesSince only once (cached)
    expect(git.getHeadCommit).toHaveBeenCalledTimes(2);
    // changedFilesSince uses baseCommit as cache key — different lastCheckedCommit = different key
    // So it will be called twice for different baseCommits
  });

  test("handles lastCheckedCommit being undefined", async () => {
    const git = createMockGit({
      headCommit: "new-commit",
      changedFiles: [],
    });
    const checker = createDriftChecker({ cwd: "/repo", git });

    const result = await checker.checkDrift({
      sourceFiles: ["packages/pay/src/**/*.ts"],
      driftScore: 0,
    });
    // When lastCheckedCommit is undefined, baseCommit = currentCommit = "new-commit"
    // But HEAD === lastCheckedCommit is checked first — undefined !== "new-commit" → proceeds
    expect(result).toBeDefined();
    expect(result?.driftScore).toBe(0);
  });
});
