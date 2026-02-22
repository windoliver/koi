/**
 * Core types for the @koi/forge self-extension system.
 */

import type {
  BrickKind,
  BrickLifecycle,
  ForgeScope,
  TestCase,
  ToolDescriptor,
  TrustTier,
} from "@koi/core";

// Re-export L0 types that other forge modules import from this file
export type { BrickKind, BrickLifecycle, ForgeScope };

// ---------------------------------------------------------------------------
// Forge result (pure data — L1 handles mutation)
// ---------------------------------------------------------------------------

export interface ForgeResultMetadata {
  readonly forgedAt: number;
  readonly forgedBy: string;
  readonly sessionId: string;
  readonly depth: number;
}

export interface ForgeResult {
  readonly id: string;
  readonly kind: BrickKind;
  readonly name: string;
  readonly descriptor: ToolDescriptor;
  readonly trustTier: TrustTier;
  readonly scope: ForgeScope;
  readonly lifecycle: BrickLifecycle;
  readonly verificationReport: VerificationReport;
  readonly metadata: ForgeResultMetadata;
  /** Number of forge operations consumed (caller must increment forgesThisSession by this amount). */
  readonly forgesConsumed: number;
}

// ---------------------------------------------------------------------------
// Verification report
// ---------------------------------------------------------------------------

export type VerificationStage = "static" | "sandbox" | "self_test" | "trust";

export interface StageReport {
  readonly stage: VerificationStage;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly message?: string;
}

export interface TrustStageReport extends StageReport {
  readonly stage: "trust";
  readonly trustTier: TrustTier;
}

export interface VerificationReport {
  readonly stages: readonly StageReport[];
  readonly finalTrustTier: TrustTier;
  readonly totalDurationMs: number;
  readonly passed: boolean;
}

// ---------------------------------------------------------------------------
// Forge inputs (discriminated union)
// ---------------------------------------------------------------------------

export type { TestCase } from "@koi/core";

export interface ForgeToolInput {
  readonly kind: "tool";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly implementation: string;
  readonly testCases?: readonly TestCase[];
}

export interface ForgeSkillInput {
  readonly kind: "skill";
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly tags?: readonly string[];
}

export interface ForgeAgentInput {
  readonly kind: "agent";
  readonly name: string;
  readonly description: string;
  readonly manifestYaml: string;
}

export interface ForgeCompositeInput {
  readonly kind: "composite";
  readonly name: string;
  readonly description: string;
  readonly brickIds: readonly string[];
}

export type ForgeInput = ForgeToolInput | ForgeSkillInput | ForgeAgentInput | ForgeCompositeInput;

// ---------------------------------------------------------------------------
// Pluggable verifier (Stage 3)
// ---------------------------------------------------------------------------

export interface VerifierResult {
  readonly passed: boolean;
  readonly message?: string;
}

export interface ForgeVerifier {
  readonly name: string;
  readonly verify: (input: ForgeInput, context: ForgeContext) => Promise<VerifierResult>;
}

// ---------------------------------------------------------------------------
// Sandbox executor (injected dependency)
// ---------------------------------------------------------------------------

export type SandboxErrorCode = "TIMEOUT" | "OOM" | "PERMISSION" | "CRASH";

export interface SandboxError {
  readonly code: SandboxErrorCode;
  readonly message: string;
  readonly durationMs: number;
}

export interface SandboxResult {
  readonly output: unknown;
  readonly durationMs: number;
  readonly memoryUsedBytes?: number;
}

export interface SandboxExecutor {
  readonly execute: (
    code: string,
    input: unknown,
    timeoutMs: number,
  ) => Promise<
    | { readonly ok: true; readonly value: SandboxResult }
    | { readonly ok: false; readonly error: SandboxError }
  >;
}

// ---------------------------------------------------------------------------
// Forge context
// ---------------------------------------------------------------------------

export interface ForgeContext {
  readonly agentId: string;
  readonly depth: number;
  readonly sessionId: string;
  readonly forgesThisSession: number;
}

// Brick artifact types — canonical definitions live in @koi/core (L0)
export type {
  AgentArtifact,
  BrickArtifact,
  BrickArtifactBase,
  CompositeArtifact,
  SkillArtifact,
  ToolArtifact,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Promote result (returned by promote_forge)
// ---------------------------------------------------------------------------

export interface PromoteChange<T> {
  readonly from: T;
  readonly to: T;
}

export interface PromoteResult {
  readonly brickId: string;
  readonly applied: boolean;
  readonly requiresHumanApproval: boolean;
  readonly changes: {
    readonly scope?: PromoteChange<ForgeScope>;
    readonly trustTier?: PromoteChange<TrustTier>;
    readonly lifecycle?: PromoteChange<BrickLifecycle>;
  };
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Manifest parser (injected dependency — avoids L2 peer import of @koi/manifest)
// ---------------------------------------------------------------------------

export type ManifestParseResult =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string };

export interface ManifestParser {
  readonly parse: (yaml: string) => ManifestParseResult | Promise<ManifestParseResult>;
}

// Forge query — canonical definition lives in @koi/core (L0)
export type { ForgeQuery } from "@koi/core";
