/**
 * Ring-buffer accumulator for bounded action/issue recording.
 * O(1) insertion, O(n) snapshot (read path, infrequent).
 */

import type { ActionEntry, ArtifactRef, IssueEntry } from "@koi/core";

export interface AccumulatorSnapshot {
  readonly actions: readonly ActionEntry[];
  readonly artifacts: readonly ArtifactRef[];
  readonly issues: readonly IssueEntry[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalActions: number;
  readonly truncated: boolean;
}

export interface Accumulator {
  readonly recordAction: (entry: ActionEntry) => void;
  readonly recordArtifact: (ref: ArtifactRef) => void;
  readonly recordIssue: (entry: IssueEntry) => void;
  readonly addTokens: (input: number, output: number) => void;
  readonly snapshot: () => AccumulatorSnapshot;
}

export function createAccumulator(maxActions: number): Accumulator {
  const buffer: (ActionEntry | undefined)[] = new Array<ActionEntry | undefined>(maxActions).fill(
    undefined,
  );
  let head = 0;
  let count = 0;
  let totalActions = 0;
  let truncated = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const artifacts: ArtifactRef[] = [];
  const issues: IssueEntry[] = [];

  return {
    recordAction(entry: ActionEntry): void {
      buffer[head] = entry;
      head = (head + 1) % maxActions;
      totalActions++;
      if (count < maxActions) {
        count++;
      } else {
        truncated = true;
      }
    },

    recordArtifact(ref: ArtifactRef): void {
      artifacts.push(ref);
    },

    recordIssue(entry: IssueEntry): void {
      issues.push(entry);
    },

    addTokens(input: number, output: number): void {
      inputTokens += input;
      outputTokens += output;
    },

    snapshot(): AccumulatorSnapshot {
      // Linearize ring buffer in chronological order
      const actions: ActionEntry[] = [];
      if (count === maxActions) {
        // Buffer is full — read from head (oldest) to end, then 0 to head
        for (let i = 0; i < maxActions; i++) {
          const idx = (head + i) % maxActions;
          const entry = buffer[idx];
          if (entry !== undefined) {
            actions.push(entry);
          }
        }
      } else {
        // Buffer not full — entries are 0..count-1
        for (let i = 0; i < count; i++) {
          const entry = buffer[i];
          if (entry !== undefined) {
            actions.push(entry);
          }
        }
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
  };
}
