/**
 * review_output tool — review a completed task's output.
 */

import type { TaskItemId } from "@koi/core";
import { taskItemId } from "@koi/core";
import type { BoardHolder } from "./orchestrate-tool.js";

interface ReviewOutputInput {
  readonly task_id: string;
  readonly verdict: "accept" | "reject" | "revise";
  readonly feedback?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseInput(raw: unknown): ReviewOutputInput | string {
  if (!isRecord(raw)) return "Input must be a non-null object";
  if (typeof raw.task_id !== "string" || raw.task_id.length === 0) {
    return "'task_id' is required and must be a non-empty string";
  }
  if (raw.verdict !== "accept" && raw.verdict !== "reject" && raw.verdict !== "revise") {
    return "'verdict' must be 'accept', 'reject', or 'revise'";
  }
  return {
    task_id: raw.task_id,
    verdict: raw.verdict,
    feedback: typeof raw.feedback === "string" ? raw.feedback : undefined,
  };
}

/**
 * Executes the review_output tool.
 */
export function executeReviewOutput(raw: unknown, holder: BoardHolder): string {
  const input = parseInput(raw);
  if (typeof input === "string") return input;

  const id: TaskItemId = taskItemId(input.task_id);
  const board = holder.getBoard();
  const item = board.get(id);

  if (item === undefined) {
    return `Task not found: ${input.task_id}`;
  }

  if (input.verdict === "accept") {
    // Task is already completed — no state change needed
    return `Task ${input.task_id} accepted.`;
  }

  // For reject/revise, fail the task so it can be retried
  const error = {
    code: "VALIDATION" as const,
    message:
      input.verdict === "reject"
        ? `Rejected: ${input.feedback ?? "no feedback"}`
        : `Revision needed: ${input.feedback ?? "no feedback"}`,
    retryable: true,
  };

  const result = board.fail(id, error);
  if (!result.ok) {
    return `Cannot ${input.verdict} task ${input.task_id}: ${result.error.message}`;
  }

  holder.setBoard(result.value);
  const updated = result.value.get(id);

  if (updated?.status === "pending") {
    return `Task ${input.task_id} ${input.verdict}ed — queued for retry (attempt ${updated.retries}/${updated.maxRetries}).${input.feedback ? ` Feedback: ${input.feedback}` : ""}`;
  }

  return `Task ${input.task_id} ${input.verdict}ed — retries exhausted, marked as failed.${input.feedback ? ` Feedback: ${input.feedback}` : ""}`;
}
