/**
 * Types for the session repair pipeline.
 */

/** Describes a single repair action taken during session repair. */
export interface RepairIssue {
  readonly phase: "orphan-tool" | "dedup" | "merge";
  readonly description: string;
  readonly index: number;
  readonly action: "removed" | "merged" | "inserted" | "kept";
}

/** Result of running the session repair pipeline. */
export interface RepairResult {
  readonly messages: readonly import("@koi/core/message").InboundMessage[];
  readonly issues: readonly RepairIssue[];
}

/** Mapping of callId pairs and orphan indices within a message array. */
export interface CallIdPairMap {
  /** Map from callId to the index of the assistant message that initiated it. */
  readonly assistantByCallId: ReadonlyMap<string, number>;
  /** Indices of tool messages whose callId has no matching assistant message. */
  readonly orphanToolIndices: readonly number[];
  /** Indices of assistant messages whose callId has no matching tool result. */
  readonly danglingToolUseIndices: readonly number[];
}
