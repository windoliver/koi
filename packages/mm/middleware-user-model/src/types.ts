/**
 * Internal configuration types for @koi/middleware-user-model.
 */

import type { MemoryComponent } from "@koi/core/ecs";
import type { SignalSource } from "@koi/core/user-model";
import type { AmbiguityClassifier } from "./ambiguity-classifier.js";
import type { CorrectionDetector } from "./correction-detector.js";
import type { PreferenceDriftDetector } from "./keyword-drift.js";
import type { LlmClassifier, SalienceGate } from "./llm-salience.js";

// ---------------------------------------------------------------------------
// User-facing config
// ---------------------------------------------------------------------------

export interface UserModelConfig {
  readonly memory: MemoryComponent;
  /** Pre-action channel: ambiguity detection + clarification. */
  readonly preAction?:
    | {
        readonly enabled?: boolean | undefined;
        readonly classifier?: AmbiguityClassifier | undefined;
      }
    | undefined;
  /** Post-action channel: correction detection + preference storage. */
  readonly postAction?:
    | { readonly enabled?: boolean | undefined; readonly detector?: CorrectionDetector | undefined }
    | undefined;
  /** Drift detection channel. */
  readonly drift?:
    | {
        readonly enabled?: boolean | undefined;
        readonly detector?: PreferenceDriftDetector | undefined;
        readonly classify?: LlmClassifier | undefined;
      }
    | undefined;
  /** External signal sources (sensors, IDE, etc.). */
  readonly signalSources?: readonly SignalSource[] | undefined;
  /** Per-source read timeout in ms. Default: 200. */
  readonly signalTimeoutMs?: number | undefined;
  /** Max tokens for preference injection. Default: 400. */
  readonly maxPreferenceTokens?: number | undefined;
  /** Max tokens for sensor state injection. Default: 100. */
  readonly maxSensorTokens?: number | undefined;
  /** Max tokens for meta (ambiguity/question) injection. Default: 100. */
  readonly maxMetaTokens?: number | undefined;
  /** Minimum relevance score for preference recall. Default: 0.7. */
  readonly relevanceThreshold?: number | undefined;
  /** Memory namespace for preference storage. Default: "preferences". */
  readonly preferenceNamespace?: string | undefined;
  /** Category for preference recall/store. Default: "preference". */
  readonly preferenceCategory?: string | undefined;
  /** Max recalled preferences per query. Default: 5. */
  readonly recallLimit?: number | undefined;
  /** Salience gate for filtering noise before memory storage. */
  readonly salienceGate?: SalienceGate | undefined;
  /** Custom error handler. Defaults to swallowError. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Resolved config (internal)
// ---------------------------------------------------------------------------

export interface ResolvedUserModelConfig {
  readonly memory: MemoryComponent;
  readonly preAction: { readonly enabled: boolean; readonly classifier: AmbiguityClassifier };
  readonly postAction: { readonly enabled: boolean; readonly detector: CorrectionDetector };
  readonly drift: {
    readonly enabled: boolean;
    readonly detector: PreferenceDriftDetector;
  };
  readonly signalSources: readonly SignalSource[];
  readonly signalTimeoutMs: number;
  readonly maxPreferenceTokens: number;
  readonly maxSensorTokens: number;
  readonly maxMetaTokens: number;
  readonly relevanceThreshold: number;
  readonly preferenceNamespace: string;
  readonly preferenceCategory: string;
  readonly recallLimit: number;
  readonly salienceGate?: SalienceGate | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}
