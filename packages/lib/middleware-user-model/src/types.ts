/**
 * Public configuration types for @koi/middleware-user-model.
 *
 * The middleware fuses three channels into one `[User Context]` block:
 *   - pre_action  — ambiguity detection + clarifying question (heuristic)
 *   - post_action — explicit correction detection (heuristic)
 *   - sensor      — pluggable SignalSource readers (IDE, environment, etc.)
 *
 * Drift detection is an optional sub-channel of post_action that flows
 * through the same SignalSink. Token budgets, relevance threshold, and
 * memory namespace are all caller-tunable with sane defaults.
 */

import type { MemoryComponent, SessionContext, SignalSource } from "@koi/core";

/** LLM classifier hook — used by drift/salience helpers when an LLM is available. */
export type LlmClassifier = (prompt: string) => Promise<string>;

/** Result of drift detection on a single user message. */
export interface DriftDecision {
  readonly drifted: boolean;
  readonly oldValue?: string | undefined;
  readonly newValue?: string | undefined;
}

/** Pluggable preference-drift detector. Implementations may be heuristic or LLM-backed. */
export interface PreferenceDriftDetector {
  readonly detect: (
    text: string,
    existingPreferences: readonly string[],
  ) => DriftDecision | Promise<DriftDecision>;
}

/** Pluggable salience gate — decides whether a candidate signal is worth storing. */
export interface SalienceGate {
  readonly isSalient: (text: string) => boolean | Promise<boolean>;
}

export interface UserModelConfig {
  readonly memory: MemoryComponent;

  // Channels
  readonly preAction?: { readonly enabled?: boolean } | undefined;
  readonly postAction?: { readonly enabled?: boolean } | undefined;
  readonly drift?:
    | {
        readonly enabled?: boolean;
        readonly detector?: PreferenceDriftDetector;
        readonly classify?: LlmClassifier;
      }
    | undefined;

  // Signal sources
  readonly signalSources?: readonly SignalSource[] | undefined;
  readonly signalTimeoutMs?: number | undefined;

  // Token budgets
  readonly maxPreferenceTokens?: number | undefined;
  readonly maxSensorTokens?: number | undefined;
  readonly maxMetaTokens?: number | undefined;

  // Memory
  readonly relevanceThreshold?: number | undefined;
  readonly preferenceNamespace?: string | undefined;
  readonly preferenceCategory?: string | undefined;
  readonly recallLimit?: number | undefined;

  /**
   * Static per-subject scope key — appended to `preferenceNamespace` for
   * every store/recall in this middleware instance. Suitable when one
   * middleware instance serves exactly one subject (e.g., per-process
   * agents). Multi-tenant runtimes should prefer `resolveSubjectId`
   * (per-session) instead so a single middleware instance can serve many
   * sessions safely (review round 12, finding 3).
   */
  readonly subjectId?: string | undefined;

  /**
   * Per-session subject resolver — called once during `onSessionStart`
   * with the live `SessionContext` so multi-tenant runtimes can derive
   * `subjectId` from `session.userId`, `session.metadata.tenant`, etc.
   * Result is captured for the session's lifetime; if it returns
   * `undefined` and no static `subjectId` is set, the middleware refuses
   * to operate for that session (fails closed). When both `subjectId`
   * and `resolveSubjectId` are configured, the per-session resolver wins.
   */
  readonly resolveSubjectId?: ((session: SessionContext) => string | undefined) | undefined;

  /**
   * Opt-in escape hatch for trusted single-user contexts (CLI, local agent)
   * where preference recall across sessions is intentional. Setting this to
   * `true` lets `subjectId` remain unset.
   */
  readonly allowSharedScope?: boolean | undefined;

  // Salience gate
  readonly salienceGate?: SalienceGate | undefined;

  // Error handling
  readonly onError?: ((error: unknown) => void) | undefined;

  // Priority override (default 415)
  readonly priority?: number | undefined;

  /**
   * Bounded timeout for `memory.store()` calls on the turn path.
   * Stores beyond this deadline are abandoned (logged via onError) so a
   * slow backend never blocks the model call. The next turn awaits any
   * still-pending stores up to this same deadline before calling recall,
   * to keep persisted preferences observable in subsequent turns.
   */
  readonly persistenceTimeoutMs?: number | undefined;
}

export interface ResolvedUserModelConfig {
  readonly memory: MemoryComponent;
  readonly preActionEnabled: boolean;
  readonly postActionEnabled: boolean;
  readonly driftEnabled: boolean;
  readonly driftDetector: PreferenceDriftDetector | undefined;
  readonly driftClassify: LlmClassifier | undefined;
  readonly signalSources: readonly SignalSource[];
  readonly signalTimeoutMs: number;
  readonly maxPreferenceTokens: number;
  readonly maxSensorTokens: number;
  readonly maxMetaTokens: number;
  readonly relevanceThreshold: number;
  /** Base namespace WITHOUT any per-subject suffix — store/recall sites apply the suffix per session. */
  readonly preferenceNamespace: string;
  readonly preferenceCategory: string;
  readonly recallLimit: number;
  readonly subjectId: string | undefined;
  readonly resolveSubjectId: ((session: SessionContext) => string | undefined) | undefined;
  readonly allowSharedScope: boolean;
  readonly salienceGate: SalienceGate | undefined;
  readonly onError: (error: unknown) => void;
  readonly priority: number;
  readonly persistenceTimeoutMs: number;
}

export const DEFAULT_PRIORITY = 415;
export const DEFAULT_SIGNAL_TIMEOUT_MS = 200;
export const DEFAULT_MAX_PREFERENCE_TOKENS = 400;
export const DEFAULT_MAX_SENSOR_TOKENS = 100;
export const DEFAULT_MAX_META_TOKENS = 100;
export const DEFAULT_RELEVANCE_THRESHOLD = 0.7;
export const DEFAULT_PREFERENCE_NAMESPACE = "preferences";
export const DEFAULT_PREFERENCE_CATEGORY = "preference";
export const DEFAULT_RECALL_LIMIT = 5;
export const DEFAULT_PERSISTENCE_TIMEOUT_MS = 200;
