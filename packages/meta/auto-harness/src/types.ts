/**
 * Public types for `@koi/auto-harness`.
 */

import type {
  BrickArtifact,
  ForgeDemandSignal,
  ForgeStore,
  KoiError,
  KoiMiddleware,
  StoreChangeNotifier,
} from "@koi/core";
import type { PolicyCacheHandle } from "@koi/middleware-policy-cache";

export const DEFAULT_MAX_SYNTHESES_PER_SESSION = 3;

export type AutoHarnessStage =
  | "generate"
  | "verify"
  | "evaluate-policy"
  | "request-deployment-approval"
  | "deploy";

export interface AutoHarnessError {
  readonly stage: AutoHarnessStage;
  readonly message: string;
  readonly cause?: unknown;
  readonly koiError?: KoiError;
}

export interface AutoHarnessVerificationResult {
  readonly ok: boolean;
  readonly artifact: BrickArtifact | null;
  readonly error?: AutoHarnessError;
}

export interface AutoHarnessPolicyResult {
  readonly ok: boolean;
  readonly action: "allow" | "deny" | "review";
  readonly reason?: string;
  readonly error?: AutoHarnessError;
}

export interface AutoHarnessDeployResult {
  readonly ok: boolean;
  readonly artifact?: BrickArtifact;
  readonly error?: AutoHarnessError;
}

export interface AutoHarnessEvent {
  readonly type:
    | "synthesis-started"
    | "synthesis-skipped"
    | "verification-completed"
    | "policy-evaluated"
    | "deployment-requested"
    | "deployment-completed"
    | "session-reset";
  readonly signal?: ForgeDemandSignal;
  readonly artifact?: BrickArtifact | null;
  readonly stage?: AutoHarnessStage;
  readonly message?: string;
}

export type AutoHarnessGenerate = (prompt: string) => Promise<string>;

export type AutoHarnessVerifyCandidate = (
  signal: ForgeDemandSignal,
  code: string,
) => Promise<AutoHarnessVerificationResult>;

export type AutoHarnessEvaluatePolicy = (
  artifact: BrickArtifact,
  signal: ForgeDemandSignal,
) => Promise<AutoHarnessPolicyResult>;

export type AutoHarnessRequestDeploymentApproval = (
  artifact: BrickArtifact,
  signal: ForgeDemandSignal,
) => Promise<boolean>;

export type AutoHarnessDeployCandidate = (
  artifact: BrickArtifact,
  signal: ForgeDemandSignal,
) => Promise<AutoHarnessDeployResult>;

export type AutoHarnessSynthesisResult = BrickArtifact | null;

export type AutoHarnessSynthesizeHarness = (
  signal: ForgeDemandSignal,
) => Promise<AutoHarnessSynthesisResult>;

export interface AutoHarnessConfig {
  readonly forgeStore: ForgeStore;
  readonly notifier?: StoreChangeNotifier | undefined;
  readonly generate: AutoHarnessGenerate;
  readonly verifyCandidate: AutoHarnessVerifyCandidate;
  readonly evaluatePolicy: AutoHarnessEvaluatePolicy;
  readonly requestDeploymentApproval: AutoHarnessRequestDeploymentApproval;
  readonly deployCandidate: AutoHarnessDeployCandidate;
  readonly maxIterations?: number;
  readonly maxSynthesesPerSession?: number;
  readonly enableRefinement?: boolean;
  readonly onEvent?: ((event: AutoHarnessEvent) => void) | undefined;
  readonly onError?: ((error: AutoHarnessError) => void) | undefined;
}

export interface AutoHarnessStack {
  readonly policyCacheMiddleware: KoiMiddleware;
  readonly policyCacheHandle: PolicyCacheHandle;
  readonly synthesizeHarness: AutoHarnessSynthesizeHarness;
  readonly resetSession: () => void;
  readonly maxSynthesesPerSession: number;
}
