/**
 * Tool factory for `github_pr_create` — create a pull request.
 */

import type { JsonObject, Tool, TrustTier } from "@koi/core";
import { PR_CREATE_FIELDS } from "../constants.js";
import type { GhExecutor } from "../gh-executor.js";
import { parseOptionalBoolean, parseOptionalString } from "../parse-args.js";
import { mapErrorResult, parseGhJson } from "../parse-gh-error.js";

export function createGithubPrCreateTool(
  executor: GhExecutor,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_pr_create`,
      description:
        "Create a new pull request on GitHub. The current branch must be pushed to the remote first.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "PR title (auto-generated from commits if omitted)",
          },
          body: { type: "string", description: "PR body/description" },
          base: {
            type: "string",
            description: "Base branch to merge into (default: repo default branch)",
          },
          head: { type: "string", description: "Head branch (default: current branch)" },
          draft: { type: "boolean", description: "Create as draft PR (default: false)" },
        },
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const titleResult = parseOptionalString(args, "title");
      if (!titleResult.ok) return titleResult.err;
      const bodyResult = parseOptionalString(args, "body");
      if (!bodyResult.ok) return bodyResult.err;
      const baseResult = parseOptionalString(args, "base");
      if (!baseResult.ok) return baseResult.err;
      const headResult = parseOptionalString(args, "head");
      if (!headResult.ok) return headResult.err;
      const draftResult = parseOptionalBoolean(args, "draft");
      if (!draftResult.ok) return draftResult.err;

      const ghArgs: readonly string[] = [
        "pr",
        "create",
        ...(titleResult.value !== undefined ? ["--title", titleResult.value] : []),
        ...(bodyResult.value !== undefined ? ["--body", bodyResult.value] : []),
        ...(baseResult.value !== undefined ? ["--base", baseResult.value] : []),
        ...(headResult.value !== undefined ? ["--head", headResult.value] : []),
        ...(draftResult.value === true ? ["--draft"] : []),
        ...(titleResult.value === undefined ? ["--fill"] : []),
        "--json",
        PR_CREATE_FIELDS,
      ];

      const result = await executor.execute(ghArgs);
      if (!result.ok) return mapErrorResult(result.error);

      const parsed = parseGhJson(result.value);
      if (!parsed.ok) return mapErrorResult(parsed.error);

      return parsed.value;
    },
  };
}
