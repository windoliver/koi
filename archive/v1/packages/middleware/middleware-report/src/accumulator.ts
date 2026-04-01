/**
 * Accumulator — bounded state collector for run report data.
 *
 * Uses closure-based mutable state internally for hot-loop performance.
 * Exposes an immutable snapshot API.
 */

import type { ActionEntry, ArtifactRef, IssueEntry } from "@koi/core";

/** Immutable snapshot of accumulated run data. */
export interface AccumulatorSnapshot {
  readonly actions: readonly ActionEntry[];
  readonly artifacts: readonly ArtifactRef[];
  readonly issues: readonly IssueEntry[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalActions: number;
  readonly truncated: boolean;
}

/** Accumulator for collecting run data with bounded action storage. */
export interface Accumulator {
  readonly recordAction: (entry: ActionEntry) => void;
  readonly recordArtifact: (ref: ArtifactRef) => void;
  readonly recordIssue: (entry: IssueEntry) => void;
  readonly addTokens: (input: number, output: number) => void;
  readonly snapshot: () => AccumulatorSnapshot;
  readonly reset: () => void;
}

export function createAccumulator(maxActions: number): Accumulator {
  // Ring-buffer for O(1) action recording — justified for hot-loop performance
  let buffer: ActionEntry[] = []; // let: reset replaces the array
  let head = 0; // let: write cursor advances on each record
  let count = 0; // let: number of valid entries in the buffer
  let artifacts: ArtifactRef[] = []; // let: reset replaces the array
  let issues: IssueEntry[] = []; // let: reset replaces the array
  let inputTokens = 0;
  let outputTokens = 0;
  let totalActions = 0;
  let truncated = false;

  return {
    recordAction(entry: ActionEntry): void {
      totalActions += 1;
      if (count < maxActions) {
        buffer[count] = entry;
        count += 1;
      } else {
        // Ring-buffer overwrite: O(1) — overwrites oldest entry at head
        buffer[head] = entry;
        head = (head + 1) % maxActions;
        truncated = true;
      }
    },

    recordArtifact(ref: ArtifactRef): void {
      artifacts = [...artifacts, ref];
    },

    recordIssue(entry: IssueEntry): void {
      issues = [...issues, entry];
    },

    addTokens(input: number, output: number): void {
      inputTokens += input;
      outputTokens += output;
    },

    snapshot(): AccumulatorSnapshot {
      // Linearize ring-buffer into chronological order on read
      let actions: readonly ActionEntry[];
      if (!truncated) {
        actions = buffer.slice(0, count);
      } else {
        // head points to the oldest entry; read from head → end, then 0 → head
        actions = [...buffer.slice(head), ...buffer.slice(0, head)];
      }
      return {
        actions,
        artifacts: [...artifacts],
        issues: [...issues],
        inputTokens,
        outputTokens,
        totalActions,
        truncated,
      };
    },

    reset(): void {
      buffer = [];
      head = 0;
      count = 0;
      artifacts = [];
      issues = [];
      inputTokens = 0;
      outputTokens = 0;
      totalActions = 0;
      truncated = false;
    },
  };
}
