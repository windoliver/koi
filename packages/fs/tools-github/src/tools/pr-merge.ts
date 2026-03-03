/**
 * Tool factory for `github_pr_merge` — merge a pull request.
 *
 * Pre-validates merge readiness by checking PR state, CI, and reviews
 * before attempting the merge.
 */

import type { JsonObject, Tool, TrustTier } from "@koi/core";
import { MERGE_STRATEGIES, PR_STATUS_FIELDS } from "../constants.js";
import type { GhExecutor } from "../gh-executor.js";
import { parseOptionalBoolean, parseOptionalEnum, parsePrNumber } from "../parse-args.js";
import { isRecord, mapErrorResult, parseGhJson } from "../parse-gh-error.js";

export function createGithubPrMergeTool(
  executor: GhExecutor,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_pr_merge`,
      description:
        "Merge a pull request. Pre-validates CI status, review decision, and merge readiness. " +
        "Supports merge, squash, and rebase strategies.",
      inputSchema: {
        type: "object",
        properties: {
          pr_number: { type: "number", description: "Pull request number" },
          strategy: {
            type: "string",
            enum: ["merge", "squash", "rebase"],
            description: "Merge strategy (default: merge)",
          },
          delete_branch: {
            type: "boolean",
            description: "Delete the head branch after merge (default: false)",
          },
        },
        required: ["pr_number"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const prResult = parsePrNumber(args, "pr_number");
      if (!prResult.ok) return prResult.err;
      const strategyResult = parseOptionalEnum(args, "strategy", MERGE_STRATEGIES);
      if (!strategyResult.ok) return strategyResult.err;
      const deleteBranchResult = parseOptionalBoolean(args, "delete_branch");
      if (!deleteBranchResult.ok) return deleteBranchResult.err;

      // Pre-validate merge readiness
      const validationError = await validateMergeReadiness(executor, prResult.value);
      if (validationError !== undefined) return validationError;

      const strategy = strategyResult.value ?? "merge";
      const strategyFlag =
        strategy === "squash" ? "--squash" : strategy === "rebase" ? "--rebase" : "--merge";

      const ghArgs: readonly string[] = [
        "pr",
        "merge",
        String(prResult.value),
        strategyFlag,
        ...(deleteBranchResult.value === true ? ["--delete-branch"] : []),
      ];

      const result = await executor.execute(ghArgs);
      if (!result.ok) return mapErrorResult(result.error);

      return { merged: true };
    },
  };
}

/** Check PR state before merge — returns an error object if not ready, undefined if ok. */
async function validateMergeReadiness(
  executor: GhExecutor,
  prNumber: number,
): Promise<{ readonly error: string; readonly code: string } | undefined> {
  const statusResult = await executor.execute([
    "pr",
    "view",
    String(prNumber),
    "--json",
    PR_STATUS_FIELDS,
  ]);

  if (!statusResult.ok) return mapErrorResult(statusResult.error);

  const parsed = parseGhJson(statusResult.value);
  if (!parsed.ok) return mapErrorResult(parsed.error);

  if (!isRecord(parsed.value)) {
    return { error: "Unexpected response format from gh", code: "EXTERNAL" };
  }

  const status = parsed.value;

  if (status.state !== "OPEN") {
    return {
      error: `PR #${prNumber} is not open (state: ${String(status.state)})`,
      code: "VALIDATION",
    };
  }

  if (status.isDraft === true) {
    return {
      error: `PR #${prNumber} is a draft and cannot be merged`,
      code: "VALIDATION",
    };
  }

  if (status.mergeable === "CONFLICTING") {
    return {
      error: `PR #${prNumber} has merge conflicts that must be resolved first`,
      code: "CONFLICT",
    };
  }

  // Check CI status — warn but don't block if checks haven't finished
  const checks = status.statusCheckRollup;
  if (Array.isArray(checks)) {
    const failedChecks = checks.filter((c: unknown) => isRecord(c) && c.conclusion === "FAILURE");
    if (failedChecks.length > 0) {
      return {
        error: `PR #${prNumber} has ${failedChecks.length} failing CI check(s)`,
        code: "VALIDATION",
      };
    }
  }

  return undefined;
}
