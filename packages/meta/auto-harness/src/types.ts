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
import type { PolicyCacheHandle, PolicyEntry } from "@koi/middleware-policy-cache";

export const DEFAULT_MAX_SYNTHESES_PER_SESSION = 3;

export type AutoHarnessStage =
  | "generate"
  | "verify"
  | "evaluate-policy"
  | "request-deployment-approval"
  | "deploy"
  | "register-policy";

export interface AutoHarnessError {
  readonly stage: AutoHarnessStage;
  readonly message: string;
  readonly cause?: unknown;
  readonly koiError?: KoiError;
}

export interface AutoHarnessVerificationResult {
  readonly ok: boolean;
  readonly artifact: BrickArtifact | null;
  readonly reason?: string;
  readonly error?: AutoHarnessError;
}

export interface AutoHarnessPolicyResult {
  readonly ok: boolean;
  readonly action: "allow" | "block";
  readonly reason?: string;
  readonly error?: AutoHarnessError;
}

export interface AutoHarnessDeployResult {
  readonly ok: boolean;
  readonly artifact?: BrickArtifact;
  /**
   * Verified policy entry to register with the attached `policy-cache`
   * middleware after a successful deployment. When omitted the deployed
   * artifact is invisible to short-circuit lookups; supply it whenever the
   * deploy step has access to the verified policy executor.
   */
  readonly policyEntry?: PolicyEntry;
  readonly error?: AutoHarnessError;
}

export type AutoHarnessEvent =
  | {
      readonly kind: "synthesis.started";
      readonly signalId: string;
    }
  | {
      readonly kind: "synthesis.skipped";
      readonly signalId: string;
      readonly message: string;
    }
  | {
      readonly kind: "verification.failed";
      readonly signalId: string;
      readonly message: string;
    }
  | {
      readonly kind: "policy.blocked";
      readonly signalId: string;
      readonly artifactId: string;
      readonly message: string;
    }
  | {
      readonly kind: "approval.denied";
      readonly signalId: string;
      readonly artifactId: string;
      readonly message: string;
    }
  | {
      readonly kind: "deployment.succeeded";
      readonly signalId: string;
      readonly artifactId: string;
    }
  | {
      readonly kind: "session.reset";
      readonly message: string;
    };

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

/**
 * Per-session execution context threaded through `synthesizeHarness`. When
 * supplied, the auto-harness budget and in-flight dedupe partition by
 * `sessionId` so one tenant's repeated failures cannot exhaust another
 * tenant's per-session budget. `dismiss` is invoked after any terminal
 * outcome (success, policy block, approval denial, deploy error, etc.)
 * so forge-demand state does not accumulate processed signals.
 */
export interface AutoHarnessSessionContext {
  readonly sessionId: string;
  /**
   * Owning agent identity for the session that produced the demand signal.
   * When supplied, the pipeline rejects any policyEntry whose `agentId`
   * does not exactly match — otherwise a buggy or compromised
   * `deployCandidate` could register an agent-scoped cache entry against
   * an unrelated agent, silently changing enforcement for a tenant that
   * never authorized the synthesis (R5 round 19 finding).
   */
  readonly ownerAgentId?: string | undefined;
  readonly dismiss?: (() => void) | undefined;
}

export type AutoHarnessSynthesizeHarness = (
  signal: ForgeDemandSignal,
  session?: AutoHarnessSessionContext,
) => Promise<AutoHarnessSynthesisResult>;

export interface AutoHarnessConfig {
  readonly forgeStore: ForgeStore;
  readonly notifier?: StoreChangeNotifier | undefined;
  /**
   * Trust predicate threaded into the embedded `policy-cache` middleware.
   * `register()` is fail-closed: hosts that wire auto-harness without a
   * verifier cannot promote any deployed policy entry into the cache. Wire
   * this to forge's verified-set lookup so only forge-verified bricks
   * short-circuit tool dispatch. Sync-only — keeps `register()` synchronous.
   */
  readonly policyVerifier?: ((entry: PolicyEntry) => boolean) | undefined;
  readonly generate: AutoHarnessGenerate;
  readonly verifyCandidate: AutoHarnessVerifyCandidate;
  readonly evaluatePolicy: AutoHarnessEvaluatePolicy;
  readonly requestDeploymentApproval: AutoHarnessRequestDeploymentApproval;
  readonly deployCandidate: AutoHarnessDeployCandidate;
  readonly maxSynthesesPerSession?: number;
  readonly onEvent?: ((event: AutoHarnessEvent) => void) | undefined;
  readonly onError?: ((error: AutoHarnessError) => void) | undefined;
}

export interface AutoHarnessStack {
  readonly policyCacheMiddleware: KoiMiddleware;
  readonly policyCacheHandle: PolicyCacheHandle;
  readonly synthesizeHarness: AutoHarnessSynthesizeHarness;
  /**
   * Reset the synthesis budget and clear in-flight dedupe state. When called
   * with a `sessionId`, only that session's state is cleared; otherwise every
   * tracked session (and the legacy global counter) is reset.
   */
  readonly resetSession: (sessionId?: string) => void;
  readonly maxSynthesesPerSession: number;
}
