import type { KoiError, Result } from "@koi/core";

export interface TraceTurnToolCall {
  readonly name: string;
  readonly argsJson: string;
}

export interface TraceTurn {
  readonly role: "user" | "assistant" | "tool";
  readonly text?: string;
  readonly toolCalls?: readonly TraceTurnToolCall[];
}

export interface DistillationTrace {
  readonly traceId: string;
  readonly sessionId?: string;
  readonly turns: readonly TraceTurn[];
}

export interface SkillDraftParameter {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly parameters: readonly SkillDraftParameter[];
  readonly toolSequence: readonly string[];
  readonly expectedInputs: readonly string[];
  readonly expectedOutputs: readonly string[];
}

export interface DistillationSource {
  readonly traceId: string;
  readonly sessionId?: string;
  readonly timestamp: number;
  readonly sourceHash: string;
}

export interface DistillationRecord {
  readonly draft: SkillDraft;
  readonly source: DistillationSource;
  readonly draftHash: string;
}

export interface DistillerLLMRequest {
  readonly prompt: string;
  readonly modelHint: "cheap";
}

export type DistillerLLM = (req: DistillerLLMRequest) => Promise<Result<string, KoiError>>;

/**
 * Sanitize a trace before it is rendered into the LLM prompt. The default is
 * the identity function — callers MUST supply a real redactor when traces may
 * carry secrets, tenant IDs, customer paths, or any data that should not
 * leave the local trust boundary. Redaction runs on a deep copy so the
 * original trace is never mutated.
 */
export type TraceRedactor = (trace: DistillationTrace) => DistillationTrace;

export interface DistillerConfig {
  readonly llm: DistillerLLM;
  readonly now?: () => number;
  /** Sanitize the trace before prompt rendering. Default: identity (no redaction). */
  readonly redactor?: TraceRedactor;
}

export interface Distiller {
  readonly distill: (trace: DistillationTrace) => Promise<Result<DistillationRecord, KoiError>>;
}

export type DedupeStatus = "new" | "duplicate";

export interface DedupeIndex {
  readonly has: (draftHash: string) => boolean;
  readonly register: (record: DistillationRecord) => DedupeStatus;
  readonly clear: () => void;
  readonly size: () => number;
}

export interface AuditLog {
  readonly record: (entry: DistillationRecord) => void;
  readonly list: () => readonly DistillationRecord[];
  readonly clear: () => void;
}
