/**
 * ForgePipeline — dependency injection interface for cross-package forge operations.
 *
 * Defined in @koi/forge-types (L0u) so that @koi/forge-tools (L2) can depend
 * on the interface without importing peer L2 packages (@koi/forge-verifier,
 * @koi/forge-integrity, @koi/forge-policy).
 *
 * The L3 bundle (@koi/forge) wires concrete implementations via createForgePipeline().
 */

import type {
  BrickKind,
  ContentMarker,
  DataClassification,
  ForgeProvenance,
  ForgeStore,
  GovernanceController,
  Result,
  SigningBackend,
  TrustTier,
  TrustTransitionCaller,
} from "@koi/core";
import type { ForgeConfig, MutationPressureConfig } from "./config.js";
import type { ForgeError } from "./errors.js";
import type {
  ForgeContext,
  ForgeInput,
  ForgeScope,
  ForgeVerifier,
  GovernanceResult,
  PromoteChange,
  SandboxExecutor,
  VerificationReport,
} from "./types.js";

// ---------------------------------------------------------------------------
// Pipeline interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over cross-package forge operations.
 *
 * Each method corresponds to a capability owned by a different L2 sub-package:
 * - verify → @koi/forge-verifier
 * - checkGovernance, checkMutationPressure, checkScopePromotion, validateTrustTransition → @koi/forge-policy
 * - createProvenance, signAttestation, extractBrickContent → @koi/forge-integrity
 */
export interface ForgePipeline {
  /** Run the 4-stage verification pipeline. */
  readonly verify: (
    input: ForgeInput,
    context: ForgeContext,
    executor: SandboxExecutor,
    verifiers: readonly ForgeVerifier[],
    config: ForgeConfig,
  ) => Promise<Result<VerificationReport, ForgeError>>;

  /** Check governance policies (depth, budget, tool filtering). */
  readonly checkGovernance: (
    context: ForgeContext,
    config: ForgeConfig,
    toolName?: string | undefined,
    controller?: GovernanceController | undefined,
  ) => Result<void, ForgeError> | Promise<Result<void, ForgeError>>;

  /** Check mutation pressure for capability space governance. */
  readonly checkMutationPressure: (
    tags: readonly string[],
    store: ForgeStore,
    config: MutationPressureConfig,
    now: number,
  ) => Promise<Result<unknown, ForgeError>>;

  /** Build provenance from pipeline outputs. */
  readonly createProvenance: (options: CreateProvenanceOptions) => ForgeProvenance;

  /** Sign attestation with a signing backend. */
  readonly signAttestation: (
    provenance: ForgeProvenance,
    signer: SigningBackend,
  ) => Promise<ForgeProvenance>;

  /** Extract hashable content from a brick artifact (or provenance-less builder output). */
  readonly extractBrickContent: (brick: BrickContentInput) => {
    readonly kind: string;
    readonly content: string;
  };

  /** Check scope promotion governance. */
  readonly checkScopePromotion: (
    currentScope: ForgeScope,
    targetScope: ForgeScope,
    trustTier: TrustTier,
    config: ForgeConfig,
  ) => Result<GovernanceResult, ForgeError>;

  /** Validate trust tier transitions. */
  readonly validateTrustTransition: (
    current: TrustTier,
    target: TrustTier,
    caller: TrustTransitionCaller,
  ) => Result<PromoteChange<TrustTier> | undefined, ForgeError>;
}

// ---------------------------------------------------------------------------
// BrickContentInput (narrow shape for extractBrickContent)
// ---------------------------------------------------------------------------

/**
 * Minimal shape for brick content extraction — works for full BrickArtifact
 * and provenance-less builder output. Matches the actual function signature
 * in @koi/forge-integrity.
 */
export interface BrickContentInput {
  readonly kind: BrickKind;
  readonly implementation?: string;
  readonly content?: string;
  readonly manifestYaml?: string;
  readonly steps?: readonly { readonly brickId: string }[];
}

// ---------------------------------------------------------------------------
// CreateProvenanceOptions (needed by pipeline.createProvenance)
// ---------------------------------------------------------------------------

/**
 * Options for creating forge provenance. Defined here to avoid
 * circular dependency with attestation module.
 */
export interface CreateProvenanceOptions {
  readonly input: ForgeInput;
  readonly context: ForgeContext;
  readonly report: VerificationReport;
  readonly config: ForgeConfig;
  readonly contentHash: string;
  readonly invocationId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly classification?: DataClassification;
  readonly contentMarkers?: readonly ContentMarker[];
}
