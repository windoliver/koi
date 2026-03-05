/**
 * Tool factory for `github_pr_status` — get PR status including CI checks, reviews, and merge readiness.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import { PR_STATUS_FIELDS } from "../constants.js";
import type { GhExecutor } from "../gh-executor.js";
import { parsePrNumber } from "../parse-args.js";
import { mapErrorResult, parseGhJson } from "../parse-gh-error.js";

export function createGithubPrStatusTool(
  executor: GhExecutor,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_pr_status`,
      description:
        "Get the current status of a pull request including CI checks, review decision, " +
        "merge readiness, and diff statistics.",
      inputSchema: {
        type: "object",
        properties: {
          pr_number: { type: "number", description: "Pull request number" },
        },
        required: ["pr_number"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const prResult = parsePrNumber(args, "pr_number");
      if (!prResult.ok) return prResult.err;

      const ghArgs = ["pr", "view", String(prResult.value), "--json", PR_STATUS_FIELDS];

      const result = await executor.execute(ghArgs);
      if (!result.ok) return mapErrorResult(result.error);

      const parsed = parseGhJson(result.value);
      if (!parsed.ok) return mapErrorResult(parsed.error);

      return parsed.value;
    },
  };
}
