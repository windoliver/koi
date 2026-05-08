/**
 * Public types for `@koi/auto-harness`.
 */

import type { ForgeStore, KoiMiddleware, StoreChangeNotifier } from "@koi/core";

export const DEFAULT_MAX_SYNTHESES_PER_SESSION = 3;

export type AutoHarnessGenerate = (prompt: string) => Promise<string>;

export type AutoHarnessVerifyCandidate = (candidateSource: string) => Promise<
  | {
      readonly ok: true;
      readonly artifact: unknown;
    }
  | {
      readonly ok: false;
      readonly error?: unknown;
    }
>;

export type AutoHarnessEvaluatePolicy = (artifact: unknown) => Promise<
  | {
      readonly ok: true;
      readonly action: string;
    }
  | {
      readonly ok: false;
      readonly error?: unknown;
    }
>;

export type AutoHarnessRequestDeploymentApproval = (artifact: unknown) => Promise<boolean>;

export type AutoHarnessDeployCandidate = (artifact: unknown) => Promise<
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly error?: unknown;
    }
>;

export type AutoHarnessSynthesisResult = unknown | null;

export type AutoHarnessSynthesizeHarness = () => Promise<AutoHarnessSynthesisResult>;

export interface AutoHarnessConfig {
  readonly forgeStore: ForgeStore;
  readonly notifier: StoreChangeNotifier;
  readonly generate: AutoHarnessGenerate;
  readonly verifyCandidate: AutoHarnessVerifyCandidate;
  readonly evaluatePolicy: AutoHarnessEvaluatePolicy;
  readonly requestDeploymentApproval: AutoHarnessRequestDeploymentApproval;
  readonly deployCandidate: AutoHarnessDeployCandidate;
  readonly maxSynthesesPerSession?: number;
}

export interface AutoHarnessPolicyCacheHandle {
  readonly middleware: KoiMiddleware;
}

export interface AutoHarnessStack {
  readonly policyCacheMiddleware: KoiMiddleware;
  readonly policyCacheHandle: AutoHarnessPolicyCacheHandle;
  readonly synthesizeHarness: AutoHarnessSynthesizeHarness;
  readonly resetSession: () => void;
  readonly maxSynthesesPerSession: number;
}
