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

export type AutoHarnessGenerate = (prompt: string) => Promise<string>;

export interface AutoHarnessRefinementFailure {
  readonly toolName: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type AutoHarnessStage =
  | "generate"
  | "verify"
  | "evaluate-policy"
  | "request-deployment-approval"
  | "deploy";

export interface AutoHarnessStageError {
  readonly stage: AutoHarnessStage;
  readonly message: string;
  readonly cause?: unknown;
  readonly koiError?: KoiError;
}

export type AutoHarnessVerifyCandidate = (candidateSource: string) => Promise<
  | {
      readonly ok: true;
      readonly artifact: BrickArtifact | null;
    }
  | {
      readonly ok: false;
      readonly error: AutoHarnessStageError;
    }
>;

export type AutoHarnessEvaluatePolicy = (artifact: BrickArtifact) => Promise<
  | {
      readonly ok: true;
      readonly action: "allow" | "deny" | "review";
      readonly reason?: string;
    }
  | {
      readonly ok: false;
      readonly error: AutoHarnessStageError;
    }
>;

export type AutoHarnessRequestDeploymentApproval = (artifact: BrickArtifact) => Promise<boolean>;

export type AutoHarnessDeployCandidate = (artifact: BrickArtifact) => Promise<
  | {
      readonly ok: true;
      readonly artifact?: BrickArtifact;
    }
  | {
      readonly ok: false;
      readonly error: AutoHarnessStageError;
    }
>;

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
  readonly maxSynthesesPerSession?: number;
}

export interface AutoHarnessStack {
  readonly policyCacheMiddleware: KoiMiddleware;
  readonly policyCacheHandle: PolicyCacheHandle;
  readonly synthesizeHarness: AutoHarnessSynthesizeHarness;
  readonly resetSession: () => void;
  readonly maxSynthesesPerSession: number;
}
