/**
 * Core types for preference drift detection and salience gating.
 */

import type { TurnContext } from "@koi/core/middleware";

// ---------------------------------------------------------------------------
// Drift Detection
// ---------------------------------------------------------------------------

export type PreferenceDriftSignal =
  | { readonly kind: "no_drift" }
  | {
      readonly kind: "drift_detected";
      readonly oldPreference?: string | undefined;
      readonly newPreference: string;
    };

export interface PreferenceDriftDetector {
  readonly detect: (
    feedback: string,
    ctx: TurnContext,
  ) => PreferenceDriftSignal | Promise<PreferenceDriftSignal>;
}

// ---------------------------------------------------------------------------
// Salience Gate
// ---------------------------------------------------------------------------

export interface SalienceGate {
  readonly isSalient: (content: string, category: string | undefined) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// LLM Classifier
// ---------------------------------------------------------------------------

export type LlmClassifier = (prompt: string) => Promise<string>;
