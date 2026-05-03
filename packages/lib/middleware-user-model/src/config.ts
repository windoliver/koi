/**
 * Configuration validation + default resolution for the user-model middleware.
 *
 * Validation is intentionally minimal — the middleware tolerates a wide range
 * of configurations and degrades gracefully when channels are absent.
 */

import { swallowError } from "@koi/errors";
import {
  DEFAULT_MAX_META_TOKENS,
  DEFAULT_MAX_PREFERENCE_TOKENS,
  DEFAULT_MAX_SENSOR_TOKENS,
  DEFAULT_PERSISTENCE_TIMEOUT_MS,
  DEFAULT_PREFERENCE_CATEGORY,
  DEFAULT_PREFERENCE_NAMESPACE,
  DEFAULT_PRIORITY,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_SIGNAL_TIMEOUT_MS,
  type ResolvedUserModelConfig,
  type UserModelConfig,
} from "./types.js";

export function validateUserModelConfig(config: UserModelConfig): void {
  if (config.memory === undefined || config.memory === null) {
    throw new Error("UserModelConfig.memory is required");
  }
  if (config.signalTimeoutMs !== undefined && config.signalTimeoutMs <= 0) {
    throw new Error("UserModelConfig.signalTimeoutMs must be > 0");
  }
  if (config.relevanceThreshold !== undefined) {
    const t = config.relevanceThreshold;
    if (t < 0 || t > 1) {
      throw new Error("UserModelConfig.relevanceThreshold must be in [0, 1]");
    }
  }
  if (config.recallLimit !== undefined && config.recallLimit <= 0) {
    throw new Error("UserModelConfig.recallLimit must be > 0");
  }
  // Reject duplicate signal source names. sensorState is keyed by
  // SignalSource.name; two sources sharing a name would silently
  // overwrite each other's readings (review round 16, finding 3).
  if (config.signalSources !== undefined) {
    const names = new Set<string>();
    for (const src of config.signalSources) {
      if (names.has(src.name)) {
        throw new Error(
          `UserModelConfig.signalSources contains duplicate name "${src.name}" — each source must have a unique identity`,
        );
      }
      names.add(src.name);
    }
  }
  // Fail closed when no subject-scoping mechanism is configured: preference
  // memory must not silently leak across users/tenants. Either a static
  // `subjectId`, a per-session `resolveSubjectId`, or an explicit
  // `allowSharedScope: true` opt-in is required (review round 11/12).
  const hasSubject = typeof config.subjectId === "string" && config.subjectId.length > 0;
  const hasResolver = typeof config.resolveSubjectId === "function";
  if (!hasSubject && !hasResolver && config.allowSharedScope !== true) {
    throw new Error(
      "UserModelConfig requires one of: subjectId (static), resolveSubjectId (per-session), or allowSharedScope: true (single-user opt-in). Preference memory cannot be shared across subjects implicitly.",
    );
  }
}

/**
 * Combine the configured base namespace with a per-subject suffix so the
 * memory backend's namespace key uniquely identifies the (caller, subject)
 * pair. Without a subjectId (caller opted in via `allowSharedScope`) the
 * namespace is left untouched.
 *
 * Subject IDs are percent-encoded for `%` and `:` before composition so
 * two distinct subjects cannot collide by construction (review round 16,
 * finding 2). E.g., `tenant:x` and a literal `tenant%3Ax` would otherwise
 * produce the same composed namespace; encoding makes the boundary
 * unambiguous and round-trippable.
 */
export function scopeNamespaceForSubject(base: string, subjectId: string | undefined): string {
  if (subjectId === undefined || subjectId.length === 0) return base;
  const encoded = subjectId.replaceAll("%", "%25").replaceAll(":", "%3A");
  return `${base}:${encoded}`;
}

export function resolveUserModelDefaults(config: UserModelConfig): ResolvedUserModelConfig {
  validateUserModelConfig(config);
  const onError =
    config.onError ??
    ((error: unknown): void =>
      swallowError(error, { package: "@koi/middleware-user-model", operation: "user-model" }));
  return {
    memory: config.memory,
    preActionEnabled: config.preAction?.enabled ?? true,
    postActionEnabled: config.postAction?.enabled ?? true,
    driftEnabled: config.drift?.enabled ?? false,
    driftDetector: config.drift?.detector,
    driftClassify: config.drift?.classify,
    signalSources: config.signalSources ?? [],
    signalTimeoutMs: config.signalTimeoutMs ?? DEFAULT_SIGNAL_TIMEOUT_MS,
    maxPreferenceTokens: config.maxPreferenceTokens ?? DEFAULT_MAX_PREFERENCE_TOKENS,
    maxSensorTokens: config.maxSensorTokens ?? DEFAULT_MAX_SENSOR_TOKENS,
    maxMetaTokens: config.maxMetaTokens ?? DEFAULT_MAX_META_TOKENS,
    relevanceThreshold: config.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD,
    // Store the BASE namespace; per-session subject scoping is applied at
    // store/recall time via `scopeNamespaceForSubject`. Capturing only the
    // base here lets one middleware instance serve many sessions, each with
    // its own resolved subject (review round 12, finding 3).
    preferenceNamespace: config.preferenceNamespace ?? DEFAULT_PREFERENCE_NAMESPACE,
    preferenceCategory: config.preferenceCategory ?? DEFAULT_PREFERENCE_CATEGORY,
    recallLimit: config.recallLimit ?? DEFAULT_RECALL_LIMIT,
    subjectId: config.subjectId,
    resolveSubjectId: config.resolveSubjectId,
    allowSharedScope: config.allowSharedScope ?? false,
    salienceGate: config.salienceGate,
    onError,
    priority: config.priority ?? DEFAULT_PRIORITY,
    persistenceTimeoutMs: config.persistenceTimeoutMs ?? DEFAULT_PERSISTENCE_TIMEOUT_MS,
  };
}
