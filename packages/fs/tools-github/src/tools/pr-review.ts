/**
 * Tool factory for `github_pr_review` — read existing reviews or post a new review.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import { PR_REVIEW_READ_FIELDS, REVIEW_ACTIONS, REVIEW_EVENTS } from "../constants.js";
import type { GhExecutor } from "../gh-executor.js";
import { parseEnum, parseOptionalEnum, parseOptionalString, parsePrNumber } from "../parse-args.js";
import { mapErrorResult, parseGhJson } from "../parse-gh-error.js";

export function createGithubPrReviewTool(
  executor: GhExecutor,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_pr_review`,
      description:
        "Read existing reviews on a PR or post a new review. " +
        'Use action="read" to see reviews, action="post" to submit one.',
      inputSchema: {
        type: "object",
        properties: {
          pr_number: { type: "number", description: "Pull request number" },
          action: {
            type: "string",
            enum: ["post", "read"],
            description: 'Action: "read" to view reviews, "post" to submit a review',
          },
          body: { type: "string", description: "Review body text (required for REQUEST_CHANGES)" },
          event: {
            type: "string",
            enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
            description: 'Review event type (default: "COMMENT", only for action="post")',
          },
        },
        required: ["pr_number", "action"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const prResult = parsePrNumber(args, "pr_number");
      if (!prResult.ok) return prResult.err;
      const actionResult = parseEnum(args, "action", REVIEW_ACTIONS);
      if (!actionResult.ok) return actionResult.err;

      if (actionResult.value === "read") {
        return executeRead(executor, prResult.value);
      }

      return executePost(executor, args, prResult.value);
    },
  };
}

async function executeRead(executor: GhExecutor, prNumber: number): Promise<unknown> {
  const ghArgs = ["pr", "view", String(prNumber), "--json", PR_REVIEW_READ_FIELDS] as const;

  const result = await executor.execute(ghArgs);
  if (!result.ok) return mapErrorResult(result.error);

  const parsed = parseGhJson(result.value);
  if (!parsed.ok) return mapErrorResult(parsed.error);

  return parsed.value;
}

async function executePost(
  executor: GhExecutor,
  args: JsonObject,
  prNumber: number,
): Promise<unknown> {
  const bodyResult = parseOptionalString(args, "body");
  if (!bodyResult.ok) return bodyResult.err;
  const eventResult = parseOptionalEnum(args, "event", REVIEW_EVENTS);
  if (!eventResult.ok) return eventResult.err;

  const event = eventResult.value ?? "COMMENT";

  // REQUEST_CHANGES requires a body
  if (
    event === "REQUEST_CHANGES" &&
    (bodyResult.value === undefined || bodyResult.value.length === 0)
  ) {
    return {
      error: "body is required when event is REQUEST_CHANGES",
      code: "VALIDATION",
    };
  }

  const eventFlag =
    event === "APPROVE"
      ? "--approve"
      : event === "REQUEST_CHANGES"
        ? "--request-changes"
        : "--comment";

  const ghArgs: readonly string[] = [
    "pr",
    "review",
    String(prNumber),
    eventFlag,
    ...(bodyResult.value !== undefined ? ["--body", bodyResult.value] : []),
  ];

  const result = await executor.execute(ghArgs);
  if (!result.ok) return mapErrorResult(result.error);

  return { success: true };
}
