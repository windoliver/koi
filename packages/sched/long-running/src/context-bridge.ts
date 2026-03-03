/**
 * Context bridge — builds resume context from a harness snapshot.
 *
 * Pure function that assembles InboundMessage[] from the snapshot's
 * task board, context summaries, and key artifacts, respecting a
 * token budget. No I/O, depends only on L0 types.
 */

import type {
  HarnessSnapshot,
  InboundMessage,
  KoiError,
  Result,
  TaskBoardSnapshot,
  TaskItem,
} from "@koi/core";
import { validation } from "@koi/core";
import { estimateTokens } from "@koi/token-estimator";

// ---------------------------------------------------------------------------
// Task plan formatting
// ---------------------------------------------------------------------------

function formatTaskItem(item: TaskItem): string {
  const statusIcon =
    item.status === "completed"
      ? "[x]"
      : item.status === "failed"
        ? "[!]"
        : item.status === "assigned"
          ? "[~]"
          : "[ ]";
  return `${statusIcon} ${item.id}: ${item.description}`;
}

function formatTaskBoard(board: TaskBoardSnapshot): string {
  const lines: readonly string[] = [
    "## Task Plan",
    "",
    ...board.items.map(formatTaskItem),
    "",
    `Completed: ${String(board.items.filter((i: TaskItem) => i.status === "completed").length)}/${String(board.items.length)}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build initial prompt from a task plan for the first session.
 *
 * Returns a text string describing the task plan for the engine.
 */
export function buildInitialPrompt(plan: TaskBoardSnapshot): string {
  const lines: readonly string[] = [
    "You are resuming a long-running task. Here is your task plan:",
    "",
    formatTaskBoard(plan),
    "",
    "Begin working on the pending tasks in priority order.",
  ];
  return lines.join("\n");
}

/**
 * Build resume context from a harness snapshot.
 *
 * Assembles InboundMessage[] with:
 * 1. Task plan (always included)
 * 2. Context summaries (newest first, up to half remaining budget)
 * 3. Key artifacts (newest first, up to half remaining budget)
 *
 * @returns Result with messages on success, VALIDATION error if task board is empty.
 */
export function buildResumeContext(
  snapshot: HarnessSnapshot,
  config: { readonly maxContextTokens: number },
): Result<readonly InboundMessage[], KoiError> {
  // Fail-closed: can't resume without a plan
  if (snapshot.taskBoard.items.length === 0) {
    return {
      ok: false,
      error: validation("Cannot build resume context: task board is empty"),
    };
  }

  const budget = config.maxContextTokens;
  const parts: string[] = [];

  // Phase 1: Task plan (always included)
  const planText = formatTaskBoard(snapshot.taskBoard);
  parts.push(planText);
  let usedTokens = estimateTokens(planText);

  const remaining = budget - usedTokens;
  const halfRemaining = Math.floor(remaining / 2);

  // Phase 2: Summaries (newest first, up to half remaining)
  if (snapshot.summaries.length > 0) {
    const summaryLines: string[] = ["", "## Previous Session Summaries"];
    let summaryTokens = estimateTokens(summaryLines.join("\n"));

    // Walk newest first
    const sortedSummaries = [...snapshot.summaries].sort((a, b) => b.sessionSeq - a.sessionSeq);

    for (const summary of sortedSummaries) {
      const line = `\nSession ${String(summary.sessionSeq)}: ${summary.narrative}`;
      const lineTokens = estimateTokens(line);
      if (summaryTokens + lineTokens > halfRemaining) break;
      summaryLines.push(line);
      summaryTokens += lineTokens;
    }

    if (summaryLines.length > 2) {
      const summaryText = summaryLines.join("\n");
      parts.push(summaryText);
      usedTokens += estimateTokens(summaryText);
    }
  }

  // Phase 3: Artifacts (newest first, up to half remaining)
  if (snapshot.keyArtifacts.length > 0) {
    const artifactLines: string[] = ["", "## Key Artifacts"];
    let artifactTokens = estimateTokens(artifactLines.join("\n"));

    // Walk newest first (by capturedAt)
    const sortedArtifacts = [...snapshot.keyArtifacts].sort((a, b) => b.capturedAt - a.capturedAt);

    for (const artifact of sortedArtifacts) {
      const line = `\n[${artifact.toolName} @ turn ${String(artifact.turnIndex)}]: ${artifact.content}`;
      const lineTokens = estimateTokens(line);
      if (artifactTokens + lineTokens > halfRemaining) break;
      artifactLines.push(line);
      artifactTokens += lineTokens;
    }

    if (artifactLines.length > 2) {
      const artifactText = artifactLines.join("\n");
      parts.push(artifactText);
    }
  }

  const fullText = parts.join("\n");

  const message: InboundMessage = {
    senderId: "harness",
    timestamp: Date.now(),
    content: [{ kind: "text", text: fullText }],
    pinned: true,
  };

  return { ok: true, value: [message] };
}
