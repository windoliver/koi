import type {
  KoiError,
  Result,
  SessionId,
  SessionTranscript,
  SkippedTranscriptEntry,
  TranscriptEntry,
} from "@koi/core";

export type Granularity = "high" | "medium" | "detailed";
export type Status = "succeeded" | "partial" | "failed";
export type ModelHint = "cheap" | "default" | "smart";
export type CrashTailStrategy = "reject" | "drop_last_turn" | "include_all";

export interface Focus {
  readonly goals?: boolean;
  readonly tool_calls?: boolean;
  readonly errors?: boolean;
  readonly files_changed?: boolean;
  readonly decisions?: boolean;
}

export const DEFAULT_FOCUS = {
  goals: true,
  tool_calls: true,
  errors: true,
  files_changed: true,
  decisions: true,
} as const;

export const DEFAULT_TOKEN_BUDGETS = {
  high: 300,
  medium: 1200,
  detailed: 4000,
} as const;

export interface SummaryCommonOptions {
  readonly granularity?: Granularity;
  readonly focus?: Focus;
  readonly maxTokens?: number;
  readonly modelHint?: ModelHint;
  readonly schemaVersion?: 1;
}

export interface SummarySessionOptions extends SummaryCommonOptions {
  readonly crashTailStrategy?: CrashTailStrategy;
  readonly allowCompacted?: boolean;
}

export type SummaryRangeOptions = SummaryCommonOptions;

export interface Action {
  readonly kind: "tool_call" | "edit" | "decision";
  readonly name: string;
  readonly paths?: readonly string[];
  readonly detail?: string;
}

export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly range: {
    readonly fromTurn: number;
    readonly toTurn: number;
    readonly entryCount: number;
  };
  readonly goal: string;
  readonly status: Status;
  readonly actions: readonly Action[];
  readonly outcomes: readonly string[];
  readonly errors: readonly string[];
  readonly learnings: readonly string[];
  readonly meta: {
    readonly granularity: Granularity;
    readonly modelHint: ModelHint;
    readonly hash: string;
    readonly generatedAt: number;
    readonly schemaVersion: 1;
    readonly hasCompactionPrefix: boolean;
    readonly rangeOrigin: "raw" | "post-compaction";
  };
}

export type SummaryOk =
  | { readonly kind: "clean"; readonly summary: SessionSummary }
  | {
      readonly kind: "degraded";
      readonly partial: SessionSummary;
      readonly skipped: readonly SkippedTranscriptEntry[];
      readonly droppedTailTurns: number;
    }
  | {
      readonly kind: "compacted";
      readonly derived: SessionSummary;
      readonly compactionEntryCount: number;
      readonly skipped: readonly SkippedTranscriptEntry[];
      readonly droppedTailTurns: number;
    };

export interface ModelRequest {
  readonly messages: readonly {
    readonly role: "system" | "user";
    readonly content: string;
  }[];
  readonly maxTokens: number;
  readonly responseFormat: "json";
  readonly metadata: {
    readonly summaryMode: Granularity;
    readonly modelHint: ModelHint;
  };
}

export interface ModelResponse {
  readonly text: string;
}

export interface SummaryCache {
  readonly get: (key: string) => SummaryOk | undefined | Promise<SummaryOk | undefined>;
  readonly set: (key: string, value: SummaryOk) => void | Promise<void>;
}

export type SummaryEvent =
  | { readonly kind: "cache.hit"; readonly hash: string }
  | { readonly kind: "cache.miss"; readonly hash: string }
  | {
      readonly kind: "cache.read_fail";
      readonly hash: string;
      readonly error: KoiError;
    }
  | {
      readonly kind: "cache.write_fail";
      readonly hash: string;
      readonly error: KoiError;
    }
  | {
      readonly kind: "cache.corrupt";
      readonly hash: string;
      readonly reason: string;
    }
  | { readonly kind: "parse.retry"; readonly hash: string }
  | { readonly kind: "parse.fail"; readonly hash: string }
  | {
      readonly kind: "model.start";
      readonly hash: string;
      readonly maxTokens: number;
    }
  | {
      readonly kind: "model.end";
      readonly hash: string;
      readonly elapsedMs: number;
    }
  | {
      readonly kind: "transcript.skipped";
      readonly hash: string | null;
      readonly skippedCount: number;
    };

export interface AgentSummaryDeps {
  readonly transcript: SessionTranscript;
  readonly modelCall: (req: ModelRequest) => Promise<ModelResponse>;
  readonly cache?: SummaryCache;
  readonly clock?: () => number;
  readonly onEvent?: (e: SummaryEvent) => void;
}

export interface AgentSummary {
  readonly summarizeSession: (
    sessionId: SessionId,
    options?: SummarySessionOptions,
  ) => Promise<Result<SummaryOk, KoiError>>;
  readonly summarizeRange: (
    sessionId: SessionId,
    fromTurn: number,
    toTurn: number,
    options?: SummaryRangeOptions,
  ) => Promise<Result<SummaryOk, KoiError>>;
}

export const ERROR_CODES = {
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  DEGRADED_TRANSCRIPT: "DEGRADED_TRANSCRIPT",
  RANGE_COMPACTED: "RANGE_COMPACTED",
  SESSION_COMPACTED: "SESSION_COMPACTED",
  MODEL_ERROR: "MODEL_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type {
  KoiError,
  Result,
  SessionId,
  SessionTranscript,
  SkippedTranscriptEntry,
  TranscriptEntry,
};
