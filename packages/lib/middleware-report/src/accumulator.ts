/**
 * Ring-buffer accumulator for bounded action/issue/artifact recording.
 * O(1) insertion, O(n) snapshot (read path, infrequent).
 */

import type { ActionEntry, ArtifactRef, IssueEntry } from "@koi/core";

const MAX_ARTIFACTS = 100;

export interface AccumulatorSnapshot {
  readonly actions: readonly ActionEntry[];
  readonly artifacts: readonly ArtifactRef[];
  readonly issues: readonly IssueEntry[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalActions: number;
  readonly totalIssues: number;
  readonly truncated: boolean;
}

export interface Accumulator {
  readonly recordAction: (entry: ActionEntry) => void;
  readonly recordArtifact: (ref: ArtifactRef) => void;
  readonly recordIssue: (entry: IssueEntry) => void;
  readonly addTokens: (input: number, output: number) => void;
  readonly snapshot: () => AccumulatorSnapshot;
}

/** Linearize a ring buffer into chronological order. */
function linearize<T>(
  buffer: readonly (T | undefined)[],
  head: number,
  count: number,
  capacity: number,
): T[] {
  const result: T[] = [];
  if (count === capacity) {
    for (let i = 0; i < capacity; i++) {
      const entry = buffer[(head + i) % capacity];
      if (entry !== undefined) result.push(entry);
    }
  } else {
    for (let i = 0; i < count; i++) {
      const entry = buffer[i];
      if (entry !== undefined) result.push(entry);
    }
  }
  return result;
}

export function createAccumulator(maxActions: number): Accumulator {
  const actionBuf: (ActionEntry | undefined)[] = new Array<ActionEntry | undefined>(
    maxActions,
  ).fill(undefined);
  let actionHead = 0;
  let actionCount = 0;
  let totalActions = 0;

  const issueBuf: (IssueEntry | undefined)[] = new Array<IssueEntry | undefined>(maxActions).fill(
    undefined,
  );
  let issueHead = 0;
  let issueCount = 0;
  let totalIssues = 0;

  const artifacts: ArtifactRef[] = [];
  let actionsTruncated = false;
  let issuesTruncated = false;
  let inputTokens = 0;
  let outputTokens = 0;

  return {
    recordAction(entry: ActionEntry): void {
      actionBuf[actionHead] = entry;
      actionHead = (actionHead + 1) % maxActions;
      totalActions++;
      if (actionCount < maxActions) {
        actionCount++;
      } else {
        actionsTruncated = true;
      }
    },

    recordArtifact(ref: ArtifactRef): void {
      if (artifacts.length < MAX_ARTIFACTS) {
        artifacts.push(ref);
      }
    },

    recordIssue(entry: IssueEntry): void {
      issueBuf[issueHead] = entry;
      issueHead = (issueHead + 1) % maxActions;
      totalIssues++;
      if (issueCount < maxActions) {
        issueCount++;
      } else {
        issuesTruncated = true;
      }
    },

    addTokens(input: number, output: number): void {
      inputTokens += input;
      outputTokens += output;
    },

    snapshot(): AccumulatorSnapshot {
      return {
        actions: linearize(actionBuf, actionHead, actionCount, maxActions),
        artifacts: [...artifacts],
        issues: linearize(issueBuf, issueHead, issueCount, maxActions),
        inputTokens,
        outputTokens,
        totalActions,
        totalIssues,
        truncated: actionsTruncated || issuesTruncated,
      };
    },
  };
}
