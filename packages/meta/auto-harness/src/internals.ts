import type { ForgeDemandSignal } from "@koi/core";
import { DEFAULT_MAX_SYNTHESES_PER_SESSION } from "./types.js";

/**
 * Sentinel used to bucket calls that arrive without a session context.
 * Multi-session runtimes wire `synthesizeHarness(signal, { sessionId, ... })`
 * via the runtime's onSessionAttached path; out-of-band callers and stub
 * adapters fall back to this single shared bucket.
 */
export const GLOBAL_SESSION_BUCKET = "__global__";

/**
 * Strip secrets-shaped tokens out of failure evidence before forwarding to
 * the model. Forge-demand records raw `extractMessage(e)` output from
 * failing tools, which can contain credentials, tenant identifiers, or
 * internal paths. We redact common secret shapes; callers that need richer
 * sanitization should pre-process their failure logs.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:authorization|x-api-key)\b\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._\-+/=]+/gi,
  /\b(?:password|passwd|secret|token|apikey|api[_-]?key|bearer|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["']?[^\s"',}]+["']?/gi,
  /\b[A-Za-z0-9]{28,}\b/g,
  /\b[A-Za-z0-9_+/-]{40,}={0,2}\b/g,
  /\/(?:Users|home)\/[^/\s"',)}]+/g,
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.(?:local|internal|svc|cluster\.local)\b/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b(?:tenant(?:[_-]?id)?|org(?:[_-]?id)?|account(?:[_-]?id)?|customer(?:[_-]?id)?|x-tenant(?:-id)?)\b\s*[:=]\s*["']?[^\s"',}]+["']?/gi,
];

export function sanitizeFailureEvidence(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function formatGeneratePrompt(signal: ForgeDemandSignal): string {
  const failed =
    signal.context.failedToolCalls.length > 0
      ? sanitizeFailureEvidence(signal.context.failedToolCalls.join(", "))
      : "(none)";
  const task =
    signal.context.taskDescription !== undefined
      ? sanitizeFailureEvidence(signal.context.taskDescription)
      : "(unspecified)";
  return [
    `Generate a koi middleware harness for brick kind ${signal.suggestedBrickKind}.`,
    `Trigger: ${signal.trigger.kind} (signal ${signal.id}, confidence ${signal.confidence.toFixed(2)}).`,
    `Failed tool calls: ${failed}.`,
    `Failure count this session: ${signal.context.failureCount}.`,
    `Task: ${task}.`,
    "Export `createMiddleware()` returning a KoiMiddleware that addresses the failure mode above.",
  ].join("\n");
}

/**
 * Stable, low-cardinality fingerprint of failure evidence — narrow enough
 * to distinguish materially different failure modes (timeout vs malformed
 * input vs auth) but coarse enough to coalesce true duplicates of the same
 * symptom. Sanitized first so secrets never enter the dedupe key.
 */
function failureFingerprint(failedToolCalls: readonly string[]): string {
  if (failedToolCalls.length === 0) return "none";
  const sample = sanitizeFailureEvidence(failedToolCalls.slice(0, 3).join("|"));
  // FNV-1a 32-bit hash — small, fast, no crypto dep.
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < sample.length; i++) {
    h ^= sample.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16);
}

/**
 * Stable identity derived from the demand signal trigger contents — keeps
 * cooldown re-fires and concurrent emissions for the same root cause from
 * spawning duplicate pipelines. The detector mints a fresh `signal.id` per
 * emission, so id-based dedup is insufficient.
 */
export function triggerIdentity(signal: ForgeDemandSignal): string {
  const t = signal.trigger;
  if (t === undefined || t === null || typeof t.kind !== "string") {
    return `unknown:${signal.id}`;
  }
  switch (t.kind) {
    case "repeated_failure":
      return `repeated_failure:${t.toolName}:${failureFingerprint(signal.context?.failedToolCalls ?? [])}`;
    case "no_matching_tool":
      return `no_matching_tool:${t.query}`;
    case "capability_gap":
      return `capability_gap:${t.requiredCapability}`;
    case "performance_degradation":
      return `performance_degradation:${t.toolName}:${t.metric}`;
    case "agent_capability_gap":
      return `agent_capability_gap:${t.agentType}`;
    case "agent_repeated_failure":
      // Include brickId so distinct failing bricks for the same agentType
      // do not share a dedupe bucket — otherwise later failures from another
      // brick are silently suppressed as "already handled" (R5 round 19).
      return `agent_repeated_failure:${t.agentType}:${t.brickId}`;
    default: {
      const exhaustive: Record<string, string> = t as never;
      return `unknown:${JSON.stringify(exhaustive)}`;
    }
  }
}

export function resolveMaxSynthesesPerSession(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SYNTHESES_PER_SESSION;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `@koi/auto-harness: maxSynthesesPerSession must be a positive integer (got ${String(value)})`,
    );
  }
  return value;
}

/**
 * Per-session bookkeeping. Keying on sessionId prevents one tenant's
 * repeated failures from exhausting another tenant's budget or holding
 * the in-flight slot for an identical trigger. `completedTriggers` is
 * the persistent post-completion gate — cleared on `resetSession(id)`
 * or when a forge-store change event indicates an artifact was
 * updated/removed/quarantined (R5 round 18).
 */
export interface SessionState {
  count: number;
  inFlightTriggers: Set<string>;
  completedTriggers: Set<string>;
}

export function createSessionStateMap(): Map<string, SessionState> {
  return new Map();
}

export function getOrCreateSessionState(map: Map<string, SessionState>, id: string): SessionState {
  let s = map.get(id);
  if (s === undefined) {
    s = { count: 0, inFlightTriggers: new Set(), completedTriggers: new Set() };
    map.set(id, s);
  }
  return s;
}
