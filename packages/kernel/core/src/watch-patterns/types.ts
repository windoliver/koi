import type { TaskItemId } from "../task-board.js";

export interface WatchPattern {
  readonly pattern: string;
  readonly event: string;
  readonly flags?: string;
}

export interface PatternMatch {
  readonly taskId: TaskItemId;
  readonly pid?: number;
  readonly event: string;
  readonly stream: "stdout" | "stderr";
  readonly lineNumber: number;
  readonly timestamp: number;
}

export interface CoalescedMatch {
  readonly taskId: TaskItemId;
  readonly event: string;
  readonly stream: "stdout" | "stderr";
  readonly firstMatch: PatternMatch;
  readonly count: number;
  readonly lastTimestamp: number;
}

export interface MatchEntry {
  readonly event: string;
  readonly stream: "stdout" | "stderr";
  readonly lineNumber: number;
  readonly timestamp: number;
  readonly line: string;
  readonly line_byte_length: number;
  readonly line_clipped_prefix_bytes: number;
  readonly line_clipped_suffix_bytes: number;
  readonly line_original_byte_length: number;
  readonly match_span_units: { readonly start: number; readonly end: number };
}

export interface PendingMatchStore {
  readonly record: (match: PatternMatch) => void;
  readonly peek: (request: object) => readonly CoalescedMatch[];
  readonly ack: (request: object) => void;
  readonly pending: () => number;
  readonly registerMatcher: (matcher: { readonly cancel: () => void }) => void;
  readonly unregisterMatcher: (matcher: { readonly cancel: () => void }) => void;
  readonly dispose: () => void;
}
